import type { OkpJwk } from '../crypto-kit/index.js';
import type { TenantTokenSource } from '../topology/token.js';
import type { TenantVerifierInput } from '../topology/verify.js';
import {
  type AppCallVerifier,
  type ChannelSecret,
  CONSOLE_CRYPTO_KEY,
  type CommandTokenRule,
  type ConsoleCipher,
  type ConsoleCipherSource,
  type ConsoleCryptoOptions,
} from './redis_channel.js';

/**
 * How each side of the federated console authenticates its commands, resolved once at boot: the
 * explicit options of `config/config.ts` when there are any, else what the sibling libs booted in
 * the same app already configured — `@adonis-agora/crypto` (`'agora.crypto'`: commands sealed with
 * the `console-config` key) and `@adonis-agora/authkit-client` (`'authkit.client'`: an app-call
 * token on each command). Both are detected structurally, never imported. With nothing to resolve,
 * the boot fails with a message that says which line to add.
 */

const PACKAGE = '@adonis-agora/config';

/** Who creates the console key and encrypts commands with it, in crypto's audit. */
const ACTOR = 'config:console';

interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}

/** What config needs from an `@adonis-agora/crypto` service (embedded in this app). */
export interface CryptoServiceLike {
  encrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; plaintext: string; aad?: string },
  ): Promise<{ ciphertext: string }>;
  decrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; ciphertext: string; aad?: string },
  ): Promise<{ plaintext: string }>;
  createKey(
    principal: CryptoPrincipalLike,
    input: { name: string; type: 'aes256-gcm'; description?: string },
  ): Promise<unknown>;
  store: { getKey(partition: string, name: string): Promise<unknown> };
}

/** This app's crypto calls (in-process, or to its crypto server through its configured channel). */
export interface CryptoOperationsLike {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
    /** Seal with another partition's key (crypto tenant; needs `crypto:seal:<key>`). */
    partition?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
  createKey?(input: { name: string; type: 'aes256-gcm'; description?: string }): Promise<unknown>;
  /**
   * Whether this app's partition has `key` (newer crypto servers): same auth as `decrypt` on its
   * own partition, never audited as an error. Preferred to the dummy-decrypt probe (§13f).
   */
  hasKey?(input: { key: string }): Promise<boolean>;
}

/** The `'agora.crypto'` binding of `@adonis-agora/crypto`, as far as config uses it. */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** This app's crypto partition (its app name, or its partition on a crypto tenant). */
  partition: string;
  /** Set where crypto is embedded in this app (standalone, control plane). */
  service?: CryptoServiceLike | undefined;
  operations: CryptoOperationsLike;
}

/** The `'authkit.client'` binding of `@adonis-agora/authkit-client`, as far as config uses it. */
export interface AuthkitClientLike {
  /** Tokens for calls to other apps (its `apps` config), or `undefined` without one. */
  appCallTokens?(): { token(app: string): Promise<string>; reset?(): void } | undefined;
  /** Publishes one of this app's public keys in authkit's key directory (background, retried). */
  publishAppKey?(input: { purpose: string; jwk: Record<string, unknown> }): Promise<void>;
  /** Another app's public key for `purpose`, from authkit's key directory (cached). */
  appKey?(input: {
    app: string;
    purpose: string;
  }): Promise<{ kty: string; crv: string; x: string; kid?: string } | null>;
  /** Verifies app-call tokens addressed to this app (its `service` config), or `null`. */
  appCallerVerifier?(): {
    verifyToken(token: string): Promise<{
      app: string;
      capabilities: string[];
      clientId: string;
      expiresAt?: number;
    } | null>;
  } | null;
}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

async function binding(container: unknown, name: string, lib: string): Promise<unknown> {
  const c = container as ContainerLike;
  if (typeof c?.hasBinding !== 'function' || !c.hasBinding(name)) return undefined;
  try {
    return await c.make(name);
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] ${lib} is installed but did not boot, so console commands cannot use it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `@adonis-agora/crypto`'s runtime when it is booted in this app, else `undefined`. */
export async function cryptoRuntimeOf(container: unknown): Promise<CryptoRuntimeLike | undefined> {
  const runtime = (await binding(container, 'agora.crypto', '@adonis-agora/crypto')) as
    | CryptoRuntimeLike
    | undefined;
  if (
    !runtime ||
    typeof runtime.partition !== 'string' ||
    typeof runtime.operations?.encrypt !== 'function' ||
    typeof runtime.operations?.decrypt !== 'function'
  ) {
    return undefined;
  }
  return runtime;
}

/** `@adonis-agora/authkit-client`'s manager when it is booted in this app, else `undefined`. */
export async function authkitClientOf(container: unknown): Promise<AuthkitClientLike | undefined> {
  const client = (await binding(container, 'authkit.client', '@adonis-agora/authkit-client')) as
    | AuthkitClientLike
    | undefined;
  return client && typeof client === 'object' ? client : undefined;
}

/** The siblings this app booted with (each `undefined` when absent). */
export interface ConsoleSiblings {
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
}

export async function consoleSiblingsOf(container: unknown): Promise<ConsoleSiblings> {
  const [crypto, authkit] = await Promise.all([
    cryptoRuntimeOf(container),
    authkitClientOf(container),
  ]);
  return { crypto, authkit };
}

/**
 * Creates the `aes256-gcm` console key in `partition` unless it exists (crypto embedded here).
 * Idempotent across instances: a create that loses the race finds the key on the second look.
 */
export async function ensureConsoleKey(
  service: CryptoServiceLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'exists' | 'created'> {
  if (await service.store.getKey(partition, key)) return 'exists';
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: ACTOR },
      {
        name: key,
        type: 'aes256-gcm',
        description: `${PACKAGE}: seals the federated console's commands to this app`,
      },
    );
    return 'created';
  } catch (error) {
    if (await service.store.getKey(partition, key)) return 'exists';
    throw error;
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/* ------------------------------------------------------------------------------------------- */
/* App side on a crypto tenant: is the console key there, and usable?                          */
/*                                                                                             */
/* Self-contained on purpose: every Agora lib ports this block as is (only PACKAGE and the     */
/* key default differ). Rules (SECURITY-UNIFORM-SPEC §10.7, §10.14):                           */
/* - ask `operations.hasKey({ key })` when crypto offers it (no audit noise); else probe with a */
/*   dummy decrypt, which an app may always do on its own console keys; never getKey (it needs */
/*   crypto:keys:read);                                                                        */
/* - only "not found" means missing: try to create it (servers with provisioning off), else     */
/*   one INFO line (the crypto server provisions console-* keys on the console's first seal);  */
/* - any other failure (forbidden, unauthenticated, server down) logs one WARN line: never     */
/*   silent, never a boot failure;                                                             */
/* - checked once at boot; after a warning, the next command's own decrypt is the retry (its  */
/*   error is classified the same way), so a command never makes two failing calls.          */
/* ------------------------------------------------------------------------------------------- */

/** What one decrypt failure says about the key. */
export type ConsoleKeyOutcome = 'missing' | 'usable' | 'refused' | 'unreachable';

/**
 * Classifies a decrypt error from @adonis-agora/crypto (its `CryptoError` / client error carry a
 * `code`; the message is the fallback for other clients). `usable`: the key exists and this app
 * may decrypt with it (only the dummy ciphertext was rejected).
 */
export function classifyConsoleKeyError(error: unknown): ConsoleKeyOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorText(error);
  if (code === 'not_found' || /no key named|not[ _]found/i.test(text)) return 'missing';
  if (code === 'invalid' || code === 'unreadable') return 'usable';
  if (
    code === 'forbidden' ||
    code === 'unauthenticated' ||
    /forbid|lacks|capabilit|denied|not allowed|unauthori[sz]ed|unauthenticated|\b40[13]\b/i.test(
      text,
    )
  ) {
    return 'refused';
  }
  if (
    /invalid|unreadable|malformed|ciphertext|unable to authenticate|auth(entication)? tag/i.test(
      text,
    )
  )
    return 'usable';
  return 'unreachable';
}

/** A `forbidden` refusal from crypto (its error code, or the message for other clients). */
export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'forbidden' || /forbid/i.test(errorText(error));
}

/** The one line to log for `outcome`, or `undefined` when all is well. */
export function consoleKeyNote(
  runtime: Pick<CryptoRuntimeLike, 'partition'>,
  outcome: ConsoleKeyOutcome | 'created',
  key: string = CONSOLE_CRYPTO_KEY,
  detail?: string,
): { level: 'info' | 'warn'; line: string } | undefined {
  const where = `the crypto key "${key}" in partition ${runtime.partition}`;
  const create = `\`node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}\``;
  const why = detail ? ` (${detail})` : '';
  switch (outcome) {
    case 'usable':
      return undefined;
    case 'created':
      return { level: 'info', line: `[${PACKAGE}] console commands: created ${where}` };
    case 'missing':
      // Not a problem on a crypto tenant: the crypto server provisions `console-*` keys on the
      // console's first seal. Only a server with sealProvisioning off needs the command.
      return {
        level: 'info',
        line: `[${PACKAGE}] console commands: the crypto key "${key}" does not exist in partition ${runtime.partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${create.slice(1, -1)})`,
      };
    case 'refused':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: the crypto server refused this app on ${where}${why}; no grant is needed for an app's own console keys (crypto:decrypt:console-* is harmless if present): check this app's crypto token is valid and the crypto server is up to date`,
      };
    case 'unreachable':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: could not check ${where}${why}; is the crypto server up? Retried on the next command`,
      };
  }
}

/**
 * Checks the console key once (a dummy decrypt) and, when it is missing, tries to create it
 * through the channel crypto already configured (works with `crypto:keys:manage:console-*`).
 * Never throws: returns the line to log, or `undefined` when the key is there and usable.
 */
export async function checkTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let outcome: ConsoleKeyOutcome;
  let detail: string | undefined;
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    // Newer crypto servers answer this directly: no decrypt, no error row in the audit. A
    // `forbidden` refusal is the "no permission" outcome; any other throw (an older server
    // without the route) falls back to the decrypt probe below.
    try {
      if (await hasKey.call(runtime.operations, { key })) return undefined;
      return createMissing(runtime, key);
    } catch (error) {
      if (isForbidden(error)) return consoleKeyNote(runtime, 'refused', key, errorText(error));
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return undefined; // a dummy that decrypts: cannot happen, but the key is clearly there
  } catch (error) {
    outcome = classifyConsoleKeyError(error);
    detail = errorText(error);
  }
  if (outcome !== 'missing') return consoleKeyNote(runtime, outcome, key, detail);
  return createMissing(runtime, key);
}

/** The key is missing: create it when this app may (servers with provisioning off), else say so. */
async function createMissing(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the federated console's commands to this app`,
    });
    return consoleKeyNote(runtime, 'created', key);
  } catch {
    return consoleKeyNote(runtime, 'missing', key);
  }
}

/**
 * The tenant's console key, watched: `atBoot()` runs {@link checkTenantConsoleKey} once;
 * `decrypt` wraps the app's own decrypt so that, while the last check warned, a command's failure
 * is classified and logged (one line, only when it changes) and its success clears the warning.
 * No extra crypto call per command.
 */
export function watchTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  log: (note: { level: 'info' | 'warn'; line: string }) => void,
  key: string = CONSOLE_CRYPTO_KEY,
): { atBoot(): Promise<void>; decrypt: CryptoOperationsLike['decrypt'] } {
  let last: string | undefined;
  let healthy = false;
  const report = (note: { level: 'info' | 'warn'; line: string } | undefined) => {
    healthy = note === undefined || note.level === 'info';
    if (note && note.line !== last) log(note);
    last = note?.line;
  };
  const boot = once(async () => report(await checkTenantConsoleKey(runtime, key)));
  return {
    atBoot: () => boot().catch(() => undefined),
    decrypt: async (input) => {
      try {
        const result = await runtime.operations.decrypt(input);
        if (!healthy && input.key === key) report(undefined);
        return result;
      } catch (error) {
        if (input.key === key) {
          const outcome = classifyConsoleKeyError(error);
          // A command's ciphertext rejected for itself (tampered) says nothing about the key.
          if (outcome !== 'usable') report(consoleKeyNote(runtime, outcome, key, errorText(error)));
        }
        throw error;
      }
    },
  };
}

/** Runs `ensure` once; a failure (crypto's database down at boot) is retried by the next call. */
function once(ensure: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= ensure().then(
      () => undefined,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/**
 * App side, automatic: this app decrypts with its own crypto (`runtime.operations`, its own
 * partition). Where crypto is embedded here, the key is created in this app's partition first.
 */
export function appCryptoCipher(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
  /** A crypto tenant's watched decrypt ({@link watchTenantConsoleKey}). */
  decrypt?: CryptoOperationsLike['decrypt'],
): ConsoleCipherSource {
  const service = runtime.service;
  const ready = service
    ? once(() => ensureConsoleKey(service, runtime.partition, key))
    : async () => {};
  const cipher: ConsoleCipher = decrypt
    ? { encrypt: (input) => runtime.operations.encrypt(input), decrypt }
    : runtime.operations;
  return async () => {
    await ready();
    return cipher;
  };
}

const neverDecrypts = async (): Promise<never> => {
  throw new Error(`[${PACKAGE}] the console side never decrypts console commands`);
};

/**
 * Console side, automatic: encrypt-only, with that app's key in its partition `partition`.
 *
 * - crypto embedded here: the service, with the narrowest principal (`crypto:encrypt:<key>` in
 *   that partition); the key is created there first when missing.
 * - crypto in a separate app (this app is its tenant): the channel crypto already configured,
 *   asking the server to seal with that partition's key (`crypto:seal:<key>` on this app's token).
 */
export function consoleCryptoCipher(
  runtime: CryptoRuntimeLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): ConsoleCipherSource {
  const service = runtime.service;
  if (service) {
    const ready = once(() => ensureConsoleKey(service, partition, key));
    const principal = { partition, capabilities: [`crypto:encrypt:${key}`], actor: ACTOR };
    const cipher: ConsoleCipher = {
      encrypt: (input) => service.encrypt(principal, input),
      decrypt: neverDecrypts,
    };
    return async () => {
      await ready();
      return cipher;
    };
  }
  const cipher: ConsoleCipher = {
    encrypt: async (input) => {
      try {
        return await runtime.operations.encrypt({ ...input, partition });
      } catch (error) {
        throw new Error(
          `the crypto server refused to seal with "${key}" for partition ${partition} (${errorText(error)}): grant this app's crypto client crypto:seal:console-*, check the key exists there, or, if the crypto server predates cross-partition sealing, upgrade @adonis-agora/crypto on it or configure \`controlPlane.crypto\` explicitly`,
        );
      }
    },
    decrypt: neverDecrypts,
  };
  return cipher;
}

/** One resolved side: the channel's auth options, and what to log. */
export interface ResolvedConsoleAuth {
  crypto?: ConsoleCryptoOptions | undefined;
  /** Whether {@link crypto} was resolved automatically. */
  autoCrypto: boolean;
  secret?: ChannelSecret | undefined;
  /** App side: a tenant-token verifier (explicit, or a control plane's own). */
  verifyTenant?: TenantVerifierInput | undefined;
  /** App side: an authkit app-call verifier (automatic). */
  verifyAppCall?: AppCallVerifier | undefined;
  /** App side: whether crypto commands must carry a token. */
  cryptoToken?: CommandTokenRule | undefined;
  /** Console side: append to a token minting error (the authkit grant to add). */
  tokenHint?: string | undefined;
  /**
   * Console side (§13a): crypto and an authkit token are both automatic, so the mode is chosen per
   * app at its first command: token mode when the app publishes its command key, else crypto.
   */
  autoChoice?: boolean | undefined;
  /** App side, crypto tenant (automatic): checks the console key once, logging what it finds. */
  checkKey?: (() => Promise<void>) | undefined;
  /** App side: token mode, sealed to the APP_KEY-derived key (published in this app's store). */
  tokenMode: boolean;
  /** Console side: the token each command carries (explicit, or authkit's app-call token). */
  token?: TenantTokenSource | undefined;
  /** Human-readable modes, for the boot log and the doctor. Empty: unauthenticated. */
  modes: string[];
}

/** Thrown at boot when one side cannot authenticate console commands. */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

/** Where every boot error points. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/config/federated-console#authenticating-the-console';

const cryptoMode = (key: string | undefined, auto: boolean) =>
  `crypto (${auto ? 'auto, ' : ''}key ${key ?? CONSOLE_CRYPTO_KEY})`;

/** The sentence every Agora lib's boot error carries (SECURITY-UNIFORM-SPEC §11). */
const DOCTOR_HINT = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

/** What else was found, after the uniform message (why the automatic modes did not apply). */
const notesOf = (notes: string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/**
 * Console side, token mode: `app`'s console-command key from authkit's key directory (purpose
 * `console:config`), when authkit-client has one. The fallback of the app's own store.
 */
export function appKeyDirectoryOf(
  authkit: AuthkitClientLike | undefined,
  app: string,
): (() => Promise<OkpJwk | null>) | undefined {
  const appKey = authkit?.appKey;
  if (typeof appKey !== 'function') return undefined;
  return async () =>
    ((await appKey.call(authkit, { app, purpose: 'console:config' })) as OkpJwk | null) ?? null;
}

/** The app-call verifier authkit-client already configured (its `service`), if any. */
function appCallVerifierOf(authkit: AuthkitClientLike | undefined): AppCallVerifier | undefined {
  const verifier = authkit?.appCallerVerifier?.();
  if (!verifier || typeof verifier.verifyToken !== 'function') return undefined;
  return (token) => verifier.verifyToken(token);
}

/** The app-call token for `target` authkit-client already configured (its `apps`), if any. */
function appCallTokenOf(
  authkit: AuthkitClientLike | undefined,
  target: string,
): TenantTokenSource | undefined {
  const tokens = authkit?.appCallTokens?.();
  if (!tokens || typeof tokens.token !== 'function') return undefined;
  return Object.assign(() => tokens.token(target), { reset: () => tokens.reset?.() });
}

/**
 * The owning app (`consoleCommands`): every mode it can resolve at once. Throws a
 * {@link ConsoleAuthConfigError} naming the options when none resolves.
 */
export function resolveAppConsoleAuth(input: {
  options: {
    crypto?: ConsoleCryptoOptions | false | undefined;
    secret?: ChannelSecret | undefined;
    verifyTenant?: TenantVerifierInput | false | undefined;
  };
  /** A control plane's own `verifyTenant`, used when none is set here. */
  fallbackVerifyTenant?: TenantVerifierInput | undefined;
  /** Whether this app has an APP_KEY (token mode seals commands to a key derived from it). */
  hasAppKey: boolean;
  siblings?: ConsoleSiblings | undefined;
  /**
   * A short id of the APP_KEY-derived command key, for the boot log in token mode (never the key
   * material: the console reads the public key from this app's store).
   */
  commandKeyId?: string | undefined;
  /** Logs the console key's state on a crypto tenant (automatic mode); see watchTenantConsoleKey. */
  logKey?: ((note: { level: 'info' | 'warn'; line: string }) => void) | undefined;
}): ResolvedConsoleAuth {
  const { options } = input;
  const siblings = input.siblings ?? {};
  const explicitCrypto = options.crypto ? options.crypto : undefined;
  const explicitVerify = options.verifyTenant ? options.verifyTenant : undefined;
  const explicit =
    options.secret !== undefined || explicitVerify !== undefined || explicitCrypto !== undefined;
  const modes: string[] = [];
  const resolved: ResolvedConsoleAuth = { autoCrypto: false, tokenMode: false, modes };

  // Tokens: an explicit verifier only; else authkit's app-call verifier and a control plane's own.
  if (explicitVerify !== undefined) {
    resolved.verifyTenant = explicitVerify;
  } else if (options.verifyTenant !== false) {
    resolved.verifyAppCall = appCallVerifierOf(siblings.authkit);
    resolved.verifyTenant = input.fallbackVerifyTenant;
  }
  const tokenSources = [
    ...(explicitVerify !== undefined ? ['verifyTenant'] : []),
    ...(resolved.verifyAppCall ? ['authkit app-call, auto'] : []),
    ...(explicitVerify === undefined && resolved.verifyTenant !== undefined
      ? ["the control plane's verifyTenant"]
      : []),
  ];
  const hasVerifier = tokenSources.length > 0;

  if (explicitCrypto) {
    resolved.crypto = explicitCrypto;
    // Explicit crypto + explicit verifyTenant: every command must carry a token.
    resolved.cryptoToken =
      explicitVerify !== undefined ? 'required' : hasVerifier ? 'optional' : 'none';
  } else if (!explicit && options.crypto !== false && siblings.crypto) {
    const runtime = siblings.crypto;
    const watch =
      !runtime.service && input.logKey ? watchTenantConsoleKey(runtime, input.logKey) : undefined;
    resolved.crypto = {
      cipher: appCryptoCipher(runtime, CONSOLE_CRYPTO_KEY, watch?.decrypt),
      key: CONSOLE_CRYPTO_KEY,
    };
    resolved.checkKey = watch?.atBoot;
    resolved.autoCrypto = true;
    resolved.cryptoToken = hasVerifier ? 'optional' : 'none';
  }
  // Labels (SECURITY-UNIFORM-SPEC §11), joined with " + " by the boot log and the doctor.
  if (resolved.crypto) {
    modes.push(cryptoMode(resolved.crypto.key, resolved.autoCrypto));
    if (resolved.cryptoToken === 'required')
      modes.push(`token required (${tokenSources.join(', ')})`);
    if (resolved.cryptoToken === 'optional') {
      modes.push(`token checked when sent (${tokenSources.join(', ')})`);
    }
  }

  if (hasVerifier && input.hasAppKey) {
    resolved.tokenMode = true;
    modes.push(
      `token (${tokenSources.join(', ')}; sealed to key ${input.commandKeyId ?? '(derived from APP_KEY)'})`,
    );
  }

  if (options.secret !== undefined) {
    resolved.secret = options.secret;
    modes.push('secret');
  }

  if (modes.length === 0) {
    const notes = [
      ...(hasVerifier && !input.hasAppKey
        ? [
            `a token verifier is available (${tokenSources.join(', ')}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
          ]
        : []),
      ...(options.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
    ];
    throw new ConsoleAuthConfigError(
      `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it config:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). ${DOCTOR_HINT} Docs: ${CONSOLE_AUTH_DOCS}${notesOf(notes)}`,
    );
  }
  return resolved;
}

/**
 * The console (one `federatedApps` entry): what it sends with. Throws when the entry may act
 * (`actions` not `false`) and nothing resolves.
 */
export function resolveFederatedAppAuth(input: {
  id: string;
  /** That app's partition (its crypto partition, and its name for authkit app-call tokens). */
  partition: string;
  actions: boolean;
  controlPlane: {
    crypto?: ConsoleCryptoOptions | false | undefined;
    secret?: ChannelSecret | undefined;
    token?: TenantTokenSource | false | undefined;
  };
  siblings?: ConsoleSiblings | undefined;
}): ResolvedConsoleAuth {
  const plane = input.controlPlane;
  const siblings = input.siblings ?? {};
  const explicitCrypto = plane.crypto ? plane.crypto : undefined;
  const explicitToken = plane.token ? plane.token : undefined;
  const explicit =
    plane.secret !== undefined || explicitToken !== undefined || explicitCrypto !== undefined;
  const modes: string[] = [];
  const resolved: ResolvedConsoleAuth = { autoCrypto: false, tokenMode: false, modes };

  if (explicitCrypto) {
    resolved.crypto = explicitCrypto;
  } else if (!explicit && plane.crypto !== false && siblings.crypto) {
    resolved.crypto = {
      cipher: consoleCryptoCipher(siblings.crypto, input.partition),
      key: CONSOLE_CRYPTO_KEY,
    };
    resolved.autoCrypto = true;
  }

  let tokenLabel: string | undefined;
  if (explicitToken !== undefined) {
    resolved.token = explicitToken;
    tokenLabel = 'controlPlane.token';
  } else if (plane.token !== false && plane.secret === undefined) {
    const auto = appCallTokenOf(siblings.authkit, input.partition);
    if (auto) {
      resolved.token = auto;
      tokenLabel = 'authkit app-call, auto';
    }
  }

  if (tokenLabel === 'authkit app-call, auto') {
    resolved.tokenHint = `To attach it: grant the console's service client config:console:* on "${input.partition}" in authkit.`;
  }
  // §13a: both automatic → decided per app at its first command (cached): token mode when the app
  // publishes its command key (it does only when that is how it is reached), else crypto.
  if (resolved.autoCrypto && tokenLabel === 'authkit app-call, auto') {
    resolved.autoChoice = true;
    modes.push(
      `auto (the app's published key if it publishes one, else crypto (auto, key ${CONSOLE_CRYPTO_KEY}, partition ${input.partition}))`,
    );
  } else if (resolved.crypto) {
    // Console side: the automatic label always names the partition sealed for (§11).
    modes.push(
      resolved.autoCrypto
        ? `crypto (auto, key ${resolved.crypto.key ?? CONSOLE_CRYPTO_KEY}, partition ${input.partition})`
        : cryptoMode(resolved.crypto.key, false),
    );
    if (tokenLabel) modes.push(`token (${tokenLabel})`);
  } else if (tokenLabel) {
    // The console learns the app's key id only when it reads it (from its store or authkit).
    modes.push(`token (${tokenLabel}; sealed to the app's published key)`);
  } else if (plane.secret !== undefined) {
    modes.push('secret');
  }
  if (plane.secret !== undefined) resolved.secret = plane.secret;

  if (modes.length === 0 && input.actions) {
    const notes = [
      ...(plane.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
      ...(plane.token === false ? ['`token: false` turned the automatic authkit token off'] : []),
    ];
    const entry = 'console.federatedApps';
    throw new ConsoleAuthConfigError(
      `[${PACKAGE}] ${entry}["${input.id}"]: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${entry}["${input.id}"].controlPlane.secret, or ${entry}["${input.id}"].controlPlane.token — or actions: false to only browse it. ${DOCTOR_HINT}${notesOf(notes)}`,
    );
  }
  return resolved;
}
