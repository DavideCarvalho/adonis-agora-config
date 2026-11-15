import { type ConfigEntryState, fingerprintOf } from '@adonis-agora/config-core';
import { describe, expect, it } from 'vitest';
import { secretCodec } from '../../src/crypto/secrets.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { DocumentSealer } from '../../src/store/store.js';
import { seedConfig, testScope } from '../../src/testing/index.js';

const at = new Date('2026-01-01T00:00:00.000Z').toISOString();

function store(): MemoryStore {
  return new MemoryStore({ secretCodec: secretCodec('test-key') });
}

describe('DocumentSealer', () => {
  it('seals secret values and leaves the rest transparent', () => {
    const sealer = new DocumentSealer(secretCodec('k'));
    const entry: ConfigEntryState = {
      value: 'hunter2',
      secret: true,
      reloadable: false,
      updatedAt: at,
      updatedBy: 'tester',
    };
    const sealed = sealer.sealEntry(entry);
    expect(JSON.stringify(sealed)).not.toContain('hunter2');
    expect(sealer.openEntry(sealed)).toEqual(entry);
    const plain: ConfigEntryState = { ...entry, secret: false };
    expect(sealer.sealEntry(plain)).toEqual(plain);
  });

  it('refuses to store a secret without a key', () => {
    const sealer = new DocumentSealer(undefined);
    expect(() =>
      sealer.sealEntry({
        value: 'x',
        secret: true,
        reloadable: false,
        updatedAt: at,
        updatedBy: 'tester',
      }),
    ).toThrow(/no secrets key/);
  });
});

describe('MemoryStore', () => {
  it('versions every write, starting at 1', async () => {
    const s = store();
    const first = await s.write(testScope, [{ key: 'db.host', value: 'localhost' }], {
      actor: 'ann',
      now: at,
    });
    expect(first.changed).toBe(true);
    expect(first.document.version).toBe(1);
    const second = await s.write(testScope, [{ key: 'db.port', value: 5432 }], {
      actor: 'ann',
      now: at,
    });
    expect(second.document.version).toBe(2);
    expect(second.document.entries['db.host']?.value).toBe('localhost');
    expect((await s.read(testScope))?.version).toBe(2);
    expect((await s.readVersion(testScope, 1))?.entries['db.port']).toBeUndefined();
  });

  it('is a no-op when nothing changed, and only bumps the version when something did', async () => {
    const s = store();
    await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now: at });
    const same = await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'bob', now: at });
    expect(same.changed).toBe(false);
    expect(same.document.version).toBe(1);
    const flag = await s.write(testScope, [{ key: 'a', reloadable: true }], {
      actor: 'bob',
      now: at,
    });
    expect(flag.changed).toBe(true);
    expect(flag.document.version).toBe(2);
  });

  it('unsets, records history and filters the audit trail', async () => {
    const s = store();
    await s.write(
      testScope,
      [
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
      ],
      {
        actor: 'ann',
        now: at,
        message: 'first',
      },
    );
    await s.write(testScope, [{ key: 'a' }], { actor: 'bob', now: at });
    expect((await s.read(testScope))?.entries.a).toBeUndefined();
    const history = await s.listVersions(testScope, { number: 1, size: 10 });
    expect(history.total).toBe(2);
    expect(history.rows[0]?.version).toBe(2);
    expect(history.rows[0]?.entries).toBe(1);
    const audit = await s.listAudit(testScope, { number: 1, size: 10 });
    expect(audit.rows[0]).toMatchObject({ actor: 'bob', action: 'unset', key: 'a', version: 2 });
    expect((await s.listAudit(testScope, { number: 1, size: 10 }, { action: 'unset' })).total).toBe(
      1,
    );
    expect((await s.listAudit(testScope, { number: 1, size: 10 }, { key: 'b' })).total).toBe(1);
  });

  it('rolls back to a past version as a new version', async () => {
    const s = store();
    await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now: at });
    await s.write(
      testScope,
      [
        { key: 'a', value: 2 },
        { key: 'b', value: 3 },
      ],
      {
        actor: 'ann',
        now: at,
      },
    );
    const rolled = await s.rollback(testScope, 1, {
      actor: 'ops',
      now: at,
      message: 'rollback to v1',
    });
    expect(rolled.changed).toBe(true);
    expect(rolled.document.version).toBe(3);
    expect(rolled.document.entries.a?.value).toBe(1);
    expect(rolled.document.entries.b).toBeUndefined();
    expect((await s.listAudit(testScope, { number: 1, size: 10 })).rows[0]).toMatchObject({
      action: 'rollback',
      actor: 'ops',
      version: 3,
    });
    const again = await s.rollback(testScope, 1, { actor: 'ops', now: at });
    expect(again.changed).toBe(false);
    await expect(s.rollback(testScope, 99, { actor: 'ops', now: at })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('records reveals and keeps secrets sealed at rest', async () => {
    const s = store();
    await s.write(testScope, [{ key: 'password', value: 'hunter2', secret: true }], {
      actor: 'ann',
      now: at,
    });
    // The store's own view is plaintext; a dump of the backing map is not reachable, so the
    // sealing is exercised through the sealer and the Lucid test (which reads the column).
    expect((await s.read(testScope))?.entries.password?.value).toBe('hunter2');
    await s.recordReveal(testScope, 'password', 1, 'ann');
    const audit = await s.listAudit(testScope, { number: 1, size: 10 });
    expect(audit.rows[0]).toMatchObject({ action: 'reveal', actor: 'ann', key: 'password' });
    expect(audit.rows.length).toBe(2);
  });

  it('lists scopes and pages versions', async () => {
    const s = store();
    await seedConfig(s, testScope, [['a', 1]]);
    await seedConfig(s, { ...testScope, environment: 'staging' }, [['a', 2]]);
    expect(await s.listScopes()).toEqual([
      { app: 'shop', environment: 'production', label: 'main' },
      { app: 'shop', environment: 'staging', label: 'main' },
    ]);
    for (let i = 0; i < 5; i += 1) {
      await seedConfig(s, testScope, [['a', i]]);
    }
    const page = await s.listVersions(testScope, { number: 2, size: 2 });
    expect(page.total).toBe(6);
    expect(page.rows.map((row) => row.version)).toEqual([4, 3]);
  });

  it('stamps the fingerprint of the entries', async () => {
    const s = store();
    const { document } = await s.write(testScope, [{ key: 'a', value: 1 }], {
      actor: 'ann',
      now: at,
    });
    expect(document.fingerprint).toBe(fingerprintOf(document.entries));
  });
});
