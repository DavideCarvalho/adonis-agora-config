import {
  type ConfigAuditRecord,
  type ConfigDiffRow,
  type ConfigEntryInput,
  type ConfigEntryState,
  type ConfigEntryView,
  type ConfigScope,
  type ConfigValue,
  DEFAULT_LABEL,
  diffDocuments,
  maskDocument,
  maskEntry,
  type OffsetPage,
  parseVaultReference,
} from '@adonis-agora/config-core';
import {
  type CursorPageResponse,
  decodeCursor,
  encodeCursor,
  offsetPage,
} from '@adonis-agora/filter';
import { sealForApp } from './crypto/tenant_keys.js';
import type { VaultResolver } from './define_config.js';
import { emitConfig } from './diagnostics.js';
import type { AuditPosition, ConfigStore, VersionSummary } from './store/store.js';
import type { ConfigTransport } from './transports/types.js';

export interface PageInput {
  page: number;
  size: number;
}

export interface EntryFilters {
  /** Substring of the key or the description. */
  search?: string;
  secret?: boolean;
  reloadable?: boolean;
  /** Only entries the tenant's pages may read. */
  browser?: boolean;
  updatedBy?: string;
}

export interface EntrySort {
  field: 'key' | 'updatedAt' | 'updatedBy';
  direction: 'asc' | 'desc';
}

export interface ScopeList {
  apps: string[];
  environments: string[];
  labels: string[];
}

export interface SetEntryOptions {
  actor: string;
  message?: string;
  now?: string;
}

/** The scope's current document, as the console's entry list carries it. */
export interface DocumentStamps {
  version: number;
  /** ISO date of the scope's first version; `null` when the store cannot tell. */
  createdAt: string | null;
  /** ISO date of the current version (the last change). */
  updatedAt: string;
}

/**
 * One entry as the console lists it: the view plus its map key. `createdAt` is `null` on entries
 * written before it was recorded.
 */
export type EntryRow = Omit<ConfigEntryView, 'createdAt'> & {
  key: string;
  createdAt: string | null;
};

export interface ConfigAdminOptions {
  store: ConfigStore;
  /** Whether this deployment's console may reveal a secret value (gated by `console.revealSecrets`). */
  canRevealSecrets?: boolean;
  /** Resolves `vault://` references when an operator reads one (never for a masked read). */
  vault?: VaultResolver;
  /**
   * Called after a write produced a new version. The control plane publishes it on its SSE bus, so
   * tenants connected to this process refresh immediately instead of at the next poll.
   */
  onChange?: (scope: ConfigScope, version: number) => void;
  /**
   * Broker transport selected on the control plane (`transports.redis`/`durable`). Writes announce
   * the new version + a masked snapshot; the HTTP API is untouched.
   */
  transport?: ConfigTransport;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/**
 * Everything the console, the commands and the dev tools do to the configuration. One
 * implementation, three entry points: same validation, same masking, same audit actor, same
 * versioning. It never trusts its caller to have checked access — the console gate, the command and
 * the MCP action each decide that before calling.
 */
export class ConfigAdmin {
  readonly store: ConfigStore;
  readonly canRevealSecrets: boolean;
  readonly #vault: VaultResolver | undefined;
  readonly #onChange: ((scope: ConfigScope, version: number) => void) | undefined;
  readonly #transport: ConfigTransport | undefined;

  constructor(options: ConfigAdminOptions) {
    this.store = options.store;
    this.canRevealSecrets = options.canRevealSecrets ?? true;
    this.#vault = options.vault;
    this.#onChange = options.onChange;
    this.#transport = options.transport;
  }

  /** Announces a new version on the selected broker; never fails the write. */
  #announce(
    scope: ConfigScope,
    version: number,
    document: Parameters<typeof maskDocument>[0],
  ): void {
    if (!this.#transport?.publish) return;
    try {
      void Promise.resolve(
        this.#transport.publish(scope, version, maskDocument(document, false)),
      ).catch(() => {});
    } catch {
      // A broker outage must not roll back a stored write; tenants poll/SSE as a fallback.
    }
  }

  /** Apps, environments and labels that hold something, for the console's pickers. */
  async scopes(): Promise<ScopeList> {
    const scopes = await this.store.listScopes();
    const unique = (values: string[]) => [...new Set(values)].sort();
    return {
      apps: unique(scopes.map((scope) => scope.app)),
      environments: unique(scopes.map((scope) => scope.environment)),
      labels: unique(scopes.map((scope) => scope.label)),
    };
  }

  /** The default scope: the first app, its production environment, `main`. */
  async defaultScope(fallback: { app?: string; environment: string }): Promise<ConfigScope> {
    const { apps } = await this.scopes();
    return {
      app: fallback.app ?? apps[0] ?? 'app',
      environment: fallback.environment,
      label: DEFAULT_LABEL,
    };
  }

  #visible(key: string, entry: ConfigEntryState, canRead: boolean): EntryRow {
    return {
      key,
      ...maskEntry(
        {
          ...(entry.value !== undefined ? { value: entry.value } : {}),
          ...(entry.vault !== undefined ? { vault: entry.vault } : {}),
          ...(entry.sealedTo !== undefined ? { sealedTo: entry.sealedTo } : {}),
          secret: entry.secret,
          reloadable: entry.reloadable,
          ...(entry.browser === true ? { browser: true } : {}),
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
        },
        canRead,
      ),
      createdAt: entry.createdAt ?? null,
    };
  }

  /**
   * One page of entries, filtered and sorted in memory (a document is small by nature), plus the
   * scope's current document: its version, when the scope was first written and when it last
   * changed (`null` when unknown, or when nothing was ever written).
   */
  async listEntries(
    scope: ConfigScope,
    canReadSecrets: boolean,
    options: PageInput & { filters?: EntryFilters; sort?: EntrySort } = { page: 1, size: 50 },
  ): Promise<OffsetPage<EntryRow> & { document: DocumentStamps | null }> {
    const document = await this.store.read(scope);
    const entries = Object.entries(document?.entries ?? {}).map(([key, entry]) =>
      this.#visible(key, entry, canReadSecrets),
    );
    const filters = options.filters ?? {};
    const search = filters.search?.toLowerCase();
    const matching = entries
      .filter(
        (entry) =>
          (search === undefined ||
            entry.key.toLowerCase().includes(search) ||
            (entry.description ?? '').toLowerCase().includes(search)) &&
          (filters.secret === undefined || entry.secret === filters.secret) &&
          (filters.reloadable === undefined || entry.reloadable === filters.reloadable) &&
          (filters.browser === undefined || (entry.browser === true) === filters.browser) &&
          (filters.updatedBy === undefined || entry.updatedBy === filters.updatedBy),
      )
      .sort((a, b) => {
        const sort = options.sort ?? { field: 'key', direction: 'asc' };
        const result =
          sort.field === 'key'
            ? a.key.localeCompare(b.key, undefined, { numeric: true })
            : compare(
                sort.field === 'updatedAt' ? a.updatedAt : a.updatedBy,
                sort.field === 'updatedAt' ? b.updatedAt : b.updatedBy,
              );
        return sort.direction === 'asc' ? result : -result;
      });
    const start = (options.page - 1) * options.size;
    return {
      ...offsetPage(matching.slice(start, start + options.size), {
        total: matching.length,
        page: options.page,
        size: options.size,
      }),
      document: document
        ? await this.#documentStamps(scope, document.version, document.createdAt)
        : null,
    };
  }

  /** The current document's dates: its first version's (via `seekVersions`) and its own. */
  async #documentStamps(
    scope: ConfigScope,
    version: number,
    updatedAt: string,
  ): Promise<DocumentStamps> {
    let createdAt: string | null = null;
    try {
      const [first] = (await this.store.seekVersions?.(scope, { limit: 1, order: 'asc' })) ?? [];
      createdAt = first?.createdAt ?? null;
    } catch {
      // A store that cannot seek shows the creation date as unknown.
    }
    return { version, createdAt, updatedAt };
  }

  /** One entry. `reveal` records the read in the audit trail (the console's eye button). */
  async getEntry(
    scope: ConfigScope,
    key: string,
    options: { canReadSecrets: boolean; reveal?: { actor: string } },
  ): Promise<EntryRow | null> {
    const document = await this.store.read(scope);
    const entry = document?.entries[key];
    if (!entry) return null;
    // A sealed value has no reveal: the console never asks for it, and a reveal row would lie.
    if (options.reveal && (entry.secret || entry.vault !== undefined) && !entry.sealedTo) {
      await this.store.recordReveal(scope, key, document!.version, options.reveal.actor);
      emitConfig('entry.reveal', {
        app: scope.app,
        environment: scope.environment,
        label: scope.label,
        key,
        version: document!.version,
        actor: options.reveal.actor,
      });
    }
    if (entry.vault !== undefined && options.canReadSecrets && this.#vault) {
      try {
        const resolved = await this.#vault(parseVaultReference(entry.vault));
        if (resolved !== undefined) {
          return { ...this.#visible(key, entry, true), value: resolved, masked: false };
        }
      } catch {
        // An unresolvable reference stays masked; never a wrong value.
      }
    }
    return this.#visible(key, entry, options.canReadSecrets);
  }

  async setEntry(
    scope: ConfigScope,
    key: string,
    input: Omit<ConfigEntryInput, 'key'>,
    options: SetEntryOptions,
  ): Promise<{ version: number; changed: boolean }> {
    const prepared = await this.#sealIfRequested(scope, key, input);
    const result = await this.store.write(scope, [{ key, ...prepared }], {
      actor: options.actor,
      now: options.now ?? new Date().toISOString(),
      ...(options.message !== undefined ? { message: options.message } : {}),
    });
    if (result.changed) {
      this.#onChange?.(scope, result.document.version);
      this.#announce(scope, result.document.version, result.document);
      const entry = result.document.entries[key];
      if (entry) {
        emitConfig('entry.set', {
          app: result.document.app,
          environment: result.document.environment,
          label: result.document.label,
          key,
          version: result.document.version,
          actor: options.actor,
          secret: entry.secret,
          reloadable: entry.reloadable,
          ...(entry.sealedTo !== undefined ? { sealedTo: entry.sealedTo } : {}),
          ...(options.message !== undefined ? { message: options.message } : {}),
        });
      }
    }
    return { version: result.document.version, changed: result.changed };
  }

  /**
   * Several entries in ONE version (an import): one write, one change announced, one audit row
   * per key. Values only (no vault, no sealing). Keys that already hold the same value and flags
   * do not make a new version on their own.
   */
  async setEntries(
    scope: ConfigScope,
    entries: Array<{ key: string; value: ConfigValue; secret?: boolean }>,
    options: SetEntryOptions,
  ): Promise<{ version: number; changed: boolean }> {
    if (entries.length === 0) {
      const current = await this.store.read(scope);
      return { version: current?.version ?? 0, changed: false };
    }
    const result = await this.store.write(
      scope,
      entries.map((entry) => ({
        key: entry.key,
        value: entry.value as never,
        ...(entry.secret === true ? { secret: true } : {}),
      })),
      {
        actor: options.actor,
        now: options.now ?? new Date().toISOString(),
        ...(options.message !== undefined ? { message: options.message } : {}),
      },
    );
    if (result.changed) {
      this.#onChange?.(scope, result.document.version);
      this.#announce(scope, result.document.version, result.document);
      for (const entry of entries) {
        const stored = result.document.entries[entry.key];
        if (!stored) continue;
        emitConfig('entry.set', {
          app: result.document.app,
          environment: result.document.environment,
          label: result.document.label,
          key: entry.key,
          version: result.document.version,
          actor: options.actor,
          secret: stored.secret,
          reloadable: stored.reloadable,
          ...(options.message !== undefined ? { message: options.message } : {}),
        });
      }
    }
    return { version: result.document.version, changed: result.changed };
  }

  /**
   * Turns `sealedTo: true` into ciphertext for the scope app's active public key. The plaintext
   * never reaches the store, and there is no way back: the control plane cannot open the result.
   */
  async #sealIfRequested(
    scope: ConfigScope,
    key: string,
    input: Omit<ConfigEntryInput, 'key'>,
  ): Promise<Omit<ConfigEntryInput, 'key'>> {
    if (input.sealedTo === undefined || input.sealedTo === false) {
      const { sealedTo: _sealedTo, ...rest } = input;
      return rest;
    }
    if (input.vault !== undefined) {
      throw new Error('config: a sealed entry takes a value, not a vault reference');
    }
    if (input.value === undefined) {
      throw new Error('config: a sealed entry needs a value to seal');
    }
    if (typeof input.sealedTo === 'object') {
      throw new Error('config: pass `sealedTo: true`; the admin resolves the app key');
    }
    const sealed = await sealForApp(this.store, scope, key, input.value);
    return {
      ...input,
      value: sealed.value,
      sealedTo: sealed.sealedTo,
      secret: true,
    };
  }

  async unsetEntry(
    scope: ConfigScope,
    key: string,
    options: SetEntryOptions,
  ): Promise<{ version: number; changed: boolean }> {
    const document = await this.store.read(scope);
    if (!document?.entries[key]) return { version: document?.version ?? 0, changed: false };
    const result = await this.store.write(scope, [{ key }], {
      actor: options.actor,
      now: options.now ?? new Date().toISOString(),
      ...(options.message !== undefined ? { message: options.message } : {}),
    });
    if (result.changed) {
      this.#onChange?.(scope, result.document.version);
      this.#announce(scope, result.document.version, result.document);
      emitConfig('entry.unset', {
        app: result.document.app,
        environment: result.document.environment,
        label: result.document.label,
        key,
        version: result.document.version,
        actor: options.actor,
        secret: document.entries[key]?.secret ?? false,
        reloadable: document.entries[key]?.reloadable ?? false,
        ...(document.entries[key]?.sealedTo !== undefined
          ? { sealedTo: document.entries[key]!.sealedTo! }
          : {}),
        ...(options.message !== undefined ? { message: options.message } : {}),
      });
    }
    return { version: result.document.version, changed: result.changed };
  }

  /** Versions, newest first. `direction: 'asc'` reads oldest first (paging mirrors the ordering). */
  async listVersions(
    scope: ConfigScope,
    options: PageInput & { direction?: 'asc' | 'desc' } = { page: 1, size: 20 },
  ): Promise<OffsetPage<VersionSummary>> {
    const first = await this.store.listVersions(scope, {
      number: options.page,
      size: options.size,
    });
    if (options.direction !== 'asc') {
      return offsetPage(first.rows, {
        total: first.total,
        page: options.page,
        size: options.size,
      });
    }
    const lastPage = Math.max(1, Math.ceil(first.total / options.size));
    const mirrored = await this.store.listVersions(scope, {
      number: lastPage - options.page + 1,
      size: options.size,
    });
    return offsetPage([...mirrored.rows].reverse(), {
      total: first.total,
      page: options.page,
      size: options.size,
    });
  }

  async version(
    scope: ConfigScope,
    version: number,
    canReadSecrets: boolean,
  ): Promise<{ summary: VersionSummary; entries: EntryRow[] } | null> {
    const document = await this.store.readVersion(scope, version);
    if (!document) return null;
    const view = maskDocument(document, canReadSecrets);
    const entries = Object.entries(view.entries)
      .map(([key, entry]) => ({ key, ...entry, createdAt: entry.createdAt ?? null }))
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    return {
      summary: {
        version: document.version,
        createdAt: document.createdAt,
        createdBy: document.createdBy,
        ...(document.message !== undefined ? { message: document.message } : {}),
        entries: entries.length,
        secrets: entries.filter((entry) => entry.secret).length,
        fingerprint: document.fingerprint,
      },
      entries,
    };
  }

  /** The changes between two versions, masked for this reader. */
  async diff(
    scope: ConfigScope,
    from: number,
    to: number,
    canReadSecrets: boolean,
  ): Promise<ConfigDiffRow[]> {
    const [before, after] = await Promise.all([
      this.store.readVersion(scope, from),
      this.store.readVersion(scope, to),
    ]);
    if (!before) throw new Error(`config: version ${from} does not exist`);
    if (!after) throw new Error(`config: version ${to} does not exist`);
    return diffDocuments(maskDocument(before, canReadSecrets), maskDocument(after, canReadSecrets));
  }

  async rollback(
    scope: ConfigScope,
    to: number,
    options: SetEntryOptions,
  ): Promise<{ version: number; changed: boolean }> {
    const result = await this.store.rollback(scope, to, {
      actor: options.actor,
      now: options.now ?? new Date().toISOString(),
      message: options.message ?? `Rollback to version ${to}`,
    });
    if (result.changed) {
      this.#onChange?.(scope, result.document.version);
      this.#announce(scope, result.document.version, result.document);
      emitConfig('rollback', {
        app: result.document.app,
        environment: result.document.environment,
        label: result.document.label,
        version: result.document.version,
        actor: options.actor,
        toVersion: to,
        ...(options.message !== undefined ? { message: options.message } : {}),
      });
    }
    return { version: result.document.version, changed: result.changed };
  }

  async audit(
    scope: ConfigScope,
    options: PageInput & { key?: string; action?: string } = { page: 1, size: 50 },
  ): Promise<OffsetPage<ConfigAuditRecord>> {
    const { rows, total } = await this.store.listAudit(
      scope,
      { number: options.page, size: options.size },
      {
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.action !== undefined ? { action: options.action } : {}),
      },
    );
    return offsetPage(
      rows.map((row) => this.#maskAudit(row)),
      { total, page: options.page, size: options.size },
    );
  }

  /**
   * The audit trail by cursor, newest first: `after` is a previous page's `meta.nextCursor`. No
   * count and no offset, so a deep page costs what the first does. Throws on a cursor it did not
   * issue, or when the store cannot seek (see `ConfigStore.seekAudit`).
   */
  async auditCursor(
    scope: ConfigScope,
    options: { size: number; after?: string; key?: string; action?: string },
  ): Promise<CursorPageResponse<ConfigAuditRecord>> {
    const seek = this.store.seekAudit?.bind(this.store);
    if (seek === undefined)
      throw new ConfigCursorError('this store cannot page the audit by cursor');
    const after = options.after === undefined ? undefined : auditPositionOf(options.after);
    const rows = await seek(scope, {
      limit: options.size + 1,
      ...(after !== undefined ? { after } : {}),
      filters: {
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.action !== undefined ? { action: options.action } : {}),
      },
    });
    const page = rows.slice(0, options.size);
    const last = page.at(-1);
    const hasNext = rows.length > options.size;
    return {
      data: page.map((row) => this.#maskAudit(row)),
      meta: {
        nextCursor:
          hasNext && last !== undefined ? encodeCursor([last.at, last.version, last.id]) : null,
        prevCursor: null,
        hasNext,
        hasPrev: after !== undefined,
      },
    };
  }

  /** Versions by cursor (`direction: 'asc'` reads oldest first), as {@link auditCursor}. */
  async versionsCursor(
    scope: ConfigScope,
    options: { size: number; after?: string; direction?: 'asc' | 'desc' },
  ): Promise<CursorPageResponse<VersionSummary>> {
    const seek = this.store.seekVersions?.bind(this.store);
    if (seek === undefined) {
      throw new ConfigCursorError('this store cannot page the versions by cursor');
    }
    let from: number | undefined;
    if (options.after !== undefined) {
      const values = decodeCursor(options.after);
      if (values?.length !== 1 || !Number.isInteger(values[0])) {
        throw new ConfigCursorError('invalid cursor');
      }
      from = values[0] as number;
    }
    const rows = await seek(scope, {
      limit: options.size + 1,
      order: options.direction === 'asc' ? 'asc' : 'desc',
      ...(from !== undefined ? { from } : {}),
    });
    const page = rows.slice(0, options.size);
    const last = page.at(-1);
    const hasNext = rows.length > options.size;
    return {
      data: page,
      meta: {
        nextCursor: hasNext && last !== undefined ? encodeCursor([last.version]) : null,
        prevCursor: null,
        hasNext,
        hasPrev: from !== undefined,
      },
    };
  }

  #maskAudit(row: ConfigAuditRecord): ConfigAuditRecord {
    // The trail is a reading surface of its own: a secret's before/after stays masked even for an
    // operator allowed to reveal it, so a list can never leak a value without a `reveal` row.
    return {
      ...row,
      ...(row.before ? { before: maskEntry(row.before, false) } : {}),
      ...(row.after ? { after: maskEntry(row.after, false) } : {}),
    };
  }

  /** The keys of a scope, for the console's ⌘K search. */
  async keys(scope: ConfigScope): Promise<string[]> {
    const document = await this.store.read(scope);
    return Object.keys(document?.entries ?? {}).sort();
  }

  /** Every value of a scope, for `config:env` and the MCP dev tool. */
  async values(
    scope: ConfigScope,
    canReadSecrets: boolean,
    options: { reveal?: { actor: string } } = {},
  ): Promise<Record<string, ConfigValue>> {
    const document = await this.store.read(scope);
    const view = document ? maskDocument(document, canReadSecrets) : null;
    const out: Record<string, ConfigValue> = {};
    for (const [key, entry] of Object.entries(view?.entries ?? {})) {
      if (entry.value === undefined) continue;
      // A sealed value is ciphertext here: only the target app can open it, so `config:env`
      // and the MCP tools never print it.
      if (entry.sealedTo !== undefined) continue;
      if (canReadSecrets && options.reveal && (entry.secret || entry.vault !== undefined)) {
        await this.store.recordReveal(scope, key, view?.version ?? 0, options.reveal.actor);
        emitConfig('entry.reveal', {
          app: scope.app,
          environment: scope.environment,
          label: scope.label,
          key,
          version: view?.version ?? 0,
          actor: options.reveal.actor,
        });
      }
      out[key] = entry.value;
    }
    return out;
  }
}

/** A cursor the console cannot use: one it did not issue, or a store that cannot seek. */
export class ConfigCursorError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = 'ConfigCursorError';
  }
}

function auditPositionOf(cursor: string): AuditPosition {
  const values = decodeCursor(cursor);
  const [at, version, id] = values ?? [];
  if (
    values?.length !== 3 ||
    typeof at !== 'string' ||
    !Number.isInteger(version) ||
    typeof id !== 'string'
  ) {
    throw new ConfigCursorError('invalid cursor');
  }
  return { at, version: version as number, id };
}
