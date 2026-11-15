import type { ConfigValue } from '@adonis-agora/config-core';
import type { SecretCodec } from './secrets.js';

/** The slice of AdonisJS's encryption service this package uses (a manager or a driver). */
export interface EncryptionLike {
  encrypt(payload: unknown, options?: { purpose?: string; expiresIn?: string | number }): string;
  decrypt<T = unknown>(value: string, purpose?: string): T | null;
}

/** The purpose bound into every config ciphertext: another feature cannot decrypt one by accident. */
export const CONFIG_SECRET_PURPOSE = 'agora-config';

/**
 * Secrets at rest through the app's encryption service (`config/encryption.ts`), the AdonisJS
 * package: its driver, its APP_KEY (or key list), its rotation and its purpose binding. A ciphertext
 * is `<encrypter id>.<v1:ciphertext>.<iv>.<tag>` (AES-SIV uses three parts); the format is only used
 * to recognise a value as encrypted, never to decrypt it.
 */
export function adonisSecretCodec(encryption: EncryptionLike): SecretCodec {
  return {
    seal(value: ConfigValue): string {
      // Wrap it: Adonis's decrypt returns null both for a failure and for an encrypted null.
      return encryption.encrypt({ value }, { purpose: CONFIG_SECRET_PURPOSE });
    },
    open(sealed: string): ConfigValue {
      const payload = encryption.decrypt<{ value: ConfigValue }>(sealed, CONFIG_SECRET_PURPOSE);
      if (payload === null || typeof payload !== 'object' || !('value' in payload)) {
        throw new Error(
          '@adonis-agora/config: cannot decrypt a secret with the app encryption key — was it rotated, or was this value written with another codec?',
        );
      }
      return payload.value;
    },
    owns(value: unknown): value is string {
      // A secret value is always sealed by this codec. Treat every non-empty string as ciphertext so
      // a plaintext value written by an older setup fails loudly instead of being served as a secret.
      return typeof value === 'string' && value !== '';
    },
  };
}
