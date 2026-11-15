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
import { offsetPage } from '@adonis-agora/filter';
import type { VaultResolver } from './define_config.js';
import type { ConfigStore, VersionSummary } from './store/store.js';

export interface PageInput {
  page: number;
  size: number;
}

export interface EntryFilters {
  /** Substring of the key or the description. */
  search?: string;
  secret?: boolean;
  reloadable?: boolean;
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

/** One entry as the console lists it: the view plus its map key. */
export type EntryRow = ConfigEntryView & { key: string };

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

  constructor(options: ConfigAdminOptions) {
    this.store = options.store;
    this.canRevealSecrets = options.canRevealSecrets ?? true;
    this.#vault = options.vault;
    this.#onChange = options.onChange;
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
          secret: entry.secret,
          reloadable: entry.reloadable,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
        },
        canRead,
      ),
    };
  }

  /** One page of entries, filtered and sorted in memory (a document is small by nature). */
  async listEntries(
    scope: ConfigScope,
    canReadSecrets: boolean,
    options: PageInput & { filters?: EntryFilters; sort?: EntrySort } = { page: 1, size: 50 },
  ): Promise<OffsetPage<EntryRow>> {
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
    return offsetPage(matching.slice(start, start + options.size), {
      total: matching.length,
      page: options.page,
      size: options.size,
    });
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
    if (options.reveal && (entry.secret || entry.vault !== undefined)) {
      await this.store.recordReveal(scope, key, document!.version, options.reveal.actor);
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
    const result = await this.store.write(scope, [{ key, ...input }], {
      actor: options.actor,
      now: options.now ?? new Date().toISOString(),
      ...(options.message !== undefined ? { message: options.message } : {}),
    });
    if (result.changed) this.#onChange?.(scope, result.document.version);
    return { version: result.document.version, changed: result.changed };
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
    if (result.changed) this.#onChange?.(scope, result.document.version);
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
      .map(([key, entry]) => ({ key, ...entry }))
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
    if (result.changed) this.#onChange?.(scope, result.document.version);
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
      if (canReadSecrets && options.reveal && (entry.secret || entry.vault !== undefined)) {
        await this.store.recordReveal(scope, key, view?.version ?? 0, options.reveal.actor);
      }
      out[key] = entry.value;
    }
    return out;
  }
}
