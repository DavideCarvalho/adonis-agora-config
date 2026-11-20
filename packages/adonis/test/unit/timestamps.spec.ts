import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { generateKeyPair } from '../../src/crypto-kit/index.js';
import { query, type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { createConfigTables, missingConfigColumns } from '../../src/store/schema.js';
import type { ConfigStore } from '../../src/store/store.js';
import { testScope, testSecretCodec } from '../../src/testing/index.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function sqlite(): Promise<SqlDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-stamps-'));
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  closers.push(async () => {
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return database.connection() as unknown as SqlDatabase;
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

const stores: Array<[string, () => Promise<ConfigStore>]> = [
  ['MemoryStore', async () => new MemoryStore({ secretCodec: testSecretCodec('stamps') })],
  [
    'LucidStore (SQLite)',
    async () => {
      let clock = T1;
      const store = new LucidStore(await sqlite(), {
        secretCodec: testSecretCodec('stamps'),
        now: () => clock,
      });
      await store.setup();
      return Object.assign(store, { tick: (to: string) => (clock = to) });
    },
  ],
];

describe.each(stores)('timestamps in %s', (_name, open) => {
  it('stamps an entry: createdAt set once, updatedAt moves on every change', async () => {
    const admin = new ConfigAdmin({ store: await open() });
    await admin.setEntry(testScope, 'port', { value: 3000 }, { actor: 'ann', now: T1 });
    await admin.setEntry(testScope, 'host', { value: 'a' }, { actor: 'ann', now: T2 });
    await admin.setEntry(testScope, 'port', { value: 4000 }, { actor: 'bob', now: T3 });

    const port = await admin.getEntry(testScope, 'port', { canReadSecrets: true });
    expect(port).toMatchObject({ createdAt: T1, updatedAt: T3, updatedBy: 'bob' });
    const host = await admin.getEntry(testScope, 'host', { canReadSecrets: true });
    expect(host).toMatchObject({ createdAt: T2, updatedAt: T2 });

    const page = await admin.listEntries(testScope, true, { page: 1, size: 50 });
    expect(page.data.map((e) => [e.key, e.createdAt])).toEqual([
      ['host', T2],
      ['port', T1],
    ]);
    // The scope's current document: first written at T1, last changed at T3.
    expect(page.document).toEqual({ version: 3, createdAt: T1, updatedAt: T3 });

    // A key that is removed and set again is a new entry.
    await admin.unsetEntry(testScope, 'host', { actor: 'ann', now: T3 });
    await admin.setEntry(testScope, 'host', { value: 'b' }, { actor: 'ann', now: T3 });
    expect(await admin.getEntry(testScope, 'host', { canReadSecrets: true })).toMatchObject({
      createdAt: T3,
    });
  });

  it('has no document dates before the first write', async () => {
    const admin = new ConfigAdmin({ store: await open() });
    const page = await admin.listEntries(testScope, true, { page: 1, size: 50 });
    expect(page.document).toBeNull();
  });

  it('stamps tenant keys: updatedAt moves when one is activated or retired', async () => {
    const store = (await open()) as ConfigStore & { tick?: (to: string) => void };
    const first = generateKeyPair('x25519');
    const second = generateKeyPair('x25519');
    const register = (pair: typeof first, createdAt: string) =>
      store.registerTenantKey!({
        app: 'shop',
        kid: pair.publicKey.kid,
        publicKey: pair.publicKey,
        active: true,
        createdAt,
        createdBy: 'test',
      });
    store.tick?.(T1);
    await register(first, T1);
    expect((await store.listTenantKeys!('shop'))[0]).toMatchObject({
      createdAt: T1,
      updatedAt: T1,
    });

    store.tick?.(T2);
    await register(second, T2);
    const keys = new Map((await store.listTenantKeys!('shop')).map((k) => [k.kid, k]));
    const retired = keys.get(first.publicKey.kid)!;
    expect(retired).toMatchObject({ active: false, createdAt: T1 });
    expect(retired.updatedAt).not.toBe(T1);
    expect(keys.get(second.publicKey.kid)).toMatchObject({ active: true, updatedAt: T2 });

    // Registering the active key again changes nothing.
    store.tick?.(T3);
    await register(second, T3);
    const again = (await store.listTenantKeys!('shop')).find((k) => k.kid === second.publicKey.kid);
    expect(again?.updatedAt).toBe(T2);
  });
});

describe('timestamp columns on an existing schema', () => {
  it('adds the missing column as NULL-able, and older rows read as unknown', async () => {
    const db = await sqlite();
    // The table as an older version created it, with a key in it.
    await db.rawQuery(`CREATE TABLE config_tenant_keys (
      id varchar(36) NOT NULL PRIMARY KEY, app varchar(128) NOT NULL, kid varchar(128) NOT NULL,
      public_key text NOT NULL, active integer NOT NULL, created_by varchar(255) NOT NULL,
      created_at varchar(32) NOT NULL, CONSTRAINT config_tenant_keys_app_kid UNIQUE (app, kid))`);
    await db.rawQuery(
      `INSERT INTO config_tenant_keys VALUES ('1', 'shop', 'old', '{}', 1, 'test', '${T1}')`,
    );
    expect(await missingConfigColumns(db)).toEqual(['config_tenant_keys.updated_at']);

    await createConfigTables(db);
    expect(await missingConfigColumns(db)).toEqual([]);
    const [row] = await query<{ updated_at: unknown }>(
      db,
      'SELECT updated_at FROM config_tenant_keys',
    );
    expect(row?.updated_at).toBeNull();

    const store = new LucidStore(db, { autoCreateSchema: false });
    const [key] = await store.listTenantKeys('shop');
    expect(key?.createdAt).toBe(T1);
    expect(key?.updatedAt).toBeUndefined();

    await createConfigTables(db); // idempotent
  });

  it('shows null for an entry written before createdAt was recorded', async () => {
    const store = new MemoryStore();
    const admin = new ConfigAdmin({ store });
    await admin.setEntry(testScope, 'port', { value: 3000 }, { actor: 'ann', now: T1 });
    // An entry as an older version stored it: no createdAt.
    const document = (await store.read(testScope))!;
    delete document.entries.port!.createdAt;
    store.read = async () => document;
    const entry = await admin.getEntry(testScope, 'port', { canReadSecrets: true });
    expect(entry).toMatchObject({ createdAt: null, updatedAt: T1 });
  });
});
