import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { query, type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { testScope, testSecretCodec } from '../../src/testing/index.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function sqlite(): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-test-'));
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
  const close = async () => {
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  closers.push(close);
  return { db: database.connection() as unknown as SqlDatabase, close };
}

const at = new Date('2026-02-02T02:02:02.000Z').toISOString();

async function store(): Promise<LucidStore> {
  const { db } = await sqlite();
  const created = new LucidStore(db, {
    secretCodec: testSecretCodec('lucid-test-key'),
    now: () => at,
  });
  await created.setup();
  return created;
}

describe('LucidStore', () => {
  it('creates its tables and versions writes', async () => {
    const s = await store();
    const one = await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now: at });
    expect(one.document.version).toBe(1);
    const two = await s.write(testScope, [{ key: 'b', value: 2 }], { actor: 'bob', now: at });
    expect(two.document.version).toBe(2);
    expect((await s.read(testScope))?.entries.a?.value).toBe(1);
    expect((await s.readVersion(testScope, 1))?.entries.b).toBeUndefined();
    expect((await s.listVersions(testScope, { number: 1, size: 10 })).rows[0]).toMatchObject({
      version: 2,
      entries: 2,
    });
  });

  it('stores secrets as ciphertext in the column', async () => {
    const { db } = await sqlite();
    const s = new LucidStore(db, { secretCodec: testSecretCodec('lucid-test-key') });
    await s.setup();
    await s.write(testScope, [{ key: 'db.password', value: 'hunter2', secret: true }], {
      actor: 'ann',
      now: at,
    });
    const rows = await query<{ entries: string }>(
      db,
      'SELECT entries FROM config_versions ORDER BY version DESC LIMIT 1',
    );
    expect(rows[0]?.entries).not.toContain('hunter2');
    expect(rows[0]?.entries).toContain('agora:v1:');
    expect((await s.read(testScope))?.entries['db.password']?.value).toBe('hunter2');
  });

  it('refuses to store a secret without a key', async () => {
    const { db } = await sqlite();
    const s = new LucidStore(db);
    await s.setup();
    await expect(
      s.write(testScope, [{ key: 'p', value: 'x', secret: true }], { actor: 'ann', now: at }),
    ).rejects.toThrow(/no encryption keyring/);
  });

  it('rolls back and audits, filtered and paginated', async () => {
    const s = await store();
    await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now: at });
    await s.write(testScope, [{ key: 'a', value: 2 }], { actor: 'bob', now: at });
    const rolled = await s.rollback(testScope, 1, {
      actor: 'ops',
      now: at,
      message: 'back to 1',
    });
    expect(rolled.document.version).toBe(3);
    expect(rolled.document.entries.a?.value).toBe(1);

    const audit = await s.listAudit(testScope, { number: 1, size: 10 });
    expect(audit.total).toBe(3);
    expect(audit.rows[0]).toMatchObject({ action: 'rollback', actor: 'ops', version: 3 });
    expect((await s.listAudit(testScope, { number: 1, size: 10 }, { key: 'a' })).total).toBe(2);
    expect(
      (await s.listAudit(testScope, { number: 2, size: 2 })).rows.map((row) => row.action),
    ).toEqual(['set']);
  });

  it('lists scopes and pages versions', async () => {
    const s = await store();
    await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now: at });
    await s.write({ ...testScope, environment: 'staging' }, [{ key: 'a', value: 2 }], {
      actor: 'ann',
      now: at,
    });
    expect(await s.listScopes()).toEqual([
      { app: 'shop', environment: 'production', label: 'main' },
      { app: 'shop', environment: 'staging', label: 'main' },
    ]);
    for (let i = 0; i < 4; i += 1) {
      await s.write(testScope, [{ key: 'a', value: i + 2 }], { actor: 'ann', now: at });
    }
    const page = await s.listVersions(testScope, { number: 2, size: 2 });
    expect(page.total).toBe(5);
    expect(page.rows.map((row) => row.version)).toEqual([3, 2]);
  });

  it('records reveals', async () => {
    const s = await store();
    await s.write(testScope, [{ key: 'p', value: 'x', secret: true }], { actor: 'ann', now: at });
    await s.recordReveal(testScope, 'p', 1, 'ann');
    const reveals = await s.listAudit(testScope, { number: 1, size: 10 }, { action: 'reveal' });
    expect(reveals.total).toBe(1);
    expect(reveals.rows[0]).toMatchObject({ action: 'reveal', actor: 'ann', key: 'p' });
  });

  it('does not write a new version for a no-op', async () => {
    const s = await store();
    await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now: at });
    const same = await s.write(testScope, [{ key: 'a', value: 1 }], { actor: 'bob', now: at });
    expect(same.changed).toBe(false);
    expect((await s.listVersions(testScope, { number: 1, size: 10 })).total).toBe(1);
  });
});
