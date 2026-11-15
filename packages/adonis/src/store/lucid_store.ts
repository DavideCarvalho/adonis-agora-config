import { randomUUID } from 'node:crypto';
import {
  type ConfigAuditRecord,
  type ConfigDocument,
  type ConfigEntryInput,
  type ConfigEntryState,
  type ConfigScope,
} from '@adonis-agora/config-core';
import type { SecretCodec } from '../crypto/secrets.js';
import {
  type Dialect,
  dialectOf,
  jsonValue,
  parseJson,
  query,
  type SqlClient,
  type SqlDatabase,
  toNumber,
} from '../sql.js';
import {
  applyChanges,
  auditRows,
  type ConfigStore,
  countsOf,
  DocumentSealer,
  type StorePage,
  type TouchedEntry,
  type VersionSummary,
  type WriteContext,
  withScope,
} from './store.js';

export interface LucidStoreOptions {
  /** Create the two tables at boot. Default `true` (the Agora convention). */
  autoCreateSchema?: boolean;
  secretCodec?: SecretCodec;
  /** Clock, so tests can pin timestamps. */
  now?: () => string;
}

interface VersionRow {
  app: string;
  environment: string;
  label: string;
  version: unknown;
  entries: unknown;
  fingerprint: string;
  message: string | null;
  created_by: string;
  created_at: string;
}

interface AuditRow {
  id: string;
  app: string;
  environment: string;
  label: string;
  actor: string;
  action: string;
  entry_key: string | null;
  version: unknown;
  message: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

const DOCUMENT_COLUMNS =
  'app, environment, label, version, entries, fingerprint, message, created_by, created_at';

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|duplicate|constraint/i.test(message);
}

/**
 * The configuration in your database, through Lucid: Postgres, MySQL or SQLite. One row per version
 * of a scope; secrets are sealed before they reach the column. A write runs in one transaction and
 * retries on the unique `(app, environment, label, version)` constraint, so two replicas writing at
 * once still produce two ordered versions.
 */
export class LucidStore implements ConfigStore {
  readonly dialect: Dialect;
  readonly #sealer: DocumentSealer;
  readonly #now: () => string;

  constructor(
    readonly db: SqlDatabase,
    private readonly options: LucidStoreOptions = {},
  ) {
    this.dialect = dialectOf(db);
    this.#sealer = new DocumentSealer(options.secretCodec);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Creates this package's tables (idempotent), unless `autoCreateSchema: false`. */
  async setup(): Promise<void> {
    if (this.options.autoCreateSchema === false) return;
    await query(
      this.db,
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
    );
    await query(
      this.db,
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
    );
  }

  #document(row: VersionRow): ConfigDocument {
    return this.#sealer.openDocument({
      app: row.app,
      environment: row.environment,
      label: row.label,
      version: toNumber(row.version),
      entries: parseJson<Record<string, ConfigEntryState>>(row.entries),
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      createdBy: row.created_by,
      ...(row.message ? { message: row.message } : {}),
    });
  }

  async #latest(client: SqlClient, scope: ConfigScope): Promise<ConfigDocument | null> {
    const rows = await query<VersionRow>(
      client,
      `SELECT ${DOCUMENT_COLUMNS} FROM config_versions
       WHERE app = ? AND environment = ? AND label = ?
       ORDER BY version DESC LIMIT 1`,
      [scope.app, scope.environment, scope.label],
    );
    return rows[0] ? this.#document(rows[0]) : null;
  }

  async read(scope: ConfigScope): Promise<ConfigDocument | null> {
    return this.#latest(this.db, scope);
  }

  async readVersion(scope: ConfigScope, version: number): Promise<ConfigDocument | null> {
    const rows = await query<VersionRow>(
      this.db,
      `SELECT ${DOCUMENT_COLUMNS} FROM config_versions
       WHERE app = ? AND environment = ? AND label = ? AND version = ? LIMIT 1`,
      [scope.app, scope.environment, scope.label, version],
    );
    return rows[0] ? this.#document(rows[0]) : null;
  }

  async listVersions(
    scope: ConfigScope,
    page: { number: number; size: number },
  ): Promise<StorePage<VersionSummary>> {
    const total = await query<{ total: unknown }>(
      this.db,
      `SELECT count(*) AS total FROM config_versions WHERE app = ? AND environment = ? AND label = ?`,
      [scope.app, scope.environment, scope.label],
    );
    const rows = await query<VersionRow>(
      this.db,
      `SELECT ${DOCUMENT_COLUMNS} FROM config_versions
       WHERE app = ? AND environment = ? AND label = ?
       ORDER BY version DESC LIMIT ? OFFSET ?`,
      [scope.app, scope.environment, scope.label, page.size, (page.number - 1) * page.size],
    );
    return {
      total: toNumber(total[0]?.total),
      rows: rows.map((row) => {
        const document = this.#document(row);
        const counts = countsOf(document);
        return {
          version: document.version,
          createdAt: document.createdAt,
          createdBy: document.createdBy,
          ...(document.message !== undefined ? { message: document.message } : {}),
          entries: counts.entries,
          secrets: counts.secrets,
          fingerprint: document.fingerprint,
        };
      }),
    };
  }

  async listScopes(): Promise<ConfigScope[]> {
    const rows = await query<{ app: string; environment: string; label: string }>(
      this.db,
      `SELECT DISTINCT app, environment, label FROM config_versions
       ORDER BY app ASC, environment ASC, label ASC`,
    );
    return rows.map(({ app, environment, label }) => ({ app, environment, label }));
  }

  /** Inserts a version and its audit rows; the caller owns the transaction. */
  async #insert(
    client: SqlClient,
    document: ConfigDocument,
    touched: TouchedEntry[],
    context: WriteContext,
  ): Promise<void> {
    await query(
      client,
      `INSERT INTO config_versions
       (id, app, environment, label, version, entries, fingerprint, message, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        document.app,
        document.environment,
        document.label,
        document.version,
        jsonValue(this.#sealer.sealDocument(document).entries),
        document.fingerprint,
        document.message ?? null,
        document.createdBy,
        document.createdAt,
      ],
    );
    const scope = {
      app: document.app,
      environment: document.environment,
      label: document.label,
    };
    for (const row of auditRows(
      scope,
      document.version,
      touched,
      context,
      this.#sealer,
      randomUUID,
    )) {
      await query(
        client,
        `INSERT INTO config_audit
         (id, app, environment, label, actor, action, entry_key, version, message, before, after, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.app,
          row.environment,
          row.label,
          row.actor,
          row.action,
          row.key ?? null,
          row.version,
          row.message ?? null,
          jsonValue(row.before ?? null),
          jsonValue(row.after ?? null),
          row.at,
        ],
      );
    }
  }

  async write(
    scope: ConfigScope,
    changes: ConfigEntryInput[],
    context: WriteContext,
  ): Promise<{ document: ConfigDocument; changed: boolean; touched: TouchedEntry[] }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.transaction(async (trx) => {
          const current = await this.#latest(trx, scope);
          const result = applyChanges(current, changes, context);
          const document = withScope(result.document, scope);
          if (result.changed) await this.#insert(trx, document, result.touched, context);
          return { document, changed: result.changed, touched: result.touched };
        });
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw lastError;
  }

  async rollback(
    scope: ConfigScope,
    toVersion: number,
    context: WriteContext,
  ): Promise<{ document: ConfigDocument; changed: boolean }> {
    const target = await this.readVersion(scope, toVersion);
    if (!target) throw new Error(`config: version ${toVersion} does not exist for ${scope.app}`);
    const entries: Record<string, ConfigEntryState> = Object.fromEntries(
      Object.entries(target.entries).map(([key, entry]) => [
        key,
        { ...entry, updatedAt: context.now, updatedBy: context.actor },
      ]),
    );
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.transaction(async (trx) => {
          const current = await this.#latest(trx, scope);
          const document: ConfigDocument = {
            ...scope,
            version: (current?.version ?? 0) + 1,
            entries,
            createdAt: context.now,
            createdBy: context.actor,
            ...(context.message !== undefined ? { message: context.message } : {}),
            fingerprint: target.fingerprint,
          };
          if (current?.fingerprint === document.fingerprint) {
            return { document: current, changed: false };
          }
          await query(
            trx,
            `INSERT INTO config_versions
             (id, app, environment, label, version, entries, fingerprint, message, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              scope.app,
              scope.environment,
              scope.label,
              document.version,
              jsonValue(this.#sealer.sealDocument(document).entries),
              document.fingerprint,
              document.message ?? null,
              document.createdBy,
              document.createdAt,
            ],
          );
          await query(
            trx,
            `INSERT INTO config_audit
             (id, app, environment, label, actor, action, entry_key, version, message, before, after, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              scope.app,
              scope.environment,
              scope.label,
              context.actor,
              'rollback',
              null,
              document.version,
              context.message ?? null,
              null,
              null,
              context.now,
            ],
          );
          return { document, changed: true };
        });
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw lastError;
  }

  #audit(row: AuditRow): ConfigAuditRecord {
    const before = parseJson<ConfigEntryState | null>(row.before);
    const after = parseJson<ConfigEntryState | null>(row.after);
    return this.#sealer.openAudit({
      id: row.id,
      app: row.app,
      environment: row.environment,
      label: row.label,
      actor: row.actor,
      action: row.action as ConfigAuditRecord['action'],
      ...(row.entry_key ? { key: row.entry_key } : {}),
      version: toNumber(row.version),
      ...(row.message ? { message: row.message } : {}),
      at: row.at,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  }

  async listAudit(
    scope: ConfigScope,
    page: { number: number; size: number },
    filters: { key?: string; action?: string } = {},
  ): Promise<StorePage<ConfigAuditRecord>> {
    const where = ['app = ?', 'environment = ?', 'label = ?'];
    const bindings: unknown[] = [scope.app, scope.environment, scope.label];
    if (filters.key !== undefined) {
      where.push('entry_key = ?');
      bindings.push(filters.key);
    }
    if (filters.action !== undefined) {
      where.push('action = ?');
      bindings.push(filters.action);
    }
    const clause = where.join(' AND ');
    const total = await query<{ total: unknown }>(
      this.db,
      `SELECT count(*) AS total FROM config_audit WHERE ${clause}`,
      bindings,
    );
    const rows = await query<AuditRow>(
      this.db,
      `SELECT id, app, environment, label, actor, action, entry_key, version, message, before, after, at
       FROM config_audit WHERE ${clause}
       ORDER BY at DESC, version DESC LIMIT ? OFFSET ?`,
      [...bindings, page.size, (page.number - 1) * page.size],
    );
    return { rows: rows.map((row) => this.#audit(row)), total: toNumber(total[0]?.total) };
  }

  async recordReveal(
    scope: ConfigScope,
    key: string,
    version: number,
    actor: string,
  ): Promise<void> {
    await query(
      this.db,
      `INSERT INTO config_audit
       (id, app, environment, label, actor, action, entry_key, version, message, before, after, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        scope.app,
        scope.environment,
        scope.label,
        actor,
        'reveal',
        key,
        version,
        null,
        null,
        null,
        this.#now(),
      ],
    );
  }
}
