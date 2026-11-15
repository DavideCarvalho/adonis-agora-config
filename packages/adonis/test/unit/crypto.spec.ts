import { describe, expect, it } from 'vitest';
import { deriveKey, secretCodec } from '../../src/crypto/secrets.js';

describe('secret codec', () => {
  it('round-trips every JSON shape', () => {
    const codec = secretCodec('app-key');
    for (const value of ['hunter2', 42, true, null, { a: [1, 'x'] }]) {
      const sealed = codec.seal(value);
      expect(codec.owns(sealed)).toBe(true);
      expect(codec.open(sealed)).toEqual(value);
    }
  });

  it('never contains the plaintext', () => {
    const sealed = secretCodec('app-key').seal('super-secret-value');
    expect(sealed).not.toContain('super-secret-value');
    expect(sealed.startsWith('agora-config:v1:')).toBe(true);
  });

  it('uses a fresh IV per value', () => {
    const codec = secretCodec('app-key');
    expect(codec.seal('x')).not.toBe(codec.seal('x'));
  });

  it('refuses another key, tampering and foreign strings', () => {
    const sealed = secretCodec('app-key').seal('x');
    expect(() => secretCodec('other-key').open(sealed)).toThrow(/cannot decrypt/);
    const parts = sealed.split(':');
    const tampered = [...parts.slice(0, 3), Buffer.from('nope').toString('base64')].join(':');
    expect(() => secretCodec('app-key').open(tampered)).toThrow(/cannot decrypt|malformed/);
    expect(() => secretCodec('app-key').open('plain text')).toThrow(/not an encrypted/);
  });

  it('rejects an empty key', () => {
    expect(() => deriveKey('')).toThrow(/empty/);
    expect(deriveKey('a')).toHaveLength(32);
    expect(deriveKey('a')).toEqual(deriveKey('a'));
    expect(deriveKey('a')).not.toEqual(deriveKey('b'));
  });
});
