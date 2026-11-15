import {
  type ConfigDocumentView,
  type ConfigEntryView,
  type ConfigValue,
  DEFAULT_LABEL,
  unflattenObject,
} from '@adonis-agora/config-core';
import { resolveTenantToken, type TenantToken, type TenantTokenSource } from './token.js';

export interface ConfigClientOptions {
  /** The control plane, including its prefix (`https://config.example.com/_config`). */
  url: string;
  /** The app (partition). */
  partition: string;
  /** Default `production`. */
  environment?: string;
  /** Default `main`. */
  label?: string;
  /** A shared secret, a function (`authkitTenantToken(...)`), or an object with `get()`. */
  token: TenantTokenSource;
  fetch?: typeof fetch;
}

export interface ConfigClientStatus {
  app: string;
  environment: string;
  label: string;
  version: number;
  fingerprint: string;
  loadedAt: Date | null;
  lastError: string | null;
  /** The server is unreachable and the document is the last one received. */
  stale: boolean;
  source: 'remote' | 'none';
}

export interface Whoami {
  resource: string;
  partition: string;
  environment: string;
  label: string;
  capabilities: string[];
  expiresAt?: string;
}

/**
 * A scope from the control plane, over HTTP: conditional GET by ETag, with a token from a shared
 * secret or authkit. No filesystem, no AdonisJS: usable from a script, the Sail CLI or a worker.
 *
 * ```ts
 * const client = createConfigClient({ url, partition: 'streaming', token })
 * await client.refresh()
 * client.get('db.host')
 * ```
 */
export class ConfigClient {
  readonly url: string;
  readonly partition: string;
  readonly environment: string;
  readonly label: string;
  readonly #token: TenantToken;
  readonly #fetch: typeof fetch;
  #document: ConfigDocumentView | null = null;
  #loadedAt: Date | null = null;
  #lastError: string | null = null;

  constructor(options: ConfigClientOptions) {
    if (!options.url) throw new Error('config: url is required');
    if (!options.partition) throw new Error('config: partition is required');
    this.url = options.url.replace(/\/$/, '');
    this.partition = options.partition;
    this.environment = options.environment ?? 'production';
    this.label = options.label ?? DEFAULT_LABEL;
    this.#token = resolveTenantToken(options.token);
    this.#fetch = options.fetch ?? fetch;
  }

  #headers(): Promise<Record<string, string>> {
    return this.#token.get().then((token) => ({
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-config-app': this.partition,
      'x-config-environment': this.environment,
      'x-config-label': this.label,
    }));
  }

  /** Fetches the document; throws whatever the server (or the network) said. */
  async load(): Promise<ConfigDocumentView> {
    return this.#load(false);
  }

  async #load(retried: boolean): Promise<ConfigDocumentView> {
    const headers = await this.#headers();
    if (this.#document) {
      headers['if-none-match'] =
        `"${this.partition}:${this.environment}:${this.label}:${this.#document.version}"`;
    }
    const response = await this.#fetch(`${this.url}/v1/config`, { headers });
    if (response.status === 304) {
      this.#lastError = null;
      if (this.#document) return this.#document;
      throw new Error('config: the control plane answered 304 to an unconditional request');
    }
    if (response.status === 401) {
      this.#token.reset?.();
      if (!retried) return this.#load(true);
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'config: the control plane refused the token (401)'
          : `config: the control plane answered ${response.status}`,
      );
    }
    this.#document = (await response.json()) as ConfigDocumentView;
    this.#loadedAt = new Date();
    this.#lastError = null;
    return this.#document;
  }

  /** Fetches now; returns whether the document changed. Never throws: see `status().lastError`. */
  async refresh(): Promise<boolean> {
    try {
      const before = this.#document?.fingerprint;
      await this.load();
      return this.#document?.fingerprint !== before;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** What the token is on the server (reachability + token check). Throws on a refusal. */
  async whoami(): Promise<Whoami> {
    const response = await this.#fetch(`${this.url}/v1/whoami`, { headers: await this.#headers() });
    if (response.status === 401) this.#token.reset?.();
    if (!response.ok) throw new Error(`config: whoami answered ${response.status}`);
    return (await response.json()) as Whoami;
  }

  document(): ConfigDocumentView | null {
    return this.#document;
  }

  entries(): Record<string, ConfigEntryView> {
    return { ...(this.#document?.entries ?? {}) };
  }

  /** Every usable value (a masked secret has none and is left out). */
  values(): Record<string, ConfigValue> {
    const out: Record<string, ConfigValue> = {};
    for (const [key, entry] of Object.entries(this.#document?.entries ?? {})) {
      if (entry.value !== undefined) out[key] = entry.value;
    }
    return out;
  }

  get<T = ConfigValue>(key: string, fallback?: T): ConfigValue | T | undefined {
    const value = this.#document?.entries[key]?.value;
    return value === undefined ? fallback : value;
  }

  has(key: string): boolean {
    return this.#document?.entries[key]?.value !== undefined;
  }

  nested(): Record<string, ConfigValue> {
    return unflattenObject(this.values());
  }

  status(): ConfigClientStatus {
    return {
      app: this.#document?.app ?? this.partition,
      environment: this.#document?.environment ?? this.environment,
      label: this.#document?.label ?? this.label,
      version: this.#document?.version ?? 0,
      fingerprint: this.#document?.fingerprint ?? '',
      loadedAt: this.#loadedAt,
      lastError: this.#lastError,
      stale: this.#lastError !== null && this.#document !== null,
      source: this.#document ? 'remote' : 'none',
    };
  }
}

/** A client, without fetching yet. */
export function createConfigClient(options: ConfigClientOptions): ConfigClient {
  return new ConfigClient(options);
}

/** A client that fetches once and returns the loaded document. */
export async function fetchConfig(options: ConfigClientOptions): Promise<ConfigClient> {
  const client = new ConfigClient(options);
  await client.load();
  return client;
}
