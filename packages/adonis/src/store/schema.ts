import { dialectOf, inSchema, query, type SqlClient, type SqlDatabase, schemaOf } from '../sql.js';

/** Where the config tables live. `schema` is a Postgres schema / MySQL database. */
export interface ConfigSchemaOptions {
  schema?: string;
}

/** Every statement the store needs, portable across SQLite, Postgres and MySQL. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS config_versions (
    id varchar(36) NOT NULL PRIMARY KEY,
    app varchar(128) NOT NULL,
    environment varchar(128) NOT NULL,
    label varchar(128) NOT NULL,
    version integer NOT NULL,
    entries text NOT NULL,
    fingerprint varchar(32) NOT NULL,
    message text NULL,
    created_by varchar(255) NOT NULL,
    created_at varchar(32) NOT NULL,
    CONSTRAINT config_versions_scope_version UNIQUE (app, environment, label, version)
  )`,
  `CREATE TABLE IF NOT EXISTS config_audit (
    id varchar(36) NOT NULL PRIMARY KEY,
    app varchar(128) NOT NULL,
    environment varchar(128) NOT NULL,
    label varchar(128) NOT NULL,
    actor varchar(255) NOT NULL,
    action varchar(16) NOT NULL,
    entry_key varchar(255) NULL,
    version integer NOT NULL,
    message text NULL,
    before text NULL,
    after text NULL,
    at varchar(32) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS config_tenant_keys (
    id varchar(36) NOT NULL PRIMARY KEY,
    app varchar(128) NOT NULL,
    kid varchar(128) NOT NULL,
    public_key text NOT NULL,
    active integer NOT NULL,
    created_by varchar(255) NOT NULL,
    created_at varchar(32) NOT NULL,
    CONSTRAINT config_tenant_keys_app_kid UNIQUE (app, kid)
  )`,
] as const;

const DROPS = [
  'DROP TABLE IF EXISTS config_tenant_keys',
  'DROP TABLE IF EXISTS config_audit',
  'DROP TABLE IF EXISTS config_versions',
] as const;

/**
 * Creates this package's tables, optionally in their own schema/database. When `schema` is set the
 * schema is created first (Postgres `CREATE SCHEMA` / MySQL `CREATE DATABASE`), and every statement
 * names its tables as `schema.table` — the same behavior as {@link inSchema}, so it is safe behind
 * PgBouncer and never depends on `search_path`.
 *
 * Both the boot-time setup (`autoCreateSchema`) and the published migration call this, so the two
 * paths cannot drift.
 */
export async function createConfigTables(
  db: SqlDatabase,
  options: ConfigSchemaOptions = {},
): Promise<void> {
  const client = inSchema(db, options.schema);
  const dialect = dialectOf(client);
  const schema = schemaOf(client);
  if (schema) {
    await query(
      client,
      dialect === 'mysql'
        ? `CREATE DATABASE IF NOT EXISTS \`${schema}\``
        : `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    );
  }
  for (const sql of TABLES) await query(client, sql);
}

/** Drops every table this package owns (tests and the migration's `down`). */
export async function dropConfigTables(
  db: SqlDatabase,
  options: ConfigSchemaOptions = {},
): Promise<void> {
  const client: SqlClient = inSchema(db, options.schema);
  for (const sql of DROPS) await query(client, sql);
}

/**
 * The audit trail's list indexes: the console's Audit page (and `GET /audit`) reads a scope's
 * newest rows, filtered or not, straight from an index instead of sorting every row of the scope.
 * Not part of {@link createConfigTables} (boot): on a table that already holds years of rows the
 * build is long, so they ship as the opt-in `add_config_audit_indexes` migration.
 */
export const CONFIG_AUDIT_INDEXES: ReadonlyArray<readonly [name: string, columns: string]> = [
  ['config_audit_scope_at_idx', 'app, environment, label, at, version, id'],
  ['config_audit_scope_key_at_idx', 'app, environment, label, entry_key, at'],
  ['config_audit_scope_action_at_idx', 'app, environment, label, action, at'],
];

/**
 * Creates the missing {@link CONFIG_AUDIT_INDEXES} — what the opt-in migration runs, once, on an
 * existing install. On Postgres each is built `CONCURRENTLY IF NOT EXISTS`, so writes go on while
 * it builds (run it outside a transaction).
 */
export async function createConfigAuditIndexes(
  db: SqlDatabase,
  options: ConfigSchemaOptions = {},
): Promise<void> {
  const client = inSchema(db, options.schema);
  const dialect = dialectOf(client);
  for (const [name, columns] of CONFIG_AUDIT_INDEXES) {
    if (dialect === 'postgres') {
      await query(
        client,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON config_audit (${columns})`,
      );
    } else if (dialect === 'mysql') {
      // MySQL has no `IF NOT EXISTS` on an index: a duplicate name means it is already there.
      try {
        await query(client, `CREATE INDEX ${name} ON config_audit (${columns})`);
      } catch (error) {
        if (!/duplicate key name|already exists/i.test((error as Error).message)) throw error;
      }
    } else {
      await query(client, `CREATE INDEX IF NOT EXISTS ${name} ON config_audit (${columns})`);
    }
  }
}

/** Drops {@link CONFIG_AUDIT_INDEXES} (the opt-in migration's `down`). */
export async function dropConfigAuditIndexes(
  db: SqlDatabase,
  options: ConfigSchemaOptions = {},
): Promise<void> {
  const client = inSchema(db, options.schema);
  const dialect = dialectOf(client);
  const schema = schemaOf(client);
  for (const [name] of CONFIG_AUDIT_INDEXES) {
    if (dialect === 'mysql') {
      try {
        await query(client, `DROP INDEX ${name} ON config_audit`);
      } catch (error) {
        if (!/check that|can't drop/i.test((error as Error).message)) throw error;
      }
      continue;
    }
    // A Postgres index lives in its table's schema, so it is named through it.
    const ref = schema && dialect === 'postgres' ? `"${schema}".${name}` : name;
    await query(
      client,
      `DROP INDEX ${dialect === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS ${ref}`,
    );
  }
}
