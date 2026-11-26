import { randomUUID } from 'node:crypto';
import {
  assertConfigKey,
  CONFIG_SCOPES,
  type ConfigAuditRecord,
  type ConfigEntryInput,
  type ConfigScope,
  type ConfigValue,
  toConfigValue,
} from '@adonis-agora/config-core';
import { ConfigAdmin, type EntryRow } from '../admin.js';
import {
  deriveKeyPair,
  generateKeyPair,
  type OkpJwk,
  openWith,
  type SecretLike,
  sealTo,
} from '../crypto-kit/index.js';
import {
  CONSOLE_READ,
  CONSOLE_WRITE,
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from '../dashboard/console_capabilities.js';
import { inSchema, type SqlDatabase } from '../sql.js';
import { LucidStore } from '../store/lucid_store.js';
import { type ConfigStore, redactEntry } from '../store/store.js';
import type { TenantTokenSource } from '../topology/token.js';
import {
  appKeyDirectoryOf,
  type ConsoleSiblings,
  resolveFederatedAppAuth,
} from './console_auth.js';
import {
  APP_UNREACHABLE,
  type ConsoleCommand,
  type ConsoleCryptoOptions,
  type ConsoleReply,
  RedisConsoleChannel,
  type RedisLike,
  TOKEN_UNAVAILABLE,
} from './redis_channel.js';

/**
 * The federated config console: one app's console (the Hub's) also shows and manages the
 * configuration of apps that run `@adonis-agora/config` standalone, each with its own store and its
 * own keys. The console reads an app's versions and audit straight from that app's tables, without
 * its keys (secret values and vault references are dropped at the row), and asks the app itself,
 * over Redis, for everything else: writing an entry, rolling back, revealing a secret.
 */

/** One other app shown in this console (`console.federatedApps` in config/config.ts). */
export interface FederatedConfigAppConfig {
  /** The name shown in the App picker. Defaults to the key. */
  label?: string | undefined;
  /** That app's partition in its own store (its `app` in config/config.ts). Defaults to the key. */
  partition?: string | undefined;
  /** The environment the console opens on that app. Defaults to this console's. */
  environment?: string | undefined;
  /**
   * Where that app keeps its configuration: a Lucid connection of THIS app (`config/database.ts`)
   * that reaches that app's `config_versions` and `config_audit` tables, and the schema they live
   * in. Only read, never created or altered: give the connection's role `SELECT` on those two.
   */
  store: { connection?: string | undefined; schema?: string | undefined } | ConfigStore;
  /**
   * Where that app answers (its `consoleCommands` in its config/config.ts): the `@adonisjs/redis`
   * connection to publish on and the app's `prefix`.
   */
  controlPlane:
    | {
        connection?: string | undefined;
        prefix: string;
        /**
         * Shared-secret mode: the secret shared with that app (its `consoleCommands.secret`). Use it
         * when there is no authkit; otherwise prefer `token`.
         */
        secret?: string | { release(): string } | undefined;
        /**
         * Token mode: this console's token for that app. Nothing to set with
         * `@adonis-agora/authkit-client` booted here and that app in its `apps`: an app-call
         * token for it is sent automatically (`false` turns that off). Or e.g. `authkitTenantToken({ issuer,
         * clientId, clientSecret, resource: 'urn:agora:config' })` of a service-tenant client whose
         * `partition` is that app and whose capabilities say what this console may do there
         * (`config:write`, `config:secrets:read`). The app checks it with its
         * `consoleCommands.verifyTenant`. Commands travel sealed to the app's command key, read
         * from the app's store (its `config_tenant_keys`, so the store connection needs SELECT
         * on it too).
         */
        token?: TenantTokenSource | false | undefined;
        /**
         * Sealed with `@adonis-agora/crypto`. Nothing to set where crypto is embedded in this app
         * (the Hub): commands are then encrypted automatically with the `console-config` key in
         * that app's crypto partition (`partition`, which must equal that app's crypto
         * partition), created there when missing. Set it on a tenant of a crypto server (a client
         * that may `encrypt` with that app's key), or `false` to turn the automatic mode off.
         * Combine with `token` when the app also checks one (`consoleCommands.verifyTenant`).
         */
        crypto?: ConsoleCryptoOptions | false | undefined;
      }
    | RedisConsoleChannel;
  /**
   * Send writes (set, unset, rollback) and reveals to that app. Default `true`; `false` makes it
   * read-only from here (browse only: no command authentication needed). The app decides too: its
   * `consoleCommands.actions` / `.reveal`.
   */
  actions?: boolean | undefined;
  /** How long a command waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** What a federated app's key may look like (it travels in the URL as `?app=`). */
export const FEDERATED_APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** A request the console answers with `status` (a refused, failed or unreachable app). */
export class FederatedAppError extends Error {
  readonly status: number;
  /** The owning app's own message, for this app's log (a `502` does not show it to the browser). */
  readonly detail: string | undefined;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'FederatedAppError';
    this.status = status;
    this.detail = detail;
  }
}

/** A command this app does not answer (an unknown verb). Answered `501` by the console. */
export const UNSUPPORTED = 'unsupported-request';

/**
 * Checks one `federatedApps` entry at boot, so a misconfigured app fails the boot instead of the
 * first request that picks it. `redisConnections` are the names in `config/redis.ts` (`undefined`:
 * no Redis config to check against).
 */
export function validateFederatedConfigApp(
  key: string,
  entry: FederatedConfigAppConfig,
  redisConnections: { names: string[]; default: string | undefined } | undefined,
): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/config] console.federatedApps["${key}"]: ${message}`);
  };
  if (!FEDERATED_APP_KEY.test(key)) {
    fail('the key must be 1–64 characters of A-Z, a-z, 0-9, _ . -');
  }
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (!entry.store || typeof entry.store !== 'object') {
    fail('`store` is required ({ connection, schema })');
  }
  if (entry.partition !== undefined && (typeof entry.partition !== 'string' || !entry.partition)) {
    fail('`partition` must be a non-empty string');
  }
  const plane = entry.controlPlane;
  if (!(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` is required ({ connection, prefix })');
    }
    if (typeof plane.prefix !== 'string' || plane.prefix.trim() === '') {
      fail("`controlPlane.prefix` must be the other app's `consoleCommands.prefix` (not empty)");
    }
    if (
      plane.connection !== undefined &&
      (typeof plane.connection !== 'string' || plane.connection === '')
    ) {
      fail('`controlPlane.connection` must be a connection name of config/redis.ts');
    }
    if (!redisConnections) {
      fail('the federated console needs @adonisjs/redis (no config/redis.ts found)');
    } else {
      const name = plane.connection ?? redisConnections.default;
      if (name === undefined || !redisConnections.names.includes(name)) {
        fail(
          `\`controlPlane.connection\` "${name ?? '(default)'}" is not a connection of config/redis.ts (${redisConnections.names.join(', ') || 'none'})`,
        );
      }
    }
  }
  if (
    entry.timeoutMs !== undefined &&
    (typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0)
  ) {
    fail('`timeoutMs` must be a positive number of milliseconds');
  }
}

async function readOnly(): Promise<never> {
  throw new FederatedAppError(
    "another app's configuration is changed through that app, not written here",
    501,
  );
}

function redactAudit(row: ConfigAuditRecord): ConfigAuditRecord {
  return {
    ...row,
    ...(row.before ? { before: redactEntry(row.before) } : {}),
    ...(row.after ? { after: redactEntry(row.after) } : {}),
  };
}

/**
 * Another app's store as the console may touch it: reads only, and every secret value and vault
 * reference dropped from what comes back (a second line behind the `redact` Lucid store, for a
 * store passed in by hand). Every write throws.
 */
export function readOnlyConfigStore(store: ConfigStore): ConfigStore {
  const redact = <
    T extends {
      entries: Record<string, import('@adonis-agora/config-core').ConfigEntryState>;
    } | null,
  >(
    document: T,
  ): T =>
    document === null
      ? document
      : ({
          ...document,
          entries: Object.fromEntries(
            Object.entries(document.entries).map(([key, entry]) => [key, redactEntry(entry)]),
          ),
        } as T);
  return {
    read: async (scope) => redact(await store.read(scope)),
    readVersion: async (scope, version) => redact(await store.readVersion(scope, version)),
    listVersions: (scope, page) => store.listVersions(scope, page),
    listScopes: () => store.listScopes(),
    listAudit: async (scope, page, filters) => {
      const result = await store.listAudit(scope, page, filters);
      return { ...result, rows: result.rows.map(redactAudit) };
    },
    ...(store.seekAudit
      ? {
          seekAudit: async (
            scope: ConfigScope,
            query: Parameters<NonNullable<ConfigStore['seekAudit']>>[1],
          ) => (await store.seekAudit!(scope, query)).map(redactAudit),
        }
      : {}),
    ...(store.seekVersions ? { seekVersions: store.seekVersions.bind(store) } : {}),
    write: readOnly,
    rollback: readOnly,
    recordReveal: readOnly,
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The owning app: answering commands                                                          */
/* ------------------------------------------------------------------------------------------- */

/** The commands that change the configuration: run only when the owning app sets `actions`. */
export const ACTION_VERBS = ['setEntry', 'unsetEntry', 'rollback'] as const;
/** The command that reads one secret value: run only when the owning app sets `reveal`. */
export const REVEAL_VERB = 'reveal';
/** The command that hands out the public key writes are sealed to. */
export const WRITE_KEY_VERB = 'writeKey';

export type ConfigConsoleVerb = (typeof ACTION_VERBS)[number] | 'reveal' | 'writeKey';

const ACTIONS: ReadonlySet<string> = new Set(ACTION_VERBS);

/**
 * The X25519 key pair an app's console commands are sealed to: derived from the app's key, so
 * every instance holds the same one and nothing is stored. A value written from another console
 * crosses Redis sealed to it, never in clear.
 */
export function consoleCommandKeys(
  appKey: SecretLike,
  prefix: string,
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  return deriveKeyPair('x25519', appKey, `config:console-commands:${prefix}`);
}

/**
 * The name an app publishes its console-command public key under, in its own store's tenant keys
 * (token mode). A console reads it from that store (which it already reads, and which Redis cannot
 * touch), so it never seals a token to a key handed out over Redis.
 */
export function consoleKeyOwner(prefix: string): string {
  return `@console-commands:${prefix}`;
}

/** The AAD that binds a sealed write to the entry it is for. */
export function writeAad(prefix: string, scope: ConfigScope, key: string): string {
  return JSON.stringify([
    'config-console:write',
    prefix,
    scope.app,
    scope.environment,
    scope.label,
    key,
  ]);
}

/** The AAD that binds a revealed value to the entry it came from. */
export function revealAad(prefix: string, scope: ConfigScope, key: string): string {
  return JSON.stringify([
    'config-console:reveal',
    prefix,
    scope.app,
    scope.environment,
    scope.label,
    key,
  ]);
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CommandError(`config: ${name} is required`, 400);
  }
  return value;
}

function optionalMessage(value: unknown): { message?: string } {
  return typeof value === 'string' && value !== '' ? { message: value.slice(0, 500) } : {};
}

export interface ConsoleCommandHandlerOptions {
  /** This app's admin (its own store, its keys, its audit). */
  admin: ConfigAdmin;
  /** This app's `consoleCommands.prefix`. */
  prefix: string;
  /** Run set/unset/rollback. */
  actions: boolean;
  /** Answer reveals (each one audited, with the other console's viewer as the actor). */
  reveal: boolean;
  /** The partitions the other console may touch (`undefined`: any of this store's). */
  partitions?: readonly string[] | undefined;
  /** The key writes are sealed to (`undefined`: this app has no app key, so it takes no writes). */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk } | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * Run the commands another app's federated console sends this app, against this app's own
 * {@link ConfigAdmin}: the version, the audit row and the change event are this app's own, with the
 * other console's viewer as the actor.
 */
export function configConsoleCommandHandler(
  options: ConsoleCommandHandlerOptions,
): (command: ConsoleCommand) => Promise<unknown> {
  const scopeOf = (value: unknown): ConfigScope => {
    const raw = (value ?? {}) as Record<string, unknown>;
    const scope = {
      app: text(raw.app, 'app'),
      environment: text(raw.environment, 'environment'),
      label: text(raw.label, 'label'),
    };
    if (options.partitions !== undefined && !options.partitions.includes(scope.app)) {
      throw new CommandError(
        `config: this app does not serve "${scope.app}" to other consoles`,
        403,
      );
    }
    return scope;
  };
  return async (command) => {
    const { verb } = command;
    // Order (SECURITY-UNIFORM-SPEC §10.18): verb known → capabilities present → token → viewer →
    // partition / actions.
    if (verb !== WRITE_KEY_VERB && verb !== REVEAL_VERB && !ACTIONS.has(verb)) {
      throw Object.assign(
        new Error(`this app does not answer the config console command ${verb}`),
        { code: UNSUPPORTED },
      );
    }
    // The console always says what its viewer may do; a command without it is refused, never
    // taken as "everything".
    if (!Array.isArray(command.capabilities)) {
      throw new CommandError(
        "config: the console sent no capabilities for its viewer; update the console's @adonis-agora/config",
        403,
        'capabilities-required',
      );
    }
    const capabilities = command.capabilities;
    const actor =
      typeof command.actor === 'string' && command.actor !== '' ? command.actor : 'console';
    const via =
      command.verified?.appCall === true
        ? ` via ${command.verified.partition}`
        : typeof command.via === 'string' && command.via !== ''
          ? ` via ${command.via}`
          : '';
    // Token mode: the console's token (verified by the channel) says which app it may act on and
    // what it may do; the viewer's capabilities the console sends can only narrow that.
    const verified = command.verified;
    // `config:console:*` / `:read` / `:write` are aliases of the finer names, on both sides.
    const tokenAllows = (capability: string): boolean =>
      !verified || configConsoleAllows(verified.capabilities, capability);
    /** Refuses unless both the viewer and the token (when there is one) allow `capability`. */
    const demand = (capability: string): void => {
      if (!tokenAllows(capability)) {
        throw new CommandError(`the console's token lacks ${capability}`, 403);
      }
      if (!configConsoleAllows(capabilities, capability)) {
        throw new CommandError(`the viewer lacks ${capability}`, 403);
      }
    };
    const targetOf = (value: unknown): ConfigScope => {
      const scope = scopeOf(value);
      // A tenant token names the app it is for. An authkit app-call token is bound to this app by
      // its audience, and its partition is the console's app: no partition rule for it.
      if (verified && !verified.appCall && verified.partition !== scope.app) {
        throw new CommandError(
          `config: the console's token is for "${verified.partition}", not "${scope.app}"`,
          403,
        );
      }
      return scope;
    };
    if (verb === WRITE_KEY_VERB) {
      demand(CONFIG_SCOPES.write);
      if (!options.actions || !options.keys) return null;
      return options.keys.publicKey;
    }
    if (verb === REVEAL_VERB) {
      demand(CONFIG_SCOPES.secretsRead);
      if (!options.reveal) {
        throw new CommandError(
          'this app does not reveal secrets to another console (consoleCommands.reveal is off)',
          403,
        );
      }
      const body = (command.args[0] ?? {}) as Record<string, unknown>;
      const scope = targetOf(body.scope);
      const key = text(body.key, 'key');
      const recipient = body.recipient as OkpJwk | undefined;
      if (
        recipient?.kty !== 'OKP' ||
        recipient.crv !== 'X25519' ||
        typeof recipient.x !== 'string'
      ) {
        throw new CommandError('config: a reveal needs the X25519 key to seal the value to', 400);
      }
      if ('d' in recipient) throw new CommandError('config: send the public key only', 400);
      options.log?.(
        `[config] federated console: reveal ${scope.app}/${scope.environment}/${key} by ${actor}${via}`,
      );
      const entry = await options.admin.getEntry(scope, key, {
        canReadSecrets: true,
        reveal: { actor },
      });
      if (!entry) throw new CommandError(`no entry "${key}"`, 404);
      const { value, ...rest } = entry;
      if (value === undefined || entry.masked) return { ...rest, masked: true };
      return {
        ...rest,
        masked: false,
        sealedValue: sealTo(recipient, JSON.stringify(value), {
          aad: revealAad(options.prefix, scope, key),
        }),
      };
    }
    demand(CONFIG_SCOPES.write);
    if (!options.actions) {
      throw new CommandError(
        'this app does not take changes from another console (consoleCommands.actions is off)',
        403,
      );
    }
    const body = (command.args[0] ?? {}) as Record<string, unknown>;
    const scope = targetOf(body.scope);
    if (verb === 'rollback') {
      const to = Number(body.to);
      if (!Number.isInteger(to) || to < 1)
        throw new CommandError('to must be a version number', 400);
      options.log?.(
        `[config] federated console: rollback ${scope.app}/${scope.environment} to v${to} by ${actor}${via}`,
      );
      return options.admin.rollback(scope, to, { actor, ...optionalMessage(body.message) });
    }
    const key = text(body.key, 'key');
    assertConfigKey(key);
    if (verb === 'unsetEntry') {
      options.log?.(
        `[config] federated console: unset ${scope.app}/${scope.environment}/${key} by ${actor}${via}`,
      );
      return options.admin.unsetEntry(scope, key, { actor, ...optionalMessage(body.message) });
    }
    // setEntry: the value travels sealed to this app's command key.
    const input: Omit<ConfigEntryInput, 'key'> = {};
    if (body.sealed !== undefined) {
      if (!options.keys) {
        throw new CommandError(
          'this app has no app key, so it cannot open a value sent to it',
          409,
        );
      }
      let payload: { value?: unknown; vault?: unknown };
      try {
        payload = JSON.parse(
          openWith(options.keys.privateKey, String(body.sealed), {
            aad: writeAad(options.prefix, scope, key),
          }),
        ) as typeof payload;
      } catch {
        throw new CommandError('config: the value sent did not open (wrong key or entry)', 400);
      }
      if (payload.value !== undefined) input.value = toConfigValue(payload.value) as ConfigValue;
      if (payload.vault !== undefined) {
        if (typeof payload.vault !== 'string' || !payload.vault.startsWith('vault://')) {
          throw new CommandError('vault must be a vault:// reference', 400);
        }
        input.vault = payload.vault;
      }
    }
    if (input.value === undefined && input.vault === undefined) {
      throw new CommandError('value or vault is required (a PUT is an upsert, not an unset)', 400);
    }
    for (const flag of ['secret', 'sealedTo', 'reloadable', 'browser'] as const) {
      if (body[flag] === undefined) continue;
      if (typeof body[flag] !== 'boolean') throw new CommandError(`${flag} must be a boolean`, 400);
      input[flag] = body[flag] as boolean;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw new CommandError('description must be a string or null', 400);
      }
      input.description = body.description as string | null;
    }
    options.log?.(
      `[config] federated console: set ${scope.app}/${scope.environment}/${key} by ${actor}${via}`,
    );
    return options.admin.setEntry(scope, key, input, { actor, ...optionalMessage(body.message) });
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The console: another app as it sees it                                                      */
/* ------------------------------------------------------------------------------------------- */

/** How long the console keeps an app's write key before asking again. */
const WRITE_KEY_TTL_MS = 10 * 60_000;

/**
 * Config's console capabilities for the canonical matcher: `config:console:read` covers
 * `config:read`, `config:console:write` covers `config:read` and `config:write`.
 * `config:secrets:read` is in neither (sensitive): only an exact grant, `config:secrets:*`,
 * `config:console:*`, `config:*` or `*` allows a reveal.
 */
export const CONFIG_CONSOLE_TABLE: ConsoleCapabilityTable = {
  [CONFIG_SCOPES.read]: 'read',
  [CONFIG_SCOPES.write]: 'write',
};

/** Every console-capability check of config: the canonical matcher with config's table. */
export function configConsoleAllows(granted: readonly unknown[] | undefined, required: string) {
  return consoleCapabilityAllows(granted, required, CONFIG_CONSOLE_TABLE);
}

/**
 * What the console's viewer may do on another app when its `authorize` does not narrow it: every
 * config console capability. The owning app still decides (`actions`, `reveal`, a token's grant).
 */
export const CONFIG_CONSOLE_CAPABILITIES: readonly string[] = [
  CONFIG_SCOPES.read,
  CONFIG_SCOPES.write,
  CONFIG_SCOPES.secretsRead,
];

/** What reaches config's console set: the names and their `config:console:*` aliases. */
const CONSOLE_SET: readonly string[] = [
  ...CONFIG_CONSOLE_CAPABILITIES,
  CONSOLE_READ,
  CONSOLE_WRITE,
];

/**
 * The capabilities the console sends for a viewer: those of its `authorize` that reach config's
 * console set (anything else, `flags:write` say, is dropped), or the full set when `authorize`
 * returned none. `access: 'read'` keeps only the reads (`config:read`, `config:secrets:read`).
 */
export function viewerConsoleCapabilities(
  granted: readonly string[] | undefined,
  access?: 'read' | 'write' | undefined,
): string[] {
  const narrowed =
    granted === undefined
      ? [...CONFIG_CONSOLE_CAPABILITIES]
      : granted.filter(
          (c) => typeof c === 'string' && CONSOLE_SET.some((x) => configConsoleAllows([c], x)),
        );
  if (access !== 'read') return narrowed;
  return [CONFIG_SCOPES.read, CONFIG_SCOPES.secretsRead].filter((c) =>
    configConsoleAllows(narrowed, c),
  );
}

/** What the console sends with a command, besides its arguments. */
export interface CommandMeta {
  actor: string;
  /** The viewer's capabilities (always sent: the owning app refuses a command without them). */
  capabilities: string[];
  via?: string | undefined;
}

/**
 * Another app as the console sees it: its store (read-only, secrets dropped) through an admin of
 * its own, and its command channel for everything that writes or reveals. Built once per app.
 */
export class FederatedConfigApp {
  readonly id: string;
  readonly label: string;
  readonly partition: string;
  readonly environment: string | undefined;
  readonly actions: boolean;
  /** Reads only: listing, versions, diff and audit, all masked. */
  readonly admin: ConfigAdmin;
  readonly channel: ConsoleCommandSender;
  readonly timeoutMs: number | undefined;
  #writeKey: { key: OkpJwk | null; at: number } | undefined;

  constructor(options: {
    id: string;
    label?: string | undefined;
    partition?: string | undefined;
    environment?: string | undefined;
    actions?: boolean | undefined;
    store: ConfigStore;
    channel: ConsoleCommandSender;
    timeoutMs?: number | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.partition = options.partition ?? options.id;
    this.environment = options.environment;
    this.actions = options.actions !== false;
    this.admin = new ConfigAdmin({
      store: readOnlyConfigStore(options.store),
      canRevealSecrets: false,
    });
    this.channel = options.channel;
    this.timeoutMs = options.timeoutMs;
  }

  /** Send `verb` to the app and return its answer; errors become the console's HTTP answers. */
  async send(verb: ConfigConsoleVerb, args: unknown[], meta: CommandMeta): Promise<unknown> {
    let reply: Awaited<ReturnType<RedisConsoleChannel['send']>>;
    try {
      reply = await this.channel.send(
        {
          id: randomUUID(),
          verb,
          args,
          actor: meta.actor,
          capabilities: Array.isArray(meta.capabilities)
            ? meta.capabilities.filter((c) => typeof c === 'string')
            : [],
          ...(meta.via !== undefined ? { via: meta.via } : {}),
        },
        this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FederatedAppError(`${this.label}: ${message}`, 503);
    }
    if (reply.ok) return reply.data;
    const { message, code, status } = reply.error;
    if (code === APP_UNREACHABLE) throw new FederatedAppError(`${this.label}: ${message}`, 503);
    if (code === UNSUPPORTED) throw new FederatedAppError(message, 501);
    // The app's own answer to a bad request (unknown entry, bad value, actions off…) stands.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      throw new FederatedAppError(message, status);
    }
    if (message.startsWith('config:')) throw new FederatedAppError(message, 400);
    throw new FederatedAppError(`the ${this.label} app answered with an error`, 502, message);
  }

  #assertActions(): void {
    if (!this.actions) {
      throw new FederatedAppError(`${this.label} is read-only in this console`, 403);
    }
  }

  /** The key a write to this app is sealed to (cached for a few minutes). */
  async writeKey(meta: CommandMeta): Promise<OkpJwk> {
    const cached = this.#writeKey;
    let key = cached && Date.now() - cached.at < WRITE_KEY_TTL_MS ? cached.key : undefined;
    if (key === undefined) {
      const answer = (await this.send('writeKey', [], meta)) as OkpJwk | null;
      key =
        answer?.kty === 'OKP' && answer.crv === 'X25519' && typeof answer.x === 'string'
          ? answer
          : null;
      this.#writeKey = { key, at: Date.now() };
    }
    if (key === null) {
      throw new FederatedAppError(
        `${this.label} takes no changes from another console (its consoleCommands.actions is off, or it has no app key)`,
        403,
      );
    }
    return key;
  }

  async setEntry(
    scope: ConfigScope,
    key: string,
    input: Omit<ConfigEntryInput, 'key'> & { message?: string | undefined },
    meta: CommandMeta,
  ): Promise<{ version: number; changed: boolean }> {
    this.#assertActions();
    const recipient = await this.writeKey(meta);
    const prefix = this.channel.prefix;
    const sealed = sealTo(
      recipient,
      JSON.stringify({
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.vault !== undefined ? { vault: input.vault } : {}),
      }),
      { aad: writeAad(prefix, scope, key) },
    );
    return (await this.send(
      'setEntry',
      [
        {
          scope,
          key,
          sealed,
          ...(input.secret !== undefined ? { secret: input.secret } : {}),
          ...(typeof input.sealedTo === 'boolean' ? { sealedTo: input.sealedTo } : {}),
          ...(input.reloadable !== undefined ? { reloadable: input.reloadable } : {}),
          ...(input.browser !== undefined ? { browser: input.browser } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
        },
      ],
      meta,
    )) as { version: number; changed: boolean };
  }

  async unsetEntry(
    scope: ConfigScope,
    key: string,
    message: string | undefined,
    meta: CommandMeta,
  ): Promise<{ version: number; changed: boolean }> {
    this.#assertActions();
    return (await this.send(
      'unsetEntry',
      [{ scope, key, ...(message !== undefined ? { message } : {}) }],
      meta,
    )) as { version: number; changed: boolean };
  }

  async rollback(
    scope: ConfigScope,
    to: number,
    message: string | undefined,
    meta: CommandMeta,
  ): Promise<{ version: number; changed: boolean }> {
    this.#assertActions();
    return (await this.send(
      'rollback',
      [{ scope, to, ...(message !== undefined ? { message } : {}) }],
      meta,
    )) as { version: number; changed: boolean };
  }

  /**
   * One secret value, read and audited by the app itself. It comes back sealed to a key made for
   * this one request, so it never crosses Redis in clear; only this process opens it.
   */
  async reveal(scope: ConfigScope, key: string, meta: CommandMeta): Promise<EntryRow> {
    this.#assertActions();
    const ephemeral = generateKeyPair('x25519');
    const answer = (await this.send(
      'reveal',
      [{ scope, key, recipient: ephemeral.publicKey }],
      meta,
    )) as (EntryRow & { sealedValue?: string }) | null;
    if (!answer || typeof answer !== 'object')
      throw new FederatedAppError(`no entry "${key}"`, 404);
    const { sealedValue, ...entry } = answer;
    if (typeof sealedValue !== 'string') return { ...entry, masked: true };
    let value: ConfigValue;
    try {
      value = JSON.parse(
        openWith(ephemeral.privateKey, sealedValue, {
          aad: revealAad(this.channel.prefix, scope, key),
        }),
      ) as ConfigValue;
    } catch {
      throw new FederatedAppError(`${this.label} answered a reveal this console cannot open`, 502);
    }
    return { ...entry, value, masked: false };
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

/** What sends commands to one app: a channel, or a choice between two (§13a). */
export type ConsoleCommandSender = Pick<RedisConsoleChannel, 'prefix' | 'send' | 'close'>;

/**
 * A token minting error that only means "authkit has no grant for this app yet" (§13b: info, not
 * warn): code `invalid_target`, or a message with `invalid_target`, "not granted" or "no grant"
 * (any case). Nothing else
 * (`unauthorized_client`, `invalid_client`, authkit down) is.
 */
export function isMissingGrant(error: unknown, reason: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'invalid_target' || /invalid_target|not granted|no grant/i.test(reason);
}

/** How long a console keeps its per-app mode decision before deciding again (§13a). */
const MODE_DECISION_TTL_MS = 5 * 60_000;

/**
 * §13a: token mode when the app publishes its command key (its store, else authkit's key
 * directory: the app publishes only when token mode is how it is reached), else crypto. Decided at
 * the first command, kept 5 minutes, and decided again after a command nobody answered (an app
 * that refused the mode drops the command).
 */
export class AutoModeChannel implements ConsoleCommandSender {
  readonly prefix: string;
  #decision: { channel: RedisConsoleChannel; at: number } | undefined;
  constructor(
    readonly token: RedisConsoleChannel,
    readonly crypto: RedisConsoleChannel,
    readonly published: () => Promise<unknown>,
    /** Called when a token that cannot be minted sends a command by crypto instead (§13b). */
    readonly onTokenUnavailable?: ((reason: string, error?: unknown) => void) | undefined,
  ) {
    this.prefix = crypto.prefix;
  }

  /** The channel the next command goes through. */
  async current(): Promise<RedisConsoleChannel> {
    const decided = this.#decision;
    if (decided && Date.now() - decided.at < MODE_DECISION_TTL_MS) return decided.channel;
    let channel = this.crypto;
    try {
      await this.published();
      channel = this.token;
    } catch {
      // not published: crypto
    }
    this.#decision = { channel, at: Date.now() };
    return channel;
  }

  async send(
    command: ConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<ConsoleReply> {
    const channel = await this.current();
    try {
      return await channel.send(command, options);
    } catch (error) {
      // Token mode, but the token cannot be minted (no grant, authkit down): crypto reaches the app
      // too, so this command (and the next ones, for a while) goes that way instead (§13b).
      if (channel === this.token && (error as { code?: unknown }).code === TOKEN_UNAVAILABLE) {
        const reason = (error as { reason?: unknown }).reason;
        try {
          this.onTokenUnavailable?.(
            typeof reason === 'string' ? reason : String(error),
            (error as { cause?: unknown }).cause,
          );
        } catch {
          // a logger that throws must not block the command
        }
        this.#decision = { channel: this.crypto, at: Date.now() };
        return this.crypto.send(command, options);
      }
      // Any other failure (a timeout: an app that refused the mode drops the command) decides again.
      this.#decision = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.token.close(), this.crypto.close()]);
  }
}

/** Build one configured app: its store (read-only, secrets dropped) and its command channel. */
export async function buildFederatedConfigApp(
  id: string,
  config: FederatedConfigAppConfig,
  deps: {
    /** A Lucid query client for `connection` (this app's `config/database.ts`). */
    db(connection?: string): Promise<SqlDatabase>;
    /** The Redis client for `connection` (this app's `config/redis.ts`). */
    redis(connection?: string): Promise<RedisLike>;
    /** `@adonis-agora/crypto` / authkit-client booted in this app, for the automatic modes. */
    siblings?: ConsoleSiblings | undefined;
    /** For the console's notes (a command sent without its optional token, §13b). */
    logger?: { warn(message: string): void; info?(message: string): void } | undefined;
  },
): Promise<FederatedConfigApp> {
  const spec = config.store as { connection?: string; schema?: string } | ConfigStore;
  const store: ConfigStore =
    typeof (spec as ConfigStore).read === 'function'
      ? (spec as ConfigStore)
      : new LucidStore(
          inSchema(
            await deps.db((spec as { connection?: string }).connection),
            (spec as { schema?: string }).schema,
          ),
          {
            autoCreateSchema: false,
            secrets: 'redact',
          },
        );
  let channel: ConsoleCommandSender;
  if (config.controlPlane instanceof RedisConsoleChannel) {
    channel = config.controlPlane;
  } else {
    const plane = config.controlPlane;
    const auth = resolveFederatedAppAuth({
      id,
      partition: config.partition ?? id,
      actions: config.actions !== false,
      controlPlane: plane,
      siblings: deps.siblings,
    });
    const client = await deps.redis(plane.connection);
    // One warning per reason, whichever path found the token missing (§13b).
    const warned = new Set<string>();
    const tokenOptions = auth.tokenHint
      ? {
          hint: auth.tokenHint,
          onSkipped: (reason: string, error?: unknown) => {
            if (warned.has(reason)) return;
            if (warned.size < 100) warned.add(reason);
            const line = `[@adonis-agora/config] console commands to "${id}": sending without an authkit app-call token (crypto only): ${reason}. ${auth.tokenHint}`;
            // A grant not given yet is a choice, not a fault: info. Anything else (authkit down): warn.
            if (isMissingGrant(error, reason)) deps.logger?.info?.(line);
            else deps.logger?.warn(line);
          },
        }
      : undefined;
    // The app's APP_KEY-derived key: its store first, else authkit's key directory.
    const recipient = commandKeyReader(
      store,
      plane.prefix,
      appKeyDirectoryOf(deps.siblings?.authkit, config.partition ?? id),
    );
    const base = {
      client,
      prefix: plane.prefix,
      ...(auth.secret !== undefined ? { secret: auth.secret } : {}),
      ...(auth.token !== undefined ? { token: auth.token } : {}),
      ...(tokenOptions ? { tokenOptions } : {}),
    };
    if (auth.autoChoice && auth.crypto && auth.token !== undefined) {
      channel = new AutoModeChannel(
        new RedisConsoleChannel({ ...base, recipient }),
        new RedisConsoleChannel({ ...base, crypto: auth.crypto }),
        recipient,
        tokenOptions?.onSkipped,
      );
    } else {
      channel = new RedisConsoleChannel({
        ...base,
        ...(auth.crypto ? { crypto: auth.crypto } : {}),
        ...(auth.token !== undefined && !auth.crypto ? { recipient } : {}),
      });
    }
  }
  return new FederatedConfigApp({
    id,
    label: config.label,
    partition: config.partition,
    environment: config.environment,
    actions: config.actions,
    store,
    channel,
    timeoutMs: config.timeoutMs,
  });
}

/** How long a console trusts the command key it read from an app's store before reading again. */
const COMMAND_KEY_TTL_MS = 5 * 60_000;

/** The purpose an app publishes its console-command key under in authkit's key directory. */
export const CONSOLE_KEY_PURPOSE = 'console:config';

/**
 * Reads the app's active console-command key (token mode) from its own store, a channel Redis
 * cannot touch. When the store cannot answer (no SELECT on `config_tenant_keys`, nothing
 * published there) and authkit's key directory is at hand (`fallback`: `appKey({ app, purpose:
 * 'console:config' })`), the key comes from there instead. Cached for a few minutes; a key
 * rotation (a new APP_KEY) is picked up after that.
 */
export function commandKeyReader(
  store: ConfigStore,
  prefix: string,
  fallback?: (() => Promise<OkpJwk | null>) | undefined,
): () => Promise<OkpJwk> {
  let cached: { key: OkpJwk; at: number } | undefined;
  const fromStore = async (): Promise<OkpJwk | undefined> => {
    if (!store.listTenantKeys) {
      throw new Error("config: this store cannot read the app's console-command key");
    }
    const keys = await store.listTenantKeys(consoleKeyOwner(prefix));
    return (keys.find((key) => key.active) ?? keys[0])?.publicKey;
  };
  return async () => {
    if (cached && Date.now() - cached.at < COMMAND_KEY_TTL_MS) return cached.key;
    let key: OkpJwk | undefined;
    let failure: unknown;
    try {
      key = await fromStore();
    } catch (error) {
      failure = error;
    }
    if (!key && fallback) {
      const published = await fallback();
      if (published?.kty === 'OKP' && published.crv === 'X25519' && !('d' in published)) {
        key = published;
      }
    }
    if (!key) {
      if (failure && !fallback) throw failure;
      throw new Error(
        `config: the "${prefix}" app has not published its console-command key yet (is it up, with consoleCommands.verifyTenant and an APP_KEY?)`,
      );
    }
    cached = { key, at: Date.now() };
    return key;
  };
}

/** The configured other apps of one console, each built once on first use. */
export class FederatedConfigApps {
  readonly #specs: Record<string, FederatedConfigAppConfig>;
  readonly #deps: Parameters<typeof buildFederatedConfigApp>[2];
  readonly #built = new Map<string, Promise<FederatedConfigApp>>();

  constructor(
    specs: Record<string, FederatedConfigAppConfig>,
    deps: Parameters<typeof buildFederatedConfigApp>[2],
  ) {
    this.#specs = specs;
    this.#deps = deps;
  }

  /** The configured keys, in config order. */
  get ids(): string[] {
    return Object.keys(this.#specs);
  }

  has(id: string): boolean {
    return Object.hasOwn(this.#specs, id);
  }

  /** What the App picker lists for `id`. */
  describe(id: string): {
    id: string;
    label: string;
    mode: 'federated';
    actions: 'app' | 'none';
    environment?: string;
  } {
    const spec = this.#specs[id];
    return {
      id,
      label: spec?.label ?? id,
      mode: 'federated',
      actions: spec?.actions === false ? 'none' : 'app',
      ...(spec?.environment !== undefined ? { environment: spec.environment } : {}),
    };
  }

  get(id: string): Promise<FederatedConfigApp> {
    let app = this.#built.get(id);
    if (!app) {
      const spec = this.#specs[id];
      if (!spec) return Promise.reject(new FederatedAppError('unknown app', 404));
      app = buildFederatedConfigApp(id, spec, this.#deps).catch((error: unknown) => {
        throw new FederatedAppError(
          `${spec.label ?? id}: the console could not reach this app`,
          503,
          error instanceof Error ? error.message : String(error),
        );
      });
      // A failed build (a bad connection name) is retried on the next request, not cached.
      app.catch(() => this.#built.delete(id));
      this.#built.set(id, app);
    }
    return app;
  }

  async close(): Promise<void> {
    const apps = [...this.#built.values()];
    this.#built.clear();
    await Promise.all(apps.map((app) => app.then((a) => a.close()).catch(() => undefined)));
  }
}
