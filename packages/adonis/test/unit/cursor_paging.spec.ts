import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import type { SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import {
  CONFIG_AUDIT_INDEXES,
  createConfigAuditIndexes,
  dropConfigAuditIndexes,
} from '../../src/store/schema.js';
import type { ConfigStore } from '../../src/store/store.js';
import { testScope, testSecretCodec } from '../../src/testing/index.js';

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Lucid over SQLite, or over Postgres when `CONFIG_TEST_PG_URL` names one (CI has none). */
async function lucidDb(client: 'sqlite' | 'pg'): Promise<SqlDatabase> {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-cursor-'));
  const connection =
    client === 'sqlite'
      ? {
          client: 'better-sqlite3' as const,
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        }
      : { client: 'pg' as const, connection: process.env.CONFIG_TEST_PG_URL as string };
  const database = new Database(
    { connection: 'main', connections: { main: connection } },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  closers.push(async () => {
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return database.connection() as unknown as SqlDatabase;
}

/**
 * Twelve writes at three instants (most share `at`), each touching two keys — so most audit rows
 * share `at` AND `version`, and only the id keeps the pages apart.
 */
async function seed(store: ConfigStore, scope = testScope): Promise<void> {
  for (let n = 0; n < 12; n++) {
    const now = new Date(Date.UTC(2026, 10, 17, 10, 0, Math.floor(n / 5))).toISOString();
    await store.write(
      scope,
      [
        { key: `k${n % 3}`, value: n },
        { key: `other${n}`, value: n },
      ],
      { actor: 'ann', now },
    );
  }
}

type Walkable<T> = (after?: string) => Promise<{
  data: T[];
  meta: { nextCursor: string | null; hasNext: boolean; hasPrev: boolean };
}>;

async function walk<T>(read: Walkable<T>): Promise<T[][]> {
  const pages: T[][] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 40; guard++) {
    const page = await read(after);
    expect(page.meta.hasPrev).toBe(after !== undefined);
    pages.push(page.data);
    if (!page.meta.hasNext) return pages;
    after = page.meta.nextCursor ?? undefined;
  }
  throw new Error('no last page');
}

function suite(name: string, make: () => Promise<ConfigStore>) {
  describe(`cursor paging (${name})`, () => {
    let admin: ConfigAdmin;
    beforeAll(async () => {
      const store = await make();
      await store.setup?.();
      await seed(store);
      admin = new ConfigAdmin({ store });
    });

    it('walks the audit trail once, newest first, across ties on at and version', async () => {
      const all = (await admin.audit(testScope, { page: 1, size: 200 })).data.map((r) => r.id);
      expect(all).toHaveLength(24);
      const pages = await walk((after) =>
        admin.auditCursor(testScope, { size: 5, ...(after ? { after } : {}) }),
      );
      const ids = pages.flat().map((row) => row.id);
      expect(new Set(ids).size).toBe(24);
      // The cursor walk and the offset listing agree on the order.
      expect(ids).toEqual(all);
      expect(pages.map((page) => page.length)).toEqual([5, 5, 5, 5, 4]);
    });

    it('keeps the key filter on every page', async () => {
      const k1 = (
        await walk((after) =>
          admin.auditCursor(testScope, { size: 1, key: 'k1', ...(after ? { after } : {}) }),
        )
      ).flat();
      expect(k1).toHaveLength(4);
      expect(k1.every((row) => row.key === 'k1')).toBe(true);
    });

    it('walks the versions both ways', async () => {
      const desc = (
        await walk((after) =>
          admin.versionsCursor(testScope, { size: 5, ...(after ? { after } : {}) }),
        )
      )
        .flat()
        .map((v) => v.version);
      expect(desc).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      const asc = (
        await walk((after) =>
          admin.versionsCursor(testScope, {
            size: 7,
            direction: 'asc',
            ...(after ? { after } : {}),
          }),
        )
      )
        .flat()
        .map((v) => v.version);
      expect(asc).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('refuses a cursor it did not issue', async () => {
      await expect(admin.auditCursor(testScope, { size: 5, after: 'nope' })).rejects.toThrow(
        /invalid cursor/,
      );
      await expect(admin.versionsCursor(testScope, { size: 5, after: 'nope' })).rejects.toThrow(
        /invalid cursor/,
      );
    });

    it('still pages by page/size with a total', async () => {
      const page = await admin.audit(testScope, { page: 2, size: 10 });
      expect(page.meta).toMatchObject({ total: 24, currentPage: 2, lastPage: 3 });
    });
  });
}

const codec = () => ({ secretCodec: testSecretCodec('cursor-test-key') });
suite('memory', async () => new MemoryStore(codec()));
suite('sqlite', async () => new LucidStore(await lucidDb('sqlite'), codec()));
if (process.env.CONFIG_TEST_PG_URL) {
  suite('postgres', async () => {
    const db = await lucidDb('pg');
    const schema = `cfg_${randomBytes(4).toString('hex')}`;
    closers.unshift(async () => {
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
    return new LucidStore(db, { ...codec(), schema });
  });
}

describe('the opt-in audit indexes', () => {
  const backends: Array<'sqlite' | 'pg'> = process.env.CONFIG_TEST_PG_URL
    ? ['sqlite', 'pg']
    : ['sqlite'];
  for (const backend of backends) {
    it(`create once, re-run as a no-op, and drop (${backend})`, async () => {
      const db = await lucidDb(backend);
      const schema = backend === 'pg' ? `cfgidx_${randomBytes(4).toString('hex')}` : undefined;
      if (schema) {
        closers.unshift(async () => {
          await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        });
      }
      const store = new LucidStore(db, { ...codec(), ...(schema ? { schema } : {}) });
      await store.setup();
      const options = schema ? { schema } : {};
      await createConfigAuditIndexes(db, options);
      await createConfigAuditIndexes(db, options);
      await dropConfigAuditIndexes(db, options);
      await dropConfigAuditIndexes(db, options);
      await createConfigAuditIndexes(db, options);
      await seed(store);
      const admin = new ConfigAdmin({ store });
      expect((await admin.auditCursor(testScope, { size: 3, key: 'k0' })).data).toHaveLength(3);
      expect(CONFIG_AUDIT_INDEXES.length).toBe(3);
    });
  }
});
