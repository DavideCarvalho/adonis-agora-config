import { describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { secretCodec } from '../../src/crypto/secrets.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { seedConfig, testScope } from '../../src/testing/index.js';

const at = new Date('2026-03-03T03:03:03.000Z').toISOString();

function admin(options: { reveal?: boolean; vault?: (ref: { path: string }) => unknown } = {}) {
  const store = new MemoryStore({ secretCodec: secretCodec('admin-test') });
  return {
    store,
    admin: new ConfigAdmin({
      store,
      canRevealSecrets: options.reveal ?? true,
      ...(options.vault ? { vault: options.vault as never } : {}),
    }),
  };
}

describe('ConfigAdmin', () => {
  it('lists entries with search, filters, sort and paging', async () => {
    const { store, admin: a } = admin();
    await seedConfig(store, testScope, [
      ['db.host', 'localhost'],
      ['db.port', 5432],
      ['cache.url', 'redis://x'],
      { key: 'stripe.secret', value: 'sk', secret: true },
      { key: 'checkout.timeoutMs', value: 3000, reloadable: true },
    ]);
    const all = await a.listEntries(testScope, true);
    expect(all.meta.total).toBe(5);
    expect(all.data.map((entry) => entry.key)).toEqual([
      'cache.url',
      'checkout.timeoutMs',
      'db.host',
      'db.port',
      'stripe.secret',
    ]);
    expect((await a.listEntries(testScope, true, { page: 1, size: 2 })).meta.lastPage).toBe(3);

    const search = await a.listEntries(testScope, true, {
      page: 1,
      size: 50,
      filters: { search: 'cache' },
    });
    expect(search.data.map((entry) => entry.key)).toEqual(['cache.url']);
    expect(
      (await a.listEntries(testScope, true, { page: 1, size: 50, filters: { secret: true } })).meta
        .total,
    ).toBe(1);
    expect(
      (await a.listEntries(testScope, true, { page: 1, size: 50, filters: { reloadable: true } }))
        .meta.total,
    ).toBe(1);

    const sorted = await a.listEntries(testScope, true, {
      page: 1,
      size: 50,
      sort: { field: 'key', direction: 'desc' },
    });
    expect(sorted.data[0]?.key).toBe('stripe.secret');
  });

  it('masks secrets without the capability and reveals them with it', async () => {
    const { store, admin: a } = admin();
    await seedConfig(store, testScope, [{ key: 'p', value: 'hunter2', secret: true }]);
    const masked = await a.getEntry(testScope, 'p', { canReadSecrets: false });
    expect(masked).toMatchObject({ key: 'p', masked: true, secret: true });
    expect(masked?.value).toBeUndefined();
    const revealed = await a.getEntry(testScope, 'p', { canReadSecrets: true });
    expect(revealed?.value).toBe('hunter2');

    const own = new ConfigAdmin({ store, canRevealSecrets: false });
    expect((await own.listEntries(testScope, false)).data[0]).toMatchObject({ masked: true });
  });

  it('records a reveal in the audit trail', async () => {
    const { store, admin: a } = admin();
    await seedConfig(store, testScope, [{ key: 'p', value: 'x', secret: true }]);
    await a.getEntry(testScope, 'p', { canReadSecrets: true, reveal: { actor: 'ann@x.test' } });
    const audit = await a.audit(testScope, { page: 1, size: 10, action: 'reveal' });
    expect(audit.meta.total).toBe(1);
    expect(audit.data[0]).toMatchObject({ actor: 'ann@x.test', action: 'reveal', key: 'p' });
  });

  it('resolves a vault reference only for a reader who may see it', async () => {
    const { store, admin: a } = admin({
      vault: (reference) => (reference.path === 'prod/shop' ? 'from-vault' : undefined),
    });
    await seedConfig(store, testScope, [
      { key: 'k', vault: 'vault://aws/prod/shop#key', secret: true },
    ]);
    expect((await a.getEntry(testScope, 'k', { canReadSecrets: false }))?.masked).toBe(true);
    expect((await a.getEntry(testScope, 'k', { canReadSecrets: true }))?.value).toBe('from-vault');
  });

  it('writes, histories, diffs and rolls back', async () => {
    const { store, admin: a } = admin();
    await a.setEntry(testScope, 'a', { value: 1 }, { actor: 'ann', now: at });
    await a.setEntry(testScope, 'b', { value: 2 }, { actor: 'bob', now: at, message: 'add b' });
    const versions = await a.listVersions(testScope);
    expect(versions.meta.total).toBe(2);
    expect(versions.data[0]?.version).toBe(2);
    expect(
      (await a.listVersions(testScope, { page: 1, size: 10, direction: 'asc' })).data[0]?.version,
    ).toBe(1);

    const diff = await a.diff(testScope, 1, 2, true);
    expect(diff.map((row) => [row.key, row.kind])).toEqual([['b', 'added']]);

    const rolled = await a.rollback(testScope, 1, { actor: 'ops', now: at });
    expect(rolled).toMatchObject({ version: 3, changed: true });
    expect((await a.version(testScope, 3, true))?.entries.map((entry) => entry.key)).toEqual(['a']);
    expect((await store.read(testScope))?.entries.b).toBeUndefined();

    expect(await a.unsetEntry(testScope, 'nope', { actor: 'ann', now: at })).toEqual({
      version: 3,
      changed: false,
    });
  });

  it('always masks audit before/after values, even for an operator who may reveal', async () => {
    const { store } = admin();
    await seedConfig(store, testScope, [{ key: 'p', value: 'secret-value', secret: true }]);
    for (const canRevealSecrets of [false, true]) {
      const audit = await new ConfigAdmin({ store, canRevealSecrets }).audit(testScope, {
        page: 1,
        size: 10,
        action: 'set',
      });
      expect(audit.data[0]?.after).toMatchObject({ masked: true });
      expect(JSON.stringify(audit.data[0]?.after)).not.toContain('secret-value');
    }
  });

  it('exposes scopes, keys and values', async () => {
    const { store, admin: a } = admin();
    await seedConfig(store, testScope, [
      ['a', 1],
      ['b', 2],
    ]);
    await seedConfig(store, { ...testScope, environment: 'staging' }, [['a', 3]]);
    expect(await a.scopes()).toEqual({
      apps: ['shop'],
      environments: ['production', 'staging'],
      labels: ['main'],
    });
    expect(await a.keys(testScope)).toEqual(['a', 'b']);
    expect(await a.values(testScope, true)).toEqual({ a: 1, b: 2 });
    expect(await a.defaultScope({ environment: 'production' })).toEqual(testScope);
  });
});
