import { describe, expect, it } from 'vitest';
import { CONFIG_TABLES, inSchema, qualifyTables } from '../../src/sql.js';
import { createConfigTables, dropConfigTables } from '../../src/store/schema.js';

function fakeDb(name = 'postgres') {
  const calls: string[] = [];
  const db = {
    dialect: { name },
    async transaction<T>(callback: (trx: never) => Promise<T>): Promise<T> {
      return callback(db as never);
    },
    async rawQuery(sql: string) {
      calls.push(sql);
      return { rows: [] };
    },
  };
  return { db, calls };
}

describe('config schema', () => {
  it('owns every table, including the tenant public keys', () => {
    expect(CONFIG_TABLES).toEqual(['config_versions', 'config_audit', 'config_tenant_keys']);
    const sql = 'SELECT * FROM config_versions JOIN config_tenant_keys USING (app)';
    expect(qualifyTables(sql, 'agora', 'postgres')).toBe(
      'SELECT * FROM "agora".config_versions JOIN "agora".config_tenant_keys USING (app)',
    );
    // The constraint name contains `config_versions` but is not a table reference.
    expect(
      qualifyTables('CONSTRAINT config_versions_scope_version UNIQUE (app)', 'agora', 'postgres'),
    ).toBe('CONSTRAINT config_versions_scope_version UNIQUE (app)');
  });

  it('creates the schema and names every table for Postgres', async () => {
    const { db, calls } = fakeDb();
    await createConfigTables(db as never, { schema: 'agora' });
    expect(calls[0]).toBe('CREATE SCHEMA IF NOT EXISTS "agora"');
    const ddl = calls.join('\n');
    for (const table of CONFIG_TABLES) expect(ddl).toContain(`"agora".${table}`);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "agora".config_tenant_keys');
  });

  it('uses the MySQL database syntax, and leaves no schema unqualified', async () => {
    const { db, calls } = fakeDb('mysql');
    await createConfigTables(db as never, { schema: 'agora' });
    expect(calls[0]).toBe('CREATE DATABASE IF NOT EXISTS `agora`');
    expect(calls.join('\n')).toContain('`agora`.config_versions');
  });

  it('keeps the default schema when none is configured', async () => {
    const { db, calls } = fakeDb();
    await createConfigTables(db as never);
    expect(calls.join('\n')).not.toContain('CREATE SCHEMA');
    expect(calls.join('\n')).toContain('CREATE TABLE IF NOT EXISTS config_versions');
  });

  it('drops in the schema too, and refuses a schema on SQLite', async () => {
    const { db, calls } = fakeDb();
    await dropConfigTables(db as never, { schema: 'agora' });
    expect(calls.join('\n')).toContain('DROP TABLE IF EXISTS "agora".config_tenant_keys');
    expect(() =>
      inSchema({ dialect: { name: 'sqlite' }, rawQuery: db.rawQuery } as never, 'x'),
    ).toThrow(/needs Postgres or MySQL/);
  });
});
