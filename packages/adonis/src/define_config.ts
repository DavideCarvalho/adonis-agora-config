import type { ConfigScope, ConfigValue, VaultReference } from '@adonis-agora/config-core';
import type { ApplicationService } from '@adonisjs/core/types';
import type { CryptoOptions, SecretCodec } from './crypto/secrets.js';
import type { ConfigConsoleConfig } from './dashboard/define_config.js';
import type { SqlDatabase } from './sql.js';
import { describeStackUse, hasLucidConnection, lucidUse, type StackUse } from './stack.js';
import { LucidStore } from './store/lucid_store.js';
import { MemoryStore } from './store/memory_store.js';
import type { ConfigStore } from './store/store.js';
import { isTenantUrlSource, type TenantUrlSource } from './topology/tenant_url.js';
import type { TenantTokenSource } from './topology/token.js';
import type { TenantVerifierInput } from './topology/verify.js';
import type { ConfigTransportFactory } from './transports/types.js';

/** What store factories receive. */
export interface FactoryContext {
  app?: ApplicationService;
  /** A Lucid query client (the default connection when omitted). */
  db(connection?: string): Promise<SqlDatabase>;
  autoCreateSchema: boolean;
  /** Built from `crypto`; undefined when no key is configured. */
  secretCodec?: SecretCodec;
}

export type Factory<T> = (context: FactoryContext) => T | Promise<T>;

export const stores = {
  /** The configuration in your database (Postgres, MySQL, SQLite). The default on a control plane. */
  lucid(options: { connection?: string; autoCreateSchema?: boolean } = {}): Factory<ConfigStore> {
    return describeStackUse(
      async (context: FactoryContext) =>
        new LucidStore(await context.db(options.connection), {
          autoCreateSchema: options.autoCreateSchema ?? context.autoCreateSchema,
          ...(context.secretCodec ? { secretCodec: context.secretCodec } : {}),
        }),
      () => lucidUse(options.connection, 'configuration'),
    );
  },
  /** In process memory: tests and local development. */
  memory(): Factory<ConfigStore> {
    return (context) =>
      new MemoryStore(context.secretCodec ? { secretCodec: context.secretCodec } : {});
  },
};

/** Whose entry a vault reference is being resolved for. */
export interface VaultContext {
  /** The scope that holds the entry: a resolver must only read paths that app may read. */
  scope: ConfigScope;
}

/**
 * Resolves a `vault://provider/path#field` reference at read time. `context.scope` is the scope the
 * entry belongs to: the resolver answers with this server's credentials, so it is the resolver's
 * (or {@link VaultConfig.allow}'s) job to refuse a path that app should not reach.
 */
export type VaultResolver = (
  reference: VaultReference,
  context: VaultContext,
) => ConfigValue | undefined | Promise<ConfigValue | undefined>;

export interface VaultConfig {
  /**
   * The resolver. Wire it to authkit's vault packages (`authkit-vault-aws|azure|gcp`) or to your
   * own secret manager; this package never talks to a vault itself. A reference that cannot be
   * resolved is served masked and logged, never as a wrong value.
   */
  resolve: VaultResolver;
  /**
   * Whether `scope` may use `reference`. Checked before every resolution (console, MCP, control
   * plane). Without it any writer of any app can point an entry at any path this server's vault
   * credentials reach — set it whenever apps must not read each other's secrets:
   * `allow: (ref, scope) => ref.path.startsWith(`${scope.app}/`)`.
   */
  allow?: (reference: VaultReference, scope: ConfigScope) => boolean;
}

/** {@link VaultConfig} as one resolver: `allow` first, then `resolve` (a refused path stays masked). */
export function scopedVaultResolver(config: VaultConfig): VaultResolver {
  return async (reference, context) => {
    if (config.allow && !config.allow(reference, context.scope)) {
      throw new Error(
        `vault reference vault://${reference.provider}/${reference.path} is not allowed for ${context.scope.app}`,
      );
    }
    return config.resolve(reference, context);
  };
}

/** The environment this process belongs to. Default: `production` on a control plane, `NODE_ENV` on a tenant. */
interface BaseConfig {
  environment?: string;
  /**
   * Contribute the "Configuration" telescope dashboard automatically (the provider pushes the
   * extension into `'agora.telescope.extensions'`). Default on; `false` turns it off, and an
   * extension listed in `config/telescope.ts` still works either way.
   */
  telescope?: boolean | { windowMs?: number };
}

/** A single app that owns its configuration locally (the console and commands still work). */
export interface StandaloneConfig extends BaseConfig {
  topology?: 'standalone';
  /**
   * This app's name (the partition). Default on a standalone: `APP_NAME` when set; otherwise the
   * runtime has no default app and the console/CLI ask for one (`--app`). A tenant always
   * takes its `tenant.partition`.
   */
  app?: string;
  /** Where the configuration lives. Default `stores.lucid()`. */
  store?: Factory<ConfigStore>;
  crypto?: CryptoOptions;
  vault?: VaultConfig;
  /** Create the tables at boot. Default `true`. */
  autoCreateSchema?: boolean;
  /** Postgres: keep every table in this schema (created separately). */
  schema?: string;
  /** Mount the console (the SPA + its JSON API). Default on. */
  console?: ConfigConsoleConfig | false;
  /**
   * Answer another app's federated config console (its `console.federatedApps`): that console reads
   * this app's versions and audit from the database, without secret values, and sends here what
   * only this app may do — set and unset entries, roll back (with `actions: true`), and reveal a
   * secret (with `reveal: true`). Every web instance listens; one claims each command and runs it,
   * with the other console's viewer recorded as the actor. Needs `@adonisjs/redis`. Off when omitted.
   *
   * ```ts
   * consoleCommands: { connection: 'main', prefix: 'entretextos', actions: true },
   * ```
   */
  consoleCommands?: ConfigConsoleCommandsConfig;
}

/** The server every app connects to. */
export interface ControlPlaneConfig extends BaseConfig {
  topology: 'control-plane';
  /**
   * Validates a tenant's token. TOP LEVEL, in the same place in every Agora lib, and it accepts the
   * three forms: a function, a class instance, or `() => import('./verifier.js')`. The app, the
   * environment and the capabilities come from the verified token — never from the request.
   *
   * With authkit: `authkitTenantVerifier({ issuer, resource: 'urn:agora:config' })` from
   * `@adonis-agora/authkit-client`. Without it: `sharedSecretVerifier({ partitions: { … } })`.
   */
  verifyTenant: TenantVerifierInput;
  /** Route prefix. Default `/_config`. */
  prefix?: string;
  /** Origins allowed to call the tenant API cross-origin. Default: none. */
  corsOrigins?: string[];
  /** Where the configuration lives. Default `stores.lucid()`. */
  store?: Factory<ConfigStore>;
  crypto?: CryptoOptions;
  vault?: VaultConfig;
  autoCreateSchema?: boolean;
  /** Postgres: keep every table in this schema (created separately). */
  schema?: string;
  /** Mount the console (the SPA + its JSON API). Default on. */
  console?: ConfigConsoleConfig | false;
  /**
   * Answer another app's federated config console (its `console.federatedApps`): that console reads
   * this app's versions and audit from the database, without secret values, and sends here what
   * only this app may do — set and unset entries, roll back (with `actions: true`), and reveal a
   * secret (with `reveal: true`). Every web instance listens; one claims each command and runs it,
   * with the other console's viewer recorded as the actor. Needs `@adonisjs/redis`. Off when omitted.
   *
   * ```ts
   * consoleCommands: { connection: 'main', prefix: 'entretextos', actions: true },
   * ```
   */
  consoleCommands?: ConfigConsoleCommandsConfig;
  /**
   * How this control plane announces changes to broker-backed tenants (`transports.redis(...)`,
   * `transports.durable(...)`). The HTTP API stays mounted regardless: browsers, the console and
   * http tenants always use it.
   */
  transport?: ConfigTransportFactory;
}

/** {@link StandaloneConfig.consoleCommands}. */
export interface ConfigConsoleCommandsConfig {
  /** The `@adonisjs/redis` connection. Defaults to its default connection. */
  connection?: string;
  /**
   * This app's name on the channel (`<prefix>-config-console`): the same `prefix` the other
   * console names in its `federatedApps` entry. Not the connection's `keyPrefix`.
   */
  prefix: string;
  /**
   * Take changes from the other console: set and unset entries, roll back. Each one is a version
   * and an audit row of this app's own. Default `false` (the other console only browses). Values
   * arrive sealed to a key derived from this app's `APP_KEY`.
   */
  actions?: boolean;
  /**
   * Reveal a secret to the other console's viewer when its `authorize` granted
   * `config:secrets:read`. Audited here like a reveal in this app's console. The value goes back
   * sealed to a key made for that one request. Default `false`.
   */
  reveal?: boolean;
  /** The partitions the other console may touch. Default: this app's own (`app`), else any. */
  partitions?: string[];
  /**
   * The secret this app and the other console share (the console's
   * `federatedApps.<app>.controlPlane.secret`), at least 16 characters. Every command and answer
   * carries an HMAC under it, commands older than a minute are refused and each one runs at most
   * once. Required: without it the web process refuses to boot.
   */
  secret?: string | { release(): string };
}

/** An app that reads its configuration from a control plane. */
export interface TenantTopologyConfig extends BaseConfig {
  topology: 'tenant';
  tenant: {
    /**
     * The control plane's base URL (`https://config.example.com/_config`), or a function resolving
     * it before the first request: `controlPlaneUrl({ issuer, resource: 'urn:agora:config' })` from
     * `@adonis-agora/authkit-client`. A lazy URL is looked up again (its `refresh()`) when the
     * control plane stops answering.
     */
    url: TenantUrlSource;
    /** This app's name on the control plane (the partition). */
    partition: string;
    /**
     * The bearer token: a fixed shared secret, a function, or an object with `get()`. With authkit:
     * `authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:config' })` from
     * `@adonis-agora/authkit-client` (a function with `token()`/`reset()`). Obtainable before the
     * app's config loads: keep issuer/client id/secret in the environment.
     */
    token: TenantTokenSource;
    /** The environment to read. Default: the process's `NODE_ENV`, else `production`. */
    environment?: string;
    /** The label (profile) to read. Default `main`. */
    label?: string;
    /**
     * File holding the last document received. Read when the control plane is unreachable at boot,
     * so a deploy during an outage still boots with real configuration.
     */
    snapshotPath?: string;
    /** Use server-sent events for push updates. Default `true`; polling always runs as a fallback. */
    stream?: boolean;
    /** Poll interval (ms). Default 30000 with streaming, 5000 without. */
    intervalMs?: number;
    /** Fail the boot when the server is unreachable AND no snapshot exists. Default `false`. */
    required?: boolean;
    /**
     * Keys that may hot-reload, in addition to the entries marked `reloadable` on the control plane.
     * Everything else needs a restart, and the console says so.
     */
    reloadable?: string[];
    /** Apply the received values to `process.env` too (only keys that are not already set). */
    env?: boolean;
    /**
     * Let `process.env` win over the remote value of a key that is set there (`DB_PORT` for
     * `db.port`). On by default outside production, which is what keeps a Sail worktree on its own
     * ports after `sail:sync-env`: the config server's `db.port` never shadows them in dev.
     */
    localEnv?: boolean;
    /**
     * Where this app's X25519 private key lives, relative to the app root. Default
     * `storage/config-tenant-key.json`; the file is created (mode 0600) on first boot and the
     * private key is sealed with APP_KEY. `false` turns sealed secrets off for this app.
     */
    keyPath?: string | false;
    /** Publish the public key to the control plane on connect. Default `true` when `keyPath` is on. */
    registerKey?: boolean;
    /**
     * How this tenant watches the control plane. Default `transports.http()` (SSE + poll); use
     * `transports.redis(...)` or `transports.durable(...)` to watch over a broker. The document is
     * always fetched over HTTP with this tenant's token.
     */
    transport?: ConfigTransportFactory;
  };
  /** FORBIDDEN on a tenant: it owns no configuration; it reads the control plane's. */
  store?: never;
  crypto?: never;
  vault?: never;
  autoCreateSchema?: never;
  schema?: never;
  console?: never;
  consoleCommands?: never;
}

export type ConfigConfig = StandaloneConfig | ControlPlaneConfig | TenantTopologyConfig;

/** The standalone partition: the explicit `app`, else `APP_NAME`, else none. */
export function resolveStandaloneApp(
  explicit: string | undefined,
  appName: string | undefined = process.env.APP_NAME,
): string | undefined {
  return explicit?.trim() || appName?.trim() || undefined;
}

/** Identity helper that types `config/config.ts`, and refuses shapes that cannot work. */
export function defineConfig(config: ConfigConfig): ConfigConfig {
  const raw = config as ConfigConfig & { verifyTenant?: unknown; controlPlane?: unknown };
  if (config.topology === 'tenant') {
    if (!isTenantUrlSource(config.tenant.url)) {
      throw new Error(
        'config: tenant.url is required (an absolute http(s) URL, or a function resolving one)',
      );
    }
    if (!config.tenant.partition) throw new Error('config: tenant.partition is required');
    if (!config.tenant.token) {
      throw new Error(
        "config: tenant.token is required (authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:config' }) or the shared secret)",
      );
    }
    if (typeof config.tenant.url === 'string' && !/^https?:\/\//.test(config.tenant.url)) {
      throw new Error('config: tenant.url must be an absolute http(s) URL');
    }
    if (raw.verifyTenant !== undefined) {
      throw new Error('config: `verifyTenant` only applies to topology "control-plane"');
    }
  }
  if (config.topology === 'control-plane') {
    if (!raw.verifyTenant) {
      throw new Error(
        "config: a control plane needs `verifyTenant` (authkitTenantVerifier({ issuer, resource: 'urn:agora:config' }) or sharedSecretVerifier({ partitions })) — a tenant must never be trusted without a token",
      );
    }
    const kind = typeof raw.verifyTenant;
    if (
      kind !== 'function' &&
      !(
        kind === 'object' && typeof (raw.verifyTenant as { verify?: unknown }).verify === 'function'
      )
    ) {
      throw new Error(
        'config: `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
      );
    }
  }
  if (config.topology !== 'control-plane' && raw.verifyTenant !== undefined) {
    throw new Error('config: `verifyTenant` only applies to topology "control-plane"');
  }
  return describeStackUse(config, () => defaultStackUses(config));
}

/**
 * What the omitted `store` falls back to on a standalone app or a control plane: the default Lucid
 * connection. A tenant owns no state. Explicit factories describe themselves.
 */
export function defaultStackUses(config: ConfigConfig): StackUse[] {
  if (config.topology === 'tenant' || config.store || !hasLucidConnection()) return [];
  return [lucidUse(undefined, 'configuration')];
}
