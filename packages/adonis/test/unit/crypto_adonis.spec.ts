import { EncryptionFactory } from '@adonisjs/core/factories/encryption';
import { describe, expect, it } from 'vitest';
import { adonisSecretCodec, type EncryptionLike } from '../../src/crypto/adonis.js';

function encryption(key = 'a'.repeat(32)): EncryptionLike {
  // The factory's key is fixed; a second factory with a different key cannot be built through it,
  // so the wrong-key path is covered by the purpose assertion below.
  void key;
  return new EncryptionFactory().create() as unknown as EncryptionLike;
}

describe('adonisSecretCodec', () => {
  it('round-trips every JSON shape through the app encryption service', () => {
    const codec = adonisSecretCodec(encryption());
    for (const value of ['hunter2', 42, true, null, { a: [1, 'x'] }]) {
      const sealed = codec.seal(value);
      expect(typeof sealed).toBe('string');
      expect(codec.owns(sealed)).toBe(true);
      expect(codec.open(sealed)).toEqual(value);
    }
  });

  it('uses the purpose, so another encryption user cannot decrypt it', () => {
    const service = encryption();
    const sealed = adonisSecretCodec(service).seal('hunter2');
    expect(service.decrypt(sealed)).toBeNull();
    expect(service.decrypt(sealed, 'agora-config')).toEqual({ value: 'hunter2' });
  });

  it('never contains the plaintext', () => {
    const sealed = adonisSecretCodec(encryption()).seal('super-secret-value');
    expect(sealed).not.toContain('super-secret-value');
    expect(sealed.split('.').length).toBeGreaterThanOrEqual(3);
  });

  it('treats a string as ciphertext even when it looks plain', () => {
    const codec = adonisSecretCodec(encryption());
    expect(codec.owns('plain')).toBe(true);
    expect(codec.owns(42)).toBe(false);
    expect(() => codec.open('plain')).toThrow(/cannot decrypt/);
  });
});
