import { envNameOf, envValueOf } from '@adonis-agora/config-core';
import { EnvProcessor } from '@adonisjs/core/env';
import {
  createTenantClient,
  setTenantBootstrap,
  type TenantClient,
  tenantBootstrapKey,
} from './topology/tenant_client.js';
import type { TenantUrlSource } from './topology/tenant_url.js';
import type { TenantTokenSource } from './topology/token.js';

/** The resource indicator of the config control plane in authkit. */
export const CONFIG_RESOURCE = 'urn:agora:config';

/** What {@link importRemoteConfig} needs, read from the local environment by the app. */
export interface ImportRemoteConfigOptions {
  /**
   * The authkit issuer the service token comes from. With `clientId`/`clientSecret` and
   * `@adonis-agora/authkit-client` installed, the token is fetched and refreshed for you.
   */
  issuer?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** A token instead of the three above (a string, or a function returning one). */
  token?: TenantTokenSource | undefined;
  /**
   * The config server. Default: what the issuer publishes for `urn:agora:config` in its discovery
   * document (`agora_control_planes`).
   */
  url?: string | undefined;
  /** This app's name. Default: the `partition` of the service token. */
  partition?: string | undefined;
  /** Default `production`. */
  environment?: string | undefined;
  label?: string | undefined;
  /**
   * The last document received, to boot with the server down. Relative paths are resolved
   * against the app root. Default `tmp/config/snapshot.json`; `false` keeps none.
   */
  snapshotPath?: string | false | undefined;
  /** How long each fetch may take. Default 5000 ms. */
  timeoutMs?: number | undefined;
  /**
   * Try again before giving up, like Spring Cloud Config's `spring-retry`: `attempts` fetches in
   * all, waiting `initialMs`, then × `multiplier`, capped at `maxMs`. Default: one attempt.
   */
  retry?: ImportRetryOptions | undefined;
  /**
   * When every attempt failed and there is no snapshot, fail the boot (throw) instead of booting
   * on the local environment, like `spring.cloud.config.fail-fast`. The platform restarts the
   * process, and a rolling deploy keeps the old instances serving. Default `false`.
   */
  failFast?: boolean | undefined;
}

export interface ImportRetryOptions {
  /** Fetches in all, the first included. Default 6. */
  attempts?: number;
  /** Wait before the second attempt. Default 1000 ms. */
  initialMs?: number;
  /** Each wait is the previous × this. Default 1.5. */
  multiplier?: number;
  /** Longest wait. Default 5000 ms. */
  maxMs?: number;
}

/** The config server could not be reached, there was no snapshot, and `failFast` is on. */
export class RemoteConfigUnavailableError extends Error {
  readonly code = 'E_REMOTE_CONFIG_UNAVAILABLE';
  constructor(attempts: number) {
    super(
      `[@adonis-agora/config] the config server did not answer after ${attempts} attempt${attempts === 1 ? '' : 's'} and there is no snapshot (failFast is on)`,
    );
  }
}

export interface ImportRemoteConfigResult {
  /** Where the values came from. */
  source: 'remote' | 'snapshot' | 'none';
  /** The variables set from the config server (not those already set locally). */
  applied: string[];
  /** Keys the server has that the local environment already sets (it wins). */
  shadowed: string[];
  version: number;
  client: TenantClient;
}

/** The local environment: `process.env` and the app's `.env` files, as `Env.create` reads them. */
export type LocalEnv = Readonly<Record<string, string | undefined>>;

/**
 * Brings the app's configuration from the config server into `process.env` **before**
 * `Env.create` validates it: the AdonisJS counterpart of Spring's `spring.config.import`, called at
 * the top of `start/env.ts`.
 *
 * ```ts
 * // start/env.ts
 * await importRemoteConfig(new URL('../', import.meta.url), (env) => ({
 *   issuer: env.AUTHKIT_ISSUER,
 *   clientId: env.SERVICE_CLIENT_ID,
 *   clientSecret: env.SERVICE_CLIENT_SECRET,
 *   url: env.CONFIG_URL,
 * }))
 *
 * export default await Env.create(new URL('../', import.meta.url), { … })
 * ```
 *
 * Precedence, like Spring's default: **the process environment > the `.env` files > the config
 * server**. The `.env` files are loaded first (the same files, in the same order, as `Env.create`),
 * so a variable set locally is never replaced; the server only fills what is missing. Every value
 * then goes through the app's env schema like any other.
 *
 * `options` is called with that local environment, so credentials may live in `.env` in
 * development. Without credentials (no token, no issuer + client) nothing is fetched and the app
 * boots on its local environment: tests and local dev keep working untouched.
 *
 * The server down: the last snapshot is used; without one, the app boots on its local environment
 * and a warning is logged. The boot never fails because of the config server.
 */
export async function importRemoteConfig(
  appRoot: URL | string,
  options:
    | ImportRemoteConfigOptions
    | ((env: LocalEnv) => ImportRemoteConfigOptions | undefined | null | false),
): Promise<ImportRemoteConfigResult | null> {
  const root =
    typeof appRoot === 'string' ? new URL(`file://${appRoot.replace(/\/?$/, '/')}`) : appRoot;
  // The same files and order as `Env.create`: they land in `process.env` without replacing it.
  await new EnvProcessor(root).process();
  const local: LocalEnv = { ...process.env };
  const resolved = typeof options === 'function' ? options(local) : options;
  if (!resolved) return null;

  const token = await tokenSource(resolved);
  if (token === null) return null;

  const url = await urlSource(resolved);
  if (url === null) {
    warn('no config server URL (pass `url`, or an `issuer` that publishes urn:agora:config)');
    return null;
  }
  const partition = resolved.partition ?? (await partitionFromToken(token));
  if (!partition) {
    warn('could not tell the app name (pass `partition`, or use a service token with one)');
    return null;
  }

  const snapshot =
    resolved.snapshotPath === false
      ? undefined
      : (resolved.snapshotPath ?? 'tmp/config/snapshot.json');
  const client = createTenantClient({
    url,
    partition,
    token,
    environment: resolved.environment ?? 'production',
    ...(resolved.label !== undefined ? { label: resolved.label } : {}),
    ...(snapshot !== undefined ? { snapshotPath: new URL(snapshot, root).pathname } : {}),
    required: false,
    onError: (error) =>
      warn(`config server: ${error instanceof Error ? error.message : String(error)}`),
  });
  const timeoutMs = resolved.timeoutMs ?? 5000;
  const attempts = resolved.retry ? Math.max(1, resolved.retry.attempts ?? 6) : 1;
  let wait = resolved.retry?.initialMs ?? 1000;
  // Retry the fetch itself first; `start()` then loads (a snapshot as the last resort) and keeps it fresh.
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (await withTimeoutResult(client.refresh(), timeoutMs, false)) break;
    await sleep(wait);
    wait = Math.min(wait * (resolved.retry?.multiplier ?? 1.5), resolved.retry?.maxMs ?? 5000);
  }
  await withTimeout(client.start(), timeoutMs);
  if (resolved.failFast === true && client.status().source === 'none') {
    await client.stop();
    throw new RemoteConfigUnavailableError(attempts);
  }
  setTenantBootstrap(
    tenantBootstrapKey({
      url,
      partition,
      environment: resolved.environment ?? 'production',
      ...(resolved.label !== undefined ? { label: resolved.label } : {}),
    }),
    client,
  );

  const applied: string[] = [];
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(client.values())) {
    const name = envNameOf(key);
    if (process.env[name] !== undefined) {
      shadowed.push(name);
      continue;
    }
    process.env[name] = envValueOf(value);
    applied.push(name);
  }
  const status = client.status();
  if (status.source === 'none') {
    warn('config server unreachable and no snapshot: booting on the local environment');
  }
  return { source: status.source, applied, shadowed, version: status.version, client };
}

function warn(message: string): void {
  process.emitWarning(`[@adonis-agora/config] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `promise`'s value, or `fallback` after `ms`. */
async function withTimeoutResult<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface AuthkitClientModule {
  authkitTenantToken(options: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    resource: string;
  }): (() => Promise<string>) & { reset?(): void };
  controlPlaneUrl(options: { issuer: string; resource: string }): (() => Promise<string>) & {
    refresh(): Promise<string>;
  };
}

async function authkitClient(): Promise<AuthkitClientModule | null> {
  try {
    return (await import('@adonis-agora/authkit-client')) as unknown as AuthkitClientModule;
  } catch {
    return null;
  }
}

async function tokenSource(options: ImportRemoteConfigOptions): Promise<TenantTokenSource | null> {
  if (options.token !== undefined) return options.token;
  const { issuer, clientId, clientSecret } = options;
  if (!issuer || !clientId || !clientSecret) return null;
  const authkit = await authkitClient();
  if (!authkit) {
    warn('issuer + client given but @adonis-agora/authkit-client is not installed: pass `token`');
    return null;
  }
  return authkit.authkitTenantToken({ issuer, clientId, clientSecret, resource: CONFIG_RESOURCE });
}

async function urlSource(options: ImportRemoteConfigOptions): Promise<TenantUrlSource | null> {
  if (options.url) return options.url;
  if (!options.issuer) return null;
  const authkit = await authkitClient();
  if (!authkit) return null;
  return authkit.controlPlaneUrl({ issuer: options.issuer, resource: CONFIG_RESOURCE });
}

/** The `partition` claim of the service token (decoded, not verified: it is our own token). */
async function partitionFromToken(source: TenantTokenSource): Promise<string | undefined> {
  try {
    const token =
      typeof source === 'string'
        ? source
        : typeof source === 'function'
          ? await source()
          : await source.get();
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return typeof payload?.partition === 'string' && payload.partition !== ''
      ? payload.partition
      : undefined;
  } catch {
    return undefined;
  }
}
