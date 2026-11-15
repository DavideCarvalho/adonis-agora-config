import { randomUUID } from 'node:crypto';
import {
  type ConfigAuditRecord,
  type ConfigDocument,
  type ConfigEntryInput,
  type ConfigEntryState,
  type ConfigScope,
  fingerprintOf,
} from '@adonis-agora/config-core';
import { entryAad, type SecretCodec } from '../crypto/secrets.js';
import {
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
  scopeKey,
  type TenantPublicKey,
  type TouchedEntry,
  type VersionSummary,
  type WriteContext,
  withScope,
} from './store.js';

/**
 * The configuration in process memory: tests, local development, and the console's demo. Versions
 * are kept sealed (secret values encrypted), exactly like the database store.
 */
export class MemoryStore implements ConfigStore {
  readonly #versions = new Map<string, ConfigDocument[]>();
  readonly #audit: ConfigAuditRecord[] = [];
  readonly #sealer: DocumentSealer;
  /** app → its public keys, in registration order (the latest registration last). */
  readonly #tenantKeys = new Map<string, TenantPublicKey[]>();

  constructor(options: { secretCodec?: SecretCodec } = {}) {
    this.#sealer = new DocumentSealer(options.secretCodec);
  }

  async #latest(scope: ConfigScope): Promise<ConfigDocument | null> {
    const sealed = this.#versions.get(scopeKey(scope))?.at(-1);
    return sealed ? this.#sealer.openDocument(sealed) : null;
  }

  async read(scope: ConfigScope): Promise<ConfigDocument | null> {
    return this.#latest(scope);
  }

  async readVersion(scope: ConfigScope, version: number): Promise<ConfigDocument | null> {
    const sealed = this.#versions.get(scopeKey(scope))?.find((doc) => doc.version === version);
    return sealed ? this.#sealer.openDocument(sealed) : null;
  }

  async listVersions(
    scope: ConfigScope,
    page: { number: number; size: number },
  ): Promise<StorePage<VersionSummary>> {
    const all = [...(this.#versions.get(scopeKey(scope)) ?? [])].reverse();
    const start = (page.number - 1) * page.size;
    return {
      rows: all.slice(start, start + page.size).map((document) => {
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
      total: all.length,
    };
  }

  async listScopes(): Promise<ConfigScope[]> {
    return [...this.#versions.values()]
      .map((versions) => versions.at(-1))
      .filter((document): document is ConfigDocument => document !== undefined)
      .map(({ app, environment, label }) => ({ app, environment, label }))
      .sort(
        (a, b) =>
          a.app.localeCompare(b.app) ||
          a.environment.localeCompare(b.environment) ||
          a.label.localeCompare(b.label),
      );
  }

  async write(
    scope: ConfigScope,
    changes: ConfigEntryInput[],
    context: WriteContext,
  ): Promise<{ document: ConfigDocument; changed: boolean; touched: TouchedEntry[] }> {
    const key = scopeKey(scope);
    const versions = this.#versions.get(key) ?? [];
    const current = await this.#latest(scope);
    const result = applyChanges(current, changes, context);
    const document = withScope(result.document, scope);
    if (result.changed) {
      versions.push(await this.#sealer.sealDocument(document));
      this.#versions.set(key, versions);
      this.#audit.push(
        ...(await auditRows(
          scope,
          document.version,
          result.touched,
          context,
          this.#sealer,
          randomUUID,
        )),
      );
    }
    return { document, changed: result.changed, touched: result.touched };
  }

  async rollback(
    scope: ConfigScope,
    toVersion: number,
    context: WriteContext,
  ): Promise<{ document: ConfigDocument; changed: boolean }> {
    const target = await this.readVersion(scope, toVersion);
    if (!target) throw new Error(`config: version ${toVersion} does not exist for ${scope.app}`);
    const current = await this.#latest(scope);
    const entries: Record<string, ConfigEntryState> = Object.fromEntries(
      Object.entries(target.entries).map(([key, entry]) => [
        key,
        { ...entry, updatedAt: context.now, updatedBy: context.actor },
      ]),
    );
    const fingerprint = fingerprintOf(entries);
    if (current?.fingerprint === fingerprint) {
      return { document: current, changed: false };
    }
    const document: ConfigDocument = {
      ...scope,
      version: (current?.version ?? 0) + 1,
      entries,
      createdAt: context.now,
      createdBy: context.actor,
      ...(context.message !== undefined ? { message: context.message } : {}),
      fingerprint,
    };
    const key = scopeKey(scope);
    const versions = this.#versions.get(key) ?? [];
    versions.push(await this.#sealer.sealDocument(document));
    this.#versions.set(key, versions);
    this.#audit.push({
      id: randomUUID(),
      ...scope,
      actor: context.actor,
      action: 'rollback',
      version: document.version,
      ...(context.message !== undefined ? { message: context.message } : {}),
      at: context.now,
    });
    return { document, changed: true };
  }

  async listAudit(
    scope: ConfigScope,
    page: { number: number; size: number },
    filters: { key?: string; action?: string } = {},
  ): Promise<StorePage<ConfigAuditRecord>> {
    const matching = [...this.#audit]
      .reverse()
      .filter(
        (row) =>
          row.app === scope.app &&
          row.environment === scope.environment &&
          row.label === scope.label &&
          (filters.key === undefined || row.key === filters.key) &&
          (filters.action === undefined || row.action === filters.action),
      );
    const start = (page.number - 1) * page.size;
    const rows = await Promise.all(
      matching.slice(start, start + page.size).map((row) => this.#sealer.openAudit(row)),
    );
    return { rows, total: matching.length };
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
    for (const versions of this.#versions.values()) {
      for (const document of versions) {
        for (const [key, entry] of Object.entries(document.entries)) {
          document.entries[key] = await resealStoredEntry(
            entry,
            entryAad(document, key),
            codec,
            dryRun,
            all,
            report,
          );
        }
      }
    }
    for (const record of this.#audit) {
      const aad = entryAad(record, record.key ?? '');
      if (record.before) {
        record.before = await resealStoredEntry(record.before, aad, codec, dryRun, all, report);
      }
      if (record.after) {
        record.after = await resealStoredEntry(record.after, aad, codec, dryRun, all, report);
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
    return [...(this.#tenantKeys.get(app) ?? [])].reverse();
  }

  async registerTenantKey(key: TenantPublicKey): Promise<{ created: boolean }> {
    const keys = this.#tenantKeys.get(key.app) ?? [];
    const existing = keys.find((candidate) => candidate.kid === key.kid);
    if (key.active) {
      // Exactly one active key per app, even when the same key is re-registered.
      for (const candidate of keys) candidate.active = candidate.kid === key.kid;
    }
    if (existing) return { created: false };
    keys.push({ ...key, publicKey: { ...key.publicKey } });
    this.#tenantKeys.set(key.app, keys);
    return { created: true };
  }

  async recordReveal(
    scope: ConfigScope,
    key: string,
    version: number,
    actor: string,
  ): Promise<void> {
    this.#audit.push({
      id: randomUUID(),
      ...scope,
      actor,
      action: 'reveal',
      key,
      version,
      at: new Date().toISOString(),
    });
  }
}
