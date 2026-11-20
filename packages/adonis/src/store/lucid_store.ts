import { randomUUID } from 'node:crypto';
import {
  type ConfigAuditRecord,
  type ConfigDocument,
  type ConfigEntryInput,
  type ConfigEntryState,
  type ConfigScope,
} from '@adonis-agora/config-core';
import { entryAad, type SecretCodec } from '../crypto/secrets.js';
import {
  type Dialect,
  dialectOf,
  inSchema,
  jsonValue,
  parseJson,
  query,
  type SqlClient,
  type SqlDatabase,
  toNumber,
} from '../sql.js';
import { createConfigTables } from './schema.js';
import {
  type AuditPosition,
  applyChanges,
  auditRows,
  type ConfigStore,
  type CryptoStatusCounts,
  countsOf,
  DocumentSealer,
  emptyCryptoStatus,
  type ResealReport,
  resealStoredEntry,
  type StorePage,
  type TenantPublicKey,
  type TouchedEntry,
  type VersionSummary,
  type WriteContext,
  withScope,
} from './store.js';

export interface LucidStoreOptions {
  /** Create the tables at boot. Default `true` (the Agora convention). */
  autoCreateSchema?: boolean;
  /** Postgres schema / MySQL database for this package's tables. */
  schema?: string;
  secretCodec?: SecretCodec;
  /**
   * `redact` reads another app's store without its keys (the federated console): secret values and
   * vault references never leave the row, and every write is refused. Default `open`.
   */
  secrets?: 'open' | 'redact';
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

const AUDIT_COLUMNS =
  'id, app, environment, label, actor, action, entry_key, version, message, before, after, at';

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
  readonly db: SqlDatabase;
  readonly dialect: Dialect;
  readonly #sealer: DocumentSealer;
  readonly #now: () => string;

  constructor(
    db: SqlDatabase,
    private readonly options: LucidStoreOptions = {},
  ) {
    // Bind the client to the schema here as well, so a store constructed directly (a test, a
    // custom factory) names `schema.table` in every query, not only in `setup()`.
    this.db = inSchema(db, options.schema);
    this.dialect = dialectOf(this.db);
    this.#sealer = new DocumentSealer(options.secretCodec, options.secrets ?? 'open');
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Creates this package's tables (idempotent), unless `autoCreateSchema: false`. */
  async setup(): Promise<void> {
    if (this.options.autoCreateSchema === false) return;
    await createConfigTables(this.db);
  }

  #sealedDocument(row: VersionRow): ConfigDocument {
    return {
      app: row.app,
      environment: row.environment,
      label: row.label,
      version: toNumber(row.version),
      entries: parseJson<Record<string, ConfigEntryState>>(row.entries),
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      createdBy: row.created_by,
      ...(row.message ? { message: row.message } : {}),
    };
  }

  async #document(row: VersionRow): Promise<ConfigDocument> {
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
    return rows[0] ? await this.#document(rows[0]) : null;
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
    return rows[0] ? await this.#document(rows[0]) : null;
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
      rows: await Promise.all(rows.map(async (row) => this.#summary(row))),
    };
  }

  async seekVersions(
    scope: ConfigScope,
    query_: { limit: number; order: 'asc' | 'desc'; from?: number },
  ): Promise<VersionSummary[]> {
    const order = query_.order === 'asc' ? 'ASC' : 'DESC';
    const seek =
      query_.from === undefined ? '' : ` AND version ${query_.order === 'asc' ? '>' : '<'} ?`;
    const rows = await query<VersionRow>(
      this.db,
      `SELECT ${DOCUMENT_COLUMNS} FROM config_versions
       WHERE app = ? AND environment = ? AND label = ?${seek}
       ORDER BY version ${order} LIMIT ?`,
      [
        scope.app,
        scope.environment,
        scope.label,
        ...(query_.from === undefined ? [] : [query_.from]),
        query_.limit,
      ],
    );
    return rows.map((row) => this.#summary(row));
  }

  /** One version row as history lists it: counts, never the entries. */
  #summary(row: VersionRow): VersionSummary {
    const document = this.#sealedDocument(row);
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
        jsonValue((await this.#sealer.sealDocument(document)).entries),
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
    for (const row of await auditRows(
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
              jsonValue((await this.#sealer.sealDocument(document)).entries),
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

  async #audit(row: AuditRow): Promise<ConfigAuditRecord> {
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
      `SELECT ${AUDIT_COLUMNS} FROM config_audit WHERE ${clause}
       ORDER BY at DESC, version DESC, id DESC LIMIT ? OFFSET ?`,
      [...bindings, page.size, (page.number - 1) * page.size],
    );
    return {
      rows: await Promise.all(rows.map((row) => this.#audit(row))),
      total: toNumber(total[0]?.total),
    };
  }

  async seekAudit(
    scope: ConfigScope,
    query_: {
      limit: number;
      after?: AuditPosition;
      filters?: { key?: string; action?: string };
    },
  ): Promise<ConfigAuditRecord[]> {
    const where = ['app = ?', 'environment = ?', 'label = ?'];
    const bindings: unknown[] = [scope.app, scope.environment, scope.label];
    const filters = query_.filters ?? {};
    if (filters.key !== undefined) {
      where.push('entry_key = ?');
      bindings.push(filters.key);
    }
    if (filters.action !== undefined) {
      where.push('action = ?');
      bindings.push(filters.action);
    }
    const after = query_.after;
    if (after !== undefined) {
      // `(at, version, id) < (?, ?, ?)`, spelled so every dialect still range-scans `at`.
      where.push('at <= ? AND (at < ? OR version < ? OR (version = ? AND id < ?))');
      bindings.push(after.at, after.at, after.version, after.version, after.id);
    }
    const rows = await query<AuditRow>(
      this.db,
      `SELECT ${AUDIT_COLUMNS} FROM config_audit WHERE ${where.join(' AND ')}
       ORDER BY at DESC, version DESC, id DESC LIMIT ?`,
      [...bindings, query_.limit],
    );
    return Promise.all(rows.map((row) => this.#audit(row)));
  }

  async #reseal(dryRun: boolean, all: boolean): Promise<ResealReport> {
    const report: ResealReport = {
      dryRun,
      all,
      scanned: 0,
      resealed: 0,
      failed: 0,
      statuses: emptyCryptoStatus(),
    };
    const codec = this.#sealer.secretCodec;
    if (!codec) return report;

    const versions = await query<{
      id: string;
      app: string;
      environment: string;
      entries: unknown;
    }>(this.db, 'SELECT id, app, environment, entries FROM config_versions');
    for (const row of versions) {
      const entries = parseJson<Record<string, ConfigEntryState>>(row.entries);
      let changed = false;
      for (const [key, entry] of Object.entries(entries)) {
        const next = await resealStoredEntry(
          entry,
          entryAad({ app: row.app, environment: row.environment }, key),
          codec,
          dryRun,
          all,
          report,
        );
        if (next !== entry) {
          entries[key] = next;
          changed = true;
        }
      }
      if (changed && !dryRun) {
        await query(this.db, 'UPDATE config_versions SET entries = ? WHERE id = ?', [
          jsonValue(entries),
          row.id,
        ]);
      }
    }

    const audit = await query<{
      id: string;
      app: string;
      environment: string;
      entry_key: string | null;
      before: unknown;
      after: unknown;
    }>(this.db, 'SELECT id, app, environment, entry_key, before, after FROM config_audit');
    for (const row of audit) {
      const aad = entryAad({ app: row.app, environment: row.environment }, row.entry_key ?? '');
      const before = parseJson<ConfigEntryState | null>(row.before);
      const after = parseJson<ConfigEntryState | null>(row.after);
      const nextBefore = before
        ? await resealStoredEntry(before, aad, codec, dryRun, all, report)
        : before;
      const nextAfter = after
        ? await resealStoredEntry(after, aad, codec, dryRun, all, report)
        : after;
      if ((nextBefore !== before || nextAfter !== after) && !dryRun) {
        await query(this.db, 'UPDATE config_audit SET before = ?, after = ? WHERE id = ?', [
          jsonValue(nextBefore),
          jsonValue(nextAfter),
          row.id,
        ]);
      }
    }
    return report;
  }

  async cryptoStatus(): Promise<CryptoStatusCounts> {
    return (await this.#reseal(true, false)).statuses;
  }

  async reseal(options: { dryRun?: boolean; all?: boolean } = {}): Promise<ResealReport> {
    return this.#reseal(options.dryRun === true, options.all === true);
  }

  async listTenantKeys(app: string): Promise<TenantPublicKey[]> {
    const rows = await query<{
      app: string;
      kid: string;
      public_key: unknown;
      active: unknown;
      created_by: string;
      created_at: string;
      updated_at?: string | null;
    }>(
      this.db,
      // `SELECT *`: a federated console may read an app whose table predates `updated_at`.
      `SELECT * FROM config_tenant_keys
       WHERE app = ? ORDER BY created_at DESC, id DESC`,
      [app],
    );
    return rows.map((row) => ({
      app: row.app,
      kid: row.kid,
      publicKey: parseJson<Record<string, unknown>>(
        row.public_key,
      ) as unknown as TenantPublicKey['publicKey'],
      active: toNumber(row.active) === 1,
      createdBy: row.created_by,
      createdAt: row.created_at,
      ...(row.updated_at ? { updatedAt: String(row.updated_at) } : {}),
    }));
  }

  async registerTenantKey(key: TenantPublicKey): Promise<{ created: boolean }> {
    const existing = await query<{ id: string }>(
      this.db,
      'SELECT id FROM config_tenant_keys WHERE app = ? AND kid = ? LIMIT 1',
      [key.app, key.kid],
    );
    const now = this.#now();
    // One active key per app: deactivate the previous one, then activate this one when asked.
    if (key.active) {
      await query(
        this.db,
        // Only rows that change: a re-registered active key keeps its `updated_at`.
        'UPDATE config_tenant_keys SET active = 0, updated_at = ? WHERE app = ? AND active = 1 AND kid <> ?',
        [now, key.app, key.kid],
      );
    }
    if (existing.length > 0) {
      if (key.active) {
        await query(
          this.db,
          'UPDATE config_tenant_keys SET active = 1, updated_at = ? WHERE app = ? AND kid = ? AND active = 0',
          [now, key.app, key.kid],
        );
      }
      return { created: false };
    }
    try {
      await query(
        this.db,
        `INSERT INTO config_tenant_keys (id, app, kid, public_key, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          key.app,
          key.kid,
          jsonValue(key.publicKey),
          key.active ? 1 : 0,
          key.createdBy,
          key.createdAt,
          key.createdAt,
        ],
      );
      return { created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { created: false };
    }
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
