import { createHmac } from 'node:crypto';
import { type ConfigValue, canonicalJson } from '@adonis-agora/config-core';
import {
  createKeyring,
  type EncrypterLike,
  type Keyring,
  type KmsAdapter,
  open,
  reseal,
  SEALED_PREFIX,
  type SealedStatus,
  type SecretLike,
  seal,
  sealedStatus,
} from '../crypto-kit/index.js';

export type { EncrypterLike };

/** Domain separation for every config secret: one APP_KEY never yields the same key twice. */
export const CONFIG_SECRET_PURPOSE = 'config:secrets';

/** One key: a secret, or `{ id, secret }` when you want to name the active one. */
export type CryptoKey = SecretLike | { id: string; secret: SecretLike };

/**
 * Secret encryption. The default (nothing here) is the app's own encryption service
 * (`config/encryption.ts`), so an app that configures nothing keeps working and rotation happens
 * there. `keys` lets this package own the keys instead (newest first; the first seals).
 */
export interface CryptoOptions {
  /** Keys, newest first: the first seals, every one opens. `{ id, secret }` names the active one. */
  keys?: CryptoKey[];
  /** With `{ id, secret }` keys: the id that seals. Ignored by the kit, honored by this wrapper. */
  active?: string;
  /** The app's `encryption` service, or any Adonis-encryption-shaped one. Default when set up. */
  encryption?: EncrypterLike;
  /** Envelope encryption: values carry a data key wrapped by this adapter. */
  kms?: KmsAdapter;
}

export interface SealOptions {
  /** Additional authenticated data; the same string must be passed to `open`. */
  aad?: string | undefined;
  /** Re-seal even a value that already opens with the active key (after rotating the app's key). */
  force?: boolean;
}

/** The store's view of encrypting one value (async: a KMS key answers over the network). */
export interface SecretCodec {
  seal(value: ConfigValue, options?: SealOptions): Promise<string>;
  open(sealed: string, options?: SealOptions): Promise<ConfigValue>;
  /** Whether a stored string is this codec's ciphertext. A secret is always one. */
  owns(value: unknown): value is string;
  status(sealed: string, options?: SealOptions): Promise<SealedStatus>;
  reseal(sealed: string, options?: SealOptions): Promise<string>;
  /**
   * A keyed digest of a secret's plaintext, for version fingerprints. Fingerprints are shown to
   * callers that cannot read secrets, so they must not be an unkeyed hash of one.
   */
  digest?(value: ConfigValue): string;
}

/** Domain separation for the fingerprint key (never the key that encrypts). */
export const CONFIG_FINGERPRINT_PURPOSE = 'config:fingerprint';

/**
 * `codec` with a {@link SecretCodec.digest}: HMAC-SHA256 of the value under a key derived from
 * `secret` (the app key) for {@link CONFIG_FINGERPRINT_PURPOSE}. Every replica with the same app key
 * computes the same digest, so no-op detection keeps working across processes.
 */
export function withFingerprintKey(codec: SecretCodec, secret: SecretLike): SecretCodec {
  const raw = typeof secret === 'string' ? secret : secret.release();
  const key = createHmac('sha256', raw).update(CONFIG_FINGERPRINT_PURPOSE).digest();
  return {
    ...codec,
    seal: codec.seal.bind(codec),
    open: codec.open.bind(codec),
    owns: codec.owns.bind(codec),
    status: codec.status.bind(codec),
    reseal: codec.reseal.bind(codec),
    digest(value) {
      return createHmac('sha256', key).update(canonicalJson(value)).digest('base64url');
    },
  };
}

/** The AAD binding a value to its place: app/environment/key (copying it elsewhere fails to open). */
export function entryAad(scope: { app: string; environment: string }, key: string): string {
  return `config:${scope.app}:${scope.environment}:${key}`;
}

/**
 * The keyring for config secrets, on top of the kit:
 *
 * - `crypto.keys` (newest first; the first seals) — the kit can then tell a value sealed with an
 *   older key apart and `config:crypto:reseal` fixes it. `crypto.active` names the sealing key when
 *   the keys use the `{ id, secret }` form; the kit has no key ids, so this wrapper reorders them.
 * - `crypto.encryption` — the app's own encryption service (the default in the provider). Its keys
 *   rotate in `config/encryption.ts`; the kit cannot tell them apart, so `--all` re-seals.
 * - `appKey` — a last-resort fallback (an app with no encryption config): one `app` key.
 */
export function createConfigKeyring(options: {
  keys?: CryptoKey[] | undefined;
  active?: string | undefined;
  encryption?: EncrypterLike | undefined;
  kms?: KmsAdapter | undefined;
  appKey?: SecretLike | undefined;
}): Keyring {
  if (options.keys?.length && options.encryption !== undefined) {
    throw new Error('crypto: give either `crypto.keys` or `crypto.encryption`, not both');
  }
  if (options.keys?.length) {
    const configured = options.keys.map((key, index) => {
      const named =
        typeof key === 'object' && key !== null && 'secret' in key
          ? (key as { id: string; secret: SecretLike })
          : { id: `key-${index}`, secret: key as SecretLike };
      return named;
    });
    const activeId = options.active ?? configured[0]?.id;
    const active = configured.find((key) => key.id === activeId);
    if (!active) throw new Error(`crypto: active key "${activeId}" is not in crypto.keys`);
    const ordered = [active, ...configured.filter((key) => key !== active)];
    return createKeyring({
      purpose: CONFIG_SECRET_PURPOSE,
      keys: ordered.map((key) => key.secret),
      ...(options.kms !== undefined ? { kms: options.kms } : {}),
    });
  }
  if (options.encryption !== undefined) {
    if (options.active !== undefined) {
      throw new Error('crypto: `active` only applies with `crypto.keys`');
    }
    return createKeyring({
      purpose: CONFIG_SECRET_PURPOSE,
      encryption: options.encryption,
      ...(options.kms !== undefined ? { kms: options.kms } : {}),
    });
  }
  if (options.appKey === undefined || options.appKey === '') {
    throw new Error('crypto: no keyring: pass `crypto.keys`, `crypto.encryption`, or set APP_KEY');
  }
  return createKeyring({
    purpose: CONFIG_SECRET_PURPOSE,
    keys: [options.appKey],
    ...(options.kms !== undefined ? { kms: options.kms } : {}),
  });
}

/** Adapts the crypto kit to the store's {@link SecretCodec}. Values are JSON inside the ciphertext. */
export function keyringCodec(keyring: Keyring): SecretCodec {
  return {
    async seal(value, options = {}) {
      return seal(keyring, JSON.stringify(value), {
        ...(options.aad !== undefined ? { aad: options.aad } : {}),
      });
    },
    async open(sealed, options = {}) {
      const text = await open(keyring, sealed, {
        ...(options.aad !== undefined ? { aad: options.aad } : {}),
      });
      try {
        return JSON.parse(text) as ConfigValue;
      } catch {
        throw new Error('@adonis-agora/config: the decrypted secret is not JSON');
      }
    },
    owns(value): value is string {
      // A secret value is always sealed. Treat every non-empty string as ciphertext so a plaintext
      // value (written by another tool) fails loudly instead of being served as a secret.
      return typeof value === 'string';
    },
    status(sealed, options = {}) {
      return sealedStatus(keyring, sealed, {
        ...(options.aad !== undefined ? { aad: options.aad } : {}),
      });
    },
    reseal(sealed, options = {}) {
      return reseal(keyring, sealed, {
        ...(options.aad !== undefined ? { aad: options.aad } : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
      });
    },
  };
}

/** Whether a stored string already looks like a crypto-kit value. */
export function isKitValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}
