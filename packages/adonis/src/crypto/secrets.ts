import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ConfigValue } from '@adonis-agora/config-core';

const PREFIX = 'agora-config:v1:';
const INFO = 'adonis-agora/config/secrets';

/** Encrypts and decrypts the values of secret entries, at rest. */
export interface SecretCodec {
  /** Encrypts a JSON value into an opaque string safe to store in any text column. */
  seal(value: ConfigValue): string;
  /** Decrypts a string produced by {@link seal}. */
  open(sealed: string): ConfigValue;
  /** Whether `value` looks like this codec's output. */
  owns(value: unknown): value is string;
}

/** The 32-byte AES key derived from a host secret (`APP_KEY`, a KMS-fetched key, …). */
export function deriveKey(secret: string | Buffer | Uint8Array): Buffer {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (bytes.length === 0) throw new Error('@adonis-agora/config: the secrets key is empty');
  return Buffer.from(hkdfSync('sha256', bytes, Buffer.alloc(0), INFO, 32));
}

/**
 * AES-256-GCM with a fresh 12-byte IV per value. The ciphertext is
 * `agora-config:v1:<iv>:<tag>:<ciphertext>` (base64), so a value can be recognised in a dump and a
 * rotated key can be detected instead of silently decrypting to garbage.
 */
export function secretCodec(key: string | Buffer | Uint8Array): SecretCodec {
  const derived = deriveKey(key);
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', derived, iv);
      const plaintext = JSON.stringify(value);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
    },
    open(sealed) {
      if (!sealed.startsWith(PREFIX)) {
        throw new Error('@adonis-agora/config: not an encrypted config value');
      }
      const [iv, tag, ciphertext] = sealed.slice(PREFIX.length).split(':');
      if (!iv || !tag || ciphertext === undefined) {
        throw new Error('@adonis-agora/config: malformed encrypted config value');
      }
      const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      try {
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
        return JSON.parse(plaintext) as ConfigValue;
      } catch {
        throw new Error(
          '@adonis-agora/config: cannot decrypt a secret — was the secrets key rotated without re-encrypting?',
        );
      }
    },
    owns(value): value is string {
      return typeof value === 'string' && value.startsWith(PREFIX);
    },
  };
}
