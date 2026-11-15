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
