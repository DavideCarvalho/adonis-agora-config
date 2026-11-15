import { describe, expect, it } from 'vitest';
import { createConfigKeyring, entryAad, keyringCodec } from '../../src/crypto/secrets.js';
import { gcmEncryption, SealedValueError } from '../../src/crypto-kit/index.js';

const appKey = 'a-test-app-key-of-32-characters!';
const scope = { app: 'shop', environment: 'production' };
const aad = entryAad(scope, 'db.password');

function codec(key = appKey) {
  return keyringCodec(createConfigKeyring({ appKey: key }));
}

describe('config secret codec (crypto kit)', () => {
  it('round-trips every JSON shape inside the kit format', async () => {
    const secrets = codec();
    for (const value of ['hunter2', 42, true, null, { a: [1, 'x'] }]) {
      const sealed = await secrets.seal(value, { aad });
      expect(sealed.startsWith('agora:v1:')).toBe(true);
      expect(secrets.owns(sealed)).toBe(true);
      expect(await secrets.open(sealed, { aad })).toEqual(value);
    }
  });

  it('binds the ciphertext to app, environment and key', async () => {
    const secrets = codec();
    const sealed = await secrets.seal('hunter2', { aad });
    await expect(secrets.open(sealed)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      secrets.open(sealed, { aad: entryAad({ ...scope, app: 'billing' }, 'db.password') }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      secrets.open(sealed, { aad: entryAad(scope, 'stripe.secret') }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('reports the status and reseals a retired key', async () => {
    const before = codec();
    const sealed = await before.seal('hunter2', { aad });
    expect(await before.status(sealed, { aad })).toBe('active');

    const after = keyringCodec(
      createConfigKeyring({
        keys: [
          { id: '2026-11', secret: 'a-new-app-key-of-32-characters!!!' },
          { id: 'app', secret: appKey },
        ],
        active: '2026-11',
      }),
    );
    expect(await after.status(sealed, { aad })).toBe('retired');
    expect(await after.open(sealed, { aad })).toBe('hunter2');
    const fresh = await after.reseal(sealed, { aad });
    expect(await after.status(fresh, { aad })).toBe('active');
    expect(await after.open(fresh, { aad })).toBe('hunter2');
  });

  it('accepts a plain key list (the first seals)', async () => {
    const secrets = keyringCodec(
      createConfigKeyring({ keys: [appKey, 'an-old-app-key-of-32-chars!!!'] }),
    );
    const sealed = await secrets.seal('v', { aad });
    expect(await secrets.open(sealed, { aad })).toBe('v');
    expect(await secrets.status(sealed, { aad })).toBe('active');
  });

  it('uses an opaque app encryption: everything is active and --all rewrites', async () => {
    // The app's own encryption (config/encryption.ts) holds both keys: the kit cannot tell which
    // one sealed a value, so status is always `active` and `force` rewrites after rotation.
    const secrets = keyringCodec(
      createConfigKeyring({
        encryption: gcmEncryption([appKey, 'an-old-app-key-of-32-chars!!!!']),
      }),
    );
    const sealed = await secrets.seal('v', { aad });
    expect(await secrets.status(sealed, { aad })).toBe('active');
    expect(await secrets.reseal(sealed, { aad })).toBe(sealed);
    const forced = await secrets.reseal(sealed, { aad, force: true });
    expect(forced).not.toBe(sealed);
    expect(await secrets.open(forced, { aad })).toBe('v');
  });

  it('refuses keys together with an encryption instance, and active without keys', () => {
    expect(() =>
      createConfigKeyring({
        keys: [appKey],
        encryption: gcmEncryption([appKey]),
      }),
    ).toThrow(/either `crypto.keys` or `crypto.encryption`/);
    expect(() =>
      createConfigKeyring({
        active: '2026-11',
        encryption: gcmEncryption([appKey]),
      }),
    ).toThrow(/only applies with `crypto.keys`/);
    expect(() => createConfigKeyring({})).toThrow(/no keyring/);
  });

  it('refuses a plain string instead of serving it as a secret', async () => {
    const secrets = codec();
    expect(secrets.owns('plain')).toBe(true);
    await expect(secrets.open('plain', { aad })).rejects.toBeInstanceOf(SealedValueError);
  });
});
