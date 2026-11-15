import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type ConfigDocumentView,
  type ConfigEntryView,
  type ConfigValue,
  coerceEnvValue,
  DEFAULT_LABEL,
  envNameOf,
  envValueOf,
  unflattenObject,
} from '@adonis-agora/config-core';
import { resolveTenantToken, type TenantToken, type TenantTokenSource } from './token.js';

/** What changed in one update, split by whether the app may apply it without a restart. */
export interface ConfigChangeSet {
  version: number;
  fingerprint: string;
  /** Keys applied to the live configuration now. */
  reloadable: string[];
  /** Keys whose new value needs a restart (the live value is NOT changed). */
  restartRequired: string[];
  added: string[];
  removed: string[];
}

export interface TenantStatus {
  app: string;
  environment: string;
  label: string;
  /** Where the current values came from. */
  source: 'remote' | 'snapshot' | 'none';
  version: number;
  fingerprint: string;
  loadedAt: Date | null;
  lastError: string | null;
  /** The server is unreachable and the values are the last ones received. */
  stale: boolean;
  streaming: boolean;
  snapshotPath?: string;
  /** `process.env` is overriding remote values for the keys it sets (`tenant.localEnv`). */
  localEnv: boolean;
}

export interface TenantClientOptions {
  /** The control plane's base URL, with its prefix (`https://config.example.com/_config`). */
  url: string;
  /** This app's name (the partition). */
  partition: string;
  token: TenantTokenSource;
  /** Default `production`. */
  environment?: string;
  /** Default `main`. */
  label?: string;
  snapshotPath?: string;
  stream?: boolean;
  intervalMs?: number;
  /** Throw when the server is unreachable AND no snapshot exists. Default `false`. */
  required?: boolean;
  /** Extra reloadable keys, exact or with a trailing `*` (`db.*`). */
  reloadable?: string[];
  /** Write the non-secret values into `process.env` (only keys that are not already set). */
  env?: boolean;
  /**
   * Let `process.env` win over the remote value of a key that is set there (`db.port` ← `DB_PORT`),
   * coerced to the remote value's type. This is what keeps a Sail worktree on its own ports: sail
   * writes them to `.env.local`, and the config server's `db.port` must not shadow them in dev.
   * The provider turns it on outside production. Default `false`.
   */
  localEnv?: boolean;
  /** Prefix for the local env names (`APP_` → `APP_DB_PORT`). Default none. */
  envPrefix?: string;
  fetch?: typeof fetch;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    debug?(message: string): void;
  };
  onError?: (error: unknown) => void;
}

const BOOTSTRAP_SYMBOL = Symbol.for('@adonis-agora/config:tenant-bootstrap');

interface BootstrapEntry {
  key: string;
  client: TenantClient;
  at: number;
}

/** The client a `bootstrapConfig()` call already built and started, for the provider to reuse. */
export function tenantBootstrapKey(options: {
  url: string;
  partition: string;
  environment?: string;
  label?: string;
}): string {
  return [
    options.url.replace(/\/$/, ''),
    options.partition,
    options.environment ?? '',
    options.label ?? DEFAULT_LABEL,
  ].join('|');
}

export function takeTenantBootstrap(key: string): TenantClient | undefined {
  const holder = globalThis as unknown as Record<symbol, BootstrapEntry | undefined>;
  const entry = holder[BOOTSTRAP_SYMBOL];
  if (!entry || entry.key !== key) return undefined;
  return entry.client;
}

export function setTenantBootstrap(key: string, client: TenantClient): void {
  (globalThis as unknown as Record<symbol, BootstrapEntry>)[BOOTSTRAP_SYMBOL] = {
    key,
    client,
    at: Date.now(),
  };
}

function matches(pattern: string, key: string): boolean {
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
}

/**
 * A tenant's configuration: fetched from the control plane (conditional GET by ETag), kept fresh by
 * an SSE stream with polling as a fallback, snapshotted to disk, and split into **boot** values and
 * **live** values. A reloadable key's new value is visible immediately; everything else keeps the
 * value the app booted with until it restarts, which the console and `status()` both report.
 */
export class TenantClient {
  readonly #token: TenantToken;
  readonly #fetch: typeof fetch;
  readonly #listeners = new Set<(change: ConfigChangeSet) => void>();
  #boot: Record<string, ConfigEntryView> | null = null;
  #live: Record<string, ConfigEntryView> = {};
  /** The last document received (or read from the snapshot), before boot/live splitting. */
  #document: ConfigDocumentView | null = null;
  #version = 0;
  #fingerprint = '';
  #loadedAt: Date | null = null;
  #lastError: string | null = null;
  #source: TenantStatus['source'] = 'none';
  #streaming = false;
  #started = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;
  #streamAbort: AbortController | undefined;
  #refreshing: Promise<boolean> | undefined;

  constructor(private readonly options: TenantClientOptions) {
    this.#token = resolveTenantToken(options.token);
    this.#fetch = options.fetch ?? fetch;
  }

  get app(): string {
    return this.options.partition;
  }

  get environment(): string {
    return this.options.environment ?? 'production';
  }

  get label(): string {
    return this.options.label ?? DEFAULT_LABEL;
  }

  /** The control plane URL this client reads (used by `config:pull`). */
  get url(): string {
    return this.options.url.replace(/\/$/, '');
  }

  get #base(): string {
    return this.options.url.replace(/\/$/, '');
  }

  #headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'x-config-app': this.app,
      'x-config-environment': this.environment,
      'x-config-label': this.label,
    };
  }

  async #authorization(): Promise<string> {
    return `Bearer ${await this.#token.get()}`;
  }

  /**
   * Loads the configuration once, from the snapshot when the control plane is unreachable. No
   * timers, no stream: `node ace` commands use this so they never start background work.
   */
  async load(): Promise<void> {
    const loaded = await this.refresh();
    if (!loaded && this.#boot === null) {
      await this.#loadSnapshot();
    }
    if (this.#boot === null) {
      if (this.options.required) {
        throw new Error(
          `config: cannot reach ${this.#base} and there is no snapshot${this.options.snapshotPath ? ` at ${this.options.snapshotPath}` : ''} (tenant.required is on)`,
        );
      }
      this.options.logger?.warn(
        `[@adonis-agora/config] cannot reach ${this.#base} and there is no snapshot: the app boots with its local configuration`,
      );
      this.#boot = {};
      this.#live = {};
    }
  }

  /** Loads the configuration and keeps it fresh (stream + polling). */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    await this.load();
    const streaming = this.options.stream !== false;
    const interval = this.options.intervalMs ?? (streaming ? 30_000 : 5_000);
    this.#timer = setInterval(() => void this.refresh(), interval);
    this.#timer.unref();
    if (streaming) void this.#openStream();
  }

  /** The values as the app may use them: reloadable keys from the latest document, the rest from boot. */
  values(): Record<string, ConfigValue> {
    const out: Record<string, ConfigValue> = {};
    const source = { ...(this.#boot ?? {}), ...this.#live };
    for (const [key, entry] of Object.entries(source)) {
      if (entry.value === undefined) continue;
      out[key] = this.#localEnvValue(key, entry.value) ?? entry.value;
    }
    return out;
  }

  /** The whole current document (reloadable and boot values alike), as nested JSON. */
  nested(): Record<string, ConfigValue> {
    return unflattenObject(this.values());
  }

  /**
   * The values of the LAST document received, before the boot/reloadable split and without local
   * env overrides. `config:pull` uses this: it wants the server's latest, not what this process
   * applied at boot.
   */
  latestValues(): Record<string, ConfigValue> {
    const out: Record<string, ConfigValue> = {};
    for (const [key, entry] of Object.entries(this.#document?.entries ?? {})) {
      if (entry.value !== undefined) out[key] = entry.value;
    }
    return out;
  }

  /** One value. Boot-time keys keep their boot value until the process restarts. */
  get<T = ConfigValue>(key: string, fallback?: T): ConfigValue | T | undefined {
    const entry = this.#entry(key);
    if (entry?.value !== undefined) {
      return this.#localEnvValue(key, entry.value) ?? entry.value;
    }
    if (entry?.masked) return fallback;
    return fallback;
  }

  /** `process.env`'s value for a key, typed like the remote value; undefined when unset. */
  #localEnvValue(key: string, reference: ConfigValue): ConfigValue | undefined {
    if (this.options.localEnv !== true) return undefined;
    const raw = process.env[envNameOf(key, this.options.envPrefix ?? '')];
    return raw === undefined ? undefined : coerceEnvValue(raw, reference);
  }

  /** One value as a string, for `process.env`-shaped settings. */
  getString(key: string, fallback?: string): string | undefined {
    const value = this.get(key, undefined);
    return value === undefined ? fallback : envValueOf(value as ConfigValue);
  }

  has(key: string): boolean {
    return this.#entry(key)?.value !== undefined;
  }

  /** Every entry of the current document (flags included). */
  entries(): Record<string, ConfigEntryView> {
    return { ...(this.#boot ?? {}), ...this.#live };
  }

  #entry(key: string): ConfigEntryView | undefined {
    const live = this.#live[key];
    if (live !== undefined) return live;
    return this.#boot?.[key];
  }

  /** Whether a key may hot-reload: marked on the control plane, or matched by `tenant.reloadable`. */
  isReloadable(key: string): boolean {
    return this.#isReloadable(key, this.entries()[key]);
  }

  #isReloadable(key: string, entry: ConfigEntryView | undefined): boolean {
    if (entry?.reloadable === true) return true;
    return (this.options.reloadable ?? []).some((pattern) => matches(pattern, key));
  }

  status(): TenantStatus {
    return {
      app: this.app,
      environment: this.environment,
      label: this.label,
      source: this.#source,
      version: this.#version,
      fingerprint: this.#fingerprint,
      loadedAt: this.#loadedAt,
      lastError: this.#lastError,
      stale: this.#lastError !== null && this.#source !== 'none',
      streaming: this.#streaming,
      ...(this.options.snapshotPath ? { snapshotPath: this.options.snapshotPath } : {}),
      localEnv: this.options.localEnv === true,
    };
  }

  /** The age of the snapshot file on disk, or null when there is none (used by the doctor). */
  async snapshotAgeMs(): Promise<number | null> {
    if (!this.options.snapshotPath) return null;
    try {
      const info = await stat(this.options.snapshotPath);
      return Date.now() - info.mtimeMs;
    } catch {
      return null;
    }
  }

  onChange(listener: (change: ConfigChangeSet) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Fetches now; returns whether anything changed. Concurrent callers share one request. */
  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<boolean> {
    try {
      const request = async () => {
        const headers = await this.#headers();
        headers.authorization = await this.#authorization();
        if (this.#fingerprint) {
          headers['if-none-match'] =
            `"${this.app}:${this.environment}:${this.label}:${this.#version}"`;
        }
        return this.#fetch(`${this.#base}/v1/config`, { headers });
      };
      let response = await request();
      if (response.status === 401) {
        // Drop the cached token and try once with a fresh one.
        this.#token.reset?.();
        response = await request();
      }
      if (response.status === 304) {
        this.#lastError = null;
        return false;
      }
      if (!response.ok) throw new Error(`control plane answered ${response.status}`);
      const document = (await response.json()) as ConfigDocumentView;
      this.#lastError = null;
      return await this.#apply(document);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.options.onError?.(error);
      return false;
    }
  }

  async #apply(document: ConfigDocumentView): Promise<boolean> {
    this.#document = document;
    const first = this.#boot === null;
    const previous = this.entries();
    const masked = document;
    this.#version = document.version;
    this.#fingerprint = document.fingerprint;
    this.#loadedAt = new Date();
    this.#source = 'remote';
    if (first) {
      this.#boot = { ...masked.entries };
      this.#live = {};
      this.options.logger?.info(
        `[@adonis-agora/config] ${this.app}/${this.environment}/${this.label}: ${Object.keys(masked.entries).length} entries at v${document.version}`,
      );
      if (this.options.env) this.#applyEnv();
      await this.#snapshot(masked);
      return true;
    }

    // Reloadable keys move to the live map; boot-time keys keep their boot value.
    const changes: string[] = [];
    const keys = new Set([...Object.keys(previous), ...Object.keys(masked.entries)]);
    for (const key of keys) {
      const before = previous[key];
      const after = masked.entries[key];
      const changed =
        JSON.stringify(before?.value ?? null) !== JSON.stringify(after?.value ?? null) ||
        (before?.masked ?? false) !== (after?.masked ?? false) ||
        before?.vault !== after?.vault ||
        before?.reloadable !== after?.reloadable;
      if (changed) changes.push(key);
    }
    const reloadable: string[] = [];
    const restartRequired: string[] = [];
    for (const key of changes) {
      if (this.#isReloadable(key, masked.entries[key] ?? previous[key])) {
        reloadable.push(key);
        const after = masked.entries[key];
        if (after === undefined) delete this.#live[key];
        else this.#live[key] = after;
      } else {
        restartRequired.push(key);
      }
    }
    if (reloadable.length > 0 || restartRequired.length > 0) {
      this.#emit({
        version: document.version,
        fingerprint: document.fingerprint,
        reloadable,
        restartRequired,
        added: changes.filter(
          (key) => previous[key] === undefined && masked.entries[key] !== undefined,
        ),
        removed: changes.filter(
          (key) => previous[key] !== undefined && masked.entries[key] === undefined,
        ),
      });
    }
    if (restartRequired.length > 0) {
      this.options.logger?.warn(
        `[@adonis-agora/config] ${this.app}: ${restartRequired.length} changed key(s) need a restart (${restartRequired.join(', ')})`,
      );
    }
    if (this.options.env) this.#applyEnv();
    await this.#snapshot(masked);
    return reloadable.length > 0 || restartRequired.length > 0;
  }

  #emit(change: ConfigChangeSet): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // a listener must not break the refresh loop
      }
    }
  }

  #applyEnv(): void {
    for (const [key, value] of Object.entries(this.values())) {
      const name = envNameOf(key, this.options.envPrefix ?? '');
      if (process.env[name] === undefined) process.env[name] = envValueOf(value);
    }
  }

  async #snapshot(document: ConfigDocumentView): Promise<void> {
    const path = this.options.snapshotPath;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash mid-write never leaves a truncated snapshot.
      await writeFile(`${path}.tmp`, JSON.stringify(document), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async #loadSnapshot(): Promise<void> {
    const path = this.options.snapshotPath;
    if (!path) return;
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const document = JSON.parse(text) as ConfigDocumentView;
      this.#document = document;
      this.#boot = { ...document.entries };
      this.#live = {};
      this.#version = document.version;
      this.#fingerprint = document.fingerprint;
      this.#loadedAt = new Date(info.mtimeMs);
      this.#source = 'snapshot';
      this.options.logger?.warn(
        `[@adonis-agora/config] ${this.app}: control plane unreachable, booted from the snapshot (v${document.version})`,
      );
      if (this.options.env) this.#applyEnv();
    } catch {
      // No snapshot yet: the caller decides whether that is fatal.
    }
  }

  /** Reads `event: config` messages; reconnects with backoff while the client runs. */
  async #openStream(): Promise<void> {
    let backoff = 1_000;
    while (!this.#stopped) {
      this.#streamAbort = new AbortController();
      try {
        const response = await this.#fetch(`${this.#base}/v1/config/stream`, {
          headers: {
            ...this.#headers(),
            authorization: await this.#authorization(),
            accept: 'text/event-stream',
          },
          signal: this.#streamAbort.signal,
        });
        if (response.status === 401) this.#token.reset?.();
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
        this.#streaming = true;
        backoff = 1_000;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (/^event: config$/m.test(message)) void this.refresh();
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (this.#stopped) break;
        this.options.onError?.(error);
      } finally {
        this.#streaming = false;
      }
      if (this.#stopped) break;
      await new Promise((resolve) => setTimeout(resolve, backoff).unref());
      backoff = Math.min(backoff * 2, 30_000);
      void this.refresh();
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#streamAbort?.abort();
  }
}

/** A tenant client from the same options, for tests and for the bootstrap entry. */
export function createTenantClient(options: TenantClientOptions): TenantClient {
  return new TenantClient(options);
}
