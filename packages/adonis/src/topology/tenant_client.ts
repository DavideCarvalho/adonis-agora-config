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
import { entryAad } from '../crypto/secrets.js';
import type { ConfigTransport } from '../transports/types.js';
import type { TenantKeyring } from './tenant_keyring.js';
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
  /** Sealed-secret state: the app key and how the entries sealed to it stand. */
  keys?: TenantKeyStatus;
}

/** How an app's sealed secrets stand: what it holds, and what it could not open. */
export interface TenantKeyStatus {
  /** The kid new `sealTo` writes use. */
  activeKid: string;
  kids: string[];
  /** Whether the control plane knows this app's public keys (null: never tried). */
  registered: boolean | null;
  /** Entries the server sent sealed to this app (opened or not). */
  sealed: number;
  /** Sealed entries whose private key is missing, or whose AAD no longer matches. */
  unreadable: number;
  /** Sealed entries still using a retired key: the CLI re-seals them to the active one. */
  staleKids: string[];
  /** Why the last registration failed, when it did. */
  error?: string;
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
  /**
   * The app's own X25519 keyring. Entries sealed to this app (`sealedTo`) are opened with it before
   * they reach `values()`/`nested()`; the public half is registered with the control plane.
   */
  keys?: TenantKeyring;
  /** Publish `keys` to the control plane on connect. Default `true` when `keys` is set. */
  registerKeys?: boolean;
  /**
   * How the tenant watches the control plane. Default: HTTP SSE + polling. `transports.redis` /
   * `transports.durable` replace only the watch channel; the document is fetched over HTTP.
   */
  transport?: ConfigTransport;
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
  #watchStop: (() => void) | undefined;
  #refreshing: Promise<boolean> | undefined;
  #keys: TenantKeyring | undefined;
  #keysRegistered: boolean | null = null;
  #keysError: string | undefined;
  #sealed = { sealed: 0, unreadable: 0, staleKids: [] as string[] };

  constructor(private readonly options: TenantClientOptions) {
    this.#token = resolveTenantToken(options.token);
    // A stored `fetch` must be bound: `this.#fetch(...)` would otherwise call it with `this` set to
    // this client, which browsers reject with "Illegal invocation".
    this.#fetch = (options.transport?.fetch ?? options.fetch ?? fetch).bind(globalThis);
    this.#keys = options.keys;
  }

  /** A conditional GET, with the transport's timeout when it set one. */
  #request(url: string, init: RequestInit): Promise<Response> {
    const timeout = this.options.transport?.timeoutMs;
    return this.#fetch(
      url,
      timeout === undefined || timeout <= 0
        ? init
        : { ...init, signal: init.signal ?? AbortSignal.timeout(timeout) },
    );
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
    return (this.options.transport?.url ?? this.options.url).replace(/\/$/, '');
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
    if (this.#keys && this.options.registerKeys !== false) await this.registerKeys();
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
    if (this.options.transport?.watch) {
      this.#watchStop = await this.options.transport.watch(
        { app: this.app, environment: this.environment, label: this.label },
        () => void this.refresh(),
      );
    } else if (streaming) {
      void this.#openStream();
    }
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
      ...(this.#keys ? { keys: this.keyStatus() } : {}),
    };
  }

  /** The sealed-secret state of this app (doctor, CLI and status()). */
  keyStatus(): TenantKeyStatus {
    const status = this.#keys?.status() ?? { activeKid: '', kids: [], path: '' };
    return {
      ...status,
      registered: this.#keysRegistered,
      ...(this.#keysError !== undefined ? { error: this.#keysError } : {}),
      ...this.#sealed,
    };
  }

  /**
   * Uses a keyring built after this client (the bootstrap phase has no app root). Re-registers and
   * refreshes, so already-received sealed entries are opened.
   */
  async useKeys(keys: TenantKeyring): Promise<void> {
    this.#keys = keys;
    this.#keysRegistered = null;
    await this.registerKeys();
    await this.refresh();
  }

  /**
   * Publishes this app's public keys (never the private ones) so the control plane can seal values
   * to it. Best effort: a failure is logged and retried on the next `load()`, never fatal.
   */
  async registerKeys(): Promise<boolean> {
    const keys = this.#keys;
    if (!keys) return false;
    const send = async () => {
      const headers = await this.#headers();
      headers.authorization = await this.#authorization();
      headers['content-type'] = 'application/json';
      return this.#fetch(`${this.#base}/v1/keys`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ active: keys.activeKid, keys: keys.publicKeys() }),
      });
    };
    try {
      let response = await send();
      if (response.status === 401) {
        this.#token.reset?.();
        response = await send();
      }
      if (!response.ok) throw new Error(`control plane answered ${response.status}`);
      this.#keysRegistered = true;
      this.#keysError = undefined;
      return true;
    } catch (error) {
      this.#keysRegistered = false;
      this.#keysError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        `[@adonis-agora/config] ${this.app}: could not register the public key (${this.#keysError}); secrets sealed to it stay unreadable at the server`,
      );
      return false;
    }
  }

  /**
   * Re-seals the entries sealed to a retired key with the active one and sends the ciphertext
   * back. The control plane never opens it: only this app could, and only this app can re-seal it.
   */
  async resealSealed(options: { dryRun?: boolean } = {}): Promise<{
    dryRun: boolean;
    scanned: number;
    resealed: number;
    skipped: number;
    version: number;
  }> {
    const keys = this.#keys;
    const document = this.#document;
    if (!keys) throw new Error('config: this app has no tenant keyring');
    if (!document) throw new Error('config: the configuration has not been loaded yet');
    const updates: Array<{ key: string; value: string; kid: string }> = [];
    let scanned = 0;
    let skipped = 0;
    for (const [key, entry] of Object.entries(document.entries)) {
      if (entry.sealedTo === undefined) continue;
      scanned += 1;
      if (entry.sealedTo.kid === keys.activeKid) {
        skipped += 1;
        continue;
      }
      if (entry.value === undefined) {
        skipped += 1;
        continue;
      }
      updates.push({
        key,
        kid: keys.activeKid,
        value: keys.seal(JSON.stringify(entry.value), entryAad(document, key)),
      });
    }
    if (options.dryRun === true || updates.length === 0) {
      return {
        dryRun: options.dryRun === true,
        scanned,
        resealed: 0,
        skipped,
        version: document.version,
      };
    }
    const send = async () => {
      const headers = await this.#headers();
      headers.authorization = await this.#authorization();
      headers['content-type'] = 'application/json';
      return this.#fetch(`${this.#base}/v1/sealed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: document.version, entries: updates }),
      });
    };
    let response = await send();
    if (response.status === 401) {
      this.#token.reset?.();
      response = await send();
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        `config: the control plane refused the re-seal (${response.status}${body.error ? `: ${body.error}` : ''})`,
      );
    }
    const result = (await response.json()) as { version: number };
    await this.refresh();
    return {
      dryRun: false,
      scanned,
      resealed: updates.length,
      skipped,
      version: result.version,
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
        return this.#request(`${this.#base}/v1/config`, { headers });
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

  async #apply(raw: ConfigDocumentView): Promise<boolean> {
    // The snapshot always keeps what the server sent (ciphertext for sealed values); only the
    // in-memory document is opened.
    const document = this.#resolveSealed(raw);
    // What changed is decided against the last document received, not against what this process
    // applied: a boot-time key that changed once must not be reported again on every later update.
    const previous = this.#document?.entries ?? {};
    this.#document = document;
    const first = this.#boot === null;
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
      await this.#snapshot(raw);
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
        before?.sealedTo?.kid !== after?.sealedTo?.kid ||
        before?.reloadable !== after?.reloadable;
      if (changed) changes.push(key);
    }
    const reloadable: string[] = [];
    const restartRequired: string[] = [];
    for (const key of changes) {
      if (this.#isReloadable(key, masked.entries[key] ?? previous[key])) {
        reloadable.push(key);
        const after = masked.entries[key];
        if (after === undefined) {
          delete this.#live[key];
          // A reloadable key removed on the server is gone from the app too; a boot-time key
          // keeps its boot value until a restart.
          if (this.#boot) delete this.#boot[key];
        } else {
          this.#live[key] = after;
        }
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
    await this.#snapshot(raw);
    return reloadable.length > 0 || restartRequired.length > 0;
  }

  /**
   * Opens every entry the server sealed to this app with its private key. An entry that cannot be
   * opened is withheld (masked) and counted: never served as ciphertext to the app's config.
   */
  #resolveSealed(document: ConfigDocumentView): ConfigDocumentView {
    const keys = this.#keys;
    const sealedEntries = Object.entries(document.entries).filter(
      ([, entry]) => entry.sealedTo !== undefined,
    );
    if (sealedEntries.length === 0) {
      this.#sealed = { sealed: 0, unreadable: 0, staleKids: [] };
      return document;
    }
    const entries = { ...document.entries };
    const stale = new Set<string>();
    let unreadable = 0;
    for (const [key, entry] of sealedEntries) {
      if (entry.sealedTo !== undefined && entry.sealedTo.kid !== keys?.activeKid) {
        stale.add(entry.sealedTo.kid);
      }
      const hide = () => {
        const { value: _value, ...rest } = entry;
        return { ...rest, masked: true };
      };
      if (!keys) {
        unreadable += 1;
        entries[key] = hide();
        continue;
      }
      if (typeof entry.value !== 'string') {
        unreadable += 1;
        entries[key] = hide();
        continue;
      }
      try {
        const plain = keys.open(entry.value, entryAad(document, key));
        entries[key] = { ...entry, value: JSON.parse(plain), masked: false };
      } catch (error) {
        unreadable += 1;
        entries[key] = hide();
        this.options.logger?.warn(
          `[@adonis-agora/config] ${this.app}: sealed entry "${key}" did not open (${(error as Error).message})`,
        );
      }
    }
    this.#sealed = { sealed: sealedEntries.length, unreadable, staleKids: [...stale] };
    return { ...document, entries };
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
    if (path) {
      try {
        const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        const raw = JSON.parse(text) as ConfigDocumentView;
        const document = this.#resolveSealed(raw);
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
        return;
      } catch {
        // Fall through to the broker snapshot.
      }
    }

    // No local snapshot: a broker may keep the last masked one (never the secrets).
    const remote = await this.options.transport?.snapshot?.({
      app: this.app,
      environment: this.environment,
      label: this.label,
    });
    if (!remote) return;
    this.#document = remote;
    this.#boot = { ...remote.entries };
    this.#live = {};
    this.#version = remote.version;
    this.#fingerprint = remote.fingerprint;
    this.#loadedAt = new Date();
    this.#source = 'snapshot';
    this.options.logger?.warn(
      `[@adonis-agora/config] ${this.app}: control plane unavailable, booted from the broker snapshot (v${remote.version})`,
    );
    if (this.options.env) this.#applyEnv();
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
    this.#watchStop?.();
    this.#watchStop = undefined;
    this.#streamAbort?.abort();
  }
}

/** A tenant client from the same options, for tests and for the bootstrap entry. */
export function createTenantClient(options: TenantClientOptions): TenantClient {
  return new TenantClient(options);
}
