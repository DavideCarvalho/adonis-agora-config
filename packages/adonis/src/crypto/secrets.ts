import type { ConfigValue } from '@adonis-agora/config-core';
import {
  createKeyring,
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

/** Domain separation for every config secret: one APP_KEY never yields the same key twice. */
export const CONFIG_SECRET_PURPOSE = 'config:secrets';

/** One key. The kit takes plain secrets; the id is how config names the active one. */
export interface CryptoKey {
  id: string;
  secret: SecretLike;
}

/** Rotation options. The first key seals; `active` names the one that seals, if not the first. */
export interface CryptoOptions {
  keys?: CryptoKey[];
  active?: string;
  /** Envelope encryption: values carry a data key wrapped by this adapter. */
  kms?: KmsAdapter;
}

export interface SealOptions {
  /** Additional authenticated data; the same string must be passed to `open`. */
  aad?: string | undefined;
}

/** The store's view of encrypting one value (async: a KMS key answers over the network). */
export interface SecretCodec {
  seal(value: ConfigValue, options?: SealOptions): Promise<string>;
  open(sealed: string, options?: SealOptions): Promise<ConfigValue>;
  /** Whether a stored string is this codec's ciphertext. A secret is always one. */
  owns(value: unknown): value is string;
  status(sealed: string, options?: SealOptions): Promise<SealedStatus>;
  reseal(sealed: string, options?: SealOptions): Promise<string>;
}

/** The AAD binding a value to its place: app/environment/key (copying it elsewhere fails to open). */
export function entryAad(scope: { app: string; environment: string }, key: string): string {
  return `config:${scope.app}:${scope.environment}:${key}`;
}

/**
 * The keyring for config secrets: `crypto.keys` (newest first) with `crypto.active` naming the key
 * that seals, or one `app` key derived from APP_KEY. The kit itself has no key ids, so `active` is
 * honored by reordering the secrets before handing them to it.
 */
export function createConfigKeyring(options: {
  keys?: CryptoKey[] | undefined;
  active?: string | undefined;
  kms?: KmsAdapter | undefined;
  appKey?: SecretLike | undefined;
}): Keyring {
  const configured =
    options.keys?.length && options.keys.length > 0
      ? options.keys
      : [{ id: 'app', secret: options.appKey ?? '' }];
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
      });
    },
  };
}

/** Whether a stored string already looks like a crypto-kit value. */
export function isKitValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}
