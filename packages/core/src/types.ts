/**
 * The on-disk and on-the-wire shape of a configuration document.
 *
 * A document belongs to one scope: an application (the partition), an environment and a label
 * (`main`, a branch name, a profile — Spring Cloud Config's `profile`). Every write creates a new
 * immutable version of the scope; history and rollback read those versions.
 */

export type ConfigScalar = string | number | boolean | null;
export type ConfigValue = ConfigScalar | ConfigValue[] | { [key: string]: ConfigValue };

/** One entry as it is stored: the value (or a vault reference) plus its flags. */
export interface ConfigEntryState {
  /** The value. Absent when the entry is a vault reference (see {@link vault}). */
  value?: ConfigValue;
  /** `vault://provider/path#field`: resolved when the value is read, never stored resolved. */
  vault?: string;
  /** A secret is encrypted at rest and only served to a `config:secrets:read` caller. */
  secret: boolean;
  /** Reloadable entries are applied on a running tenant; the rest need a restart. */
  reloadable: boolean;
  description?: string;
  /** ISO date of the last write to this entry. */
  updatedAt: string;
  /** `actor ?? sub` of the last writer. */
  updatedBy: string;
}

/** One entry as a reader sees it. A secret the reader may not read carries no `value`. */
export interface ConfigEntryView extends ConfigEntryState {
  /** True when the value exists but was withheld (a secret the caller cannot read). */
  masked: boolean;
}

/** A whole configuration scope at one version. */
export interface ConfigDocument {
  /** The application (the tenant's partition). */
  app: string;
  environment: string;
  label: string;
  /** Monotonic per scope, starting at 1. */
  version: number;
  entries: Record<string, ConfigEntryState>;
  createdAt: string;
  createdBy: string;
  message?: string;
  /** `sha256` of the entries, so two versions can be compared without reading them. */
  fingerprint: string;
}

/** A document as a reader sees it: secret values are dropped unless the caller may read them. */
export interface ConfigDocumentView {
  app: string;
  environment: string;
  label: string;
  version: number;
  entries: Record<string, ConfigEntryView>;
  createdAt: string;
  createdBy: string;
  message?: string;
  fingerprint: string;
}

/** The scope of a document: what a version number counts within. */
export interface ConfigScope {
  app: string;
  environment: string;
  label: string;
}

export type ConfigAuditAction = 'set' | 'unset' | 'rollback' | 'reveal';

/** One audit row: who changed what, and which version it produced. */
export interface ConfigAuditRecord {
  id: string;
  app: string;
  environment: string;
  label: string;
  /** `actor ?? sub`: the caller's actor when the token carries one, else its subject. */
  actor: string;
  action: ConfigAuditAction;
  /** The entry touched by `set`/`unset`/`reveal`; absent on `rollback`. */
  key?: string;
  /** The version the action produced (`reveal` reports the version it read). */
  version: number;
  message?: string;
  at: string;
  before?: ConfigEntryState;
  after?: ConfigEntryState;
}

/** A change a write asks for. `value` and `vault` are mutually exclusive; both absent unsets. */
export interface ConfigEntryInput {
  key: string;
  value?: ConfigValue;
  vault?: string;
  secret?: boolean;
  reloadable?: boolean;
  description?: string | null;
}

/** A complete, versioned scope as the control plane serves it (ETag + SSE payload). */
export interface ConfigSnapshot {
  app: string;
  environment: string;
  label: string;
  version: number;
  fingerprint: string;
  /** Keys in this version, flat (dot paths). */
  entries: Record<string, ConfigEntryView>;
  createdAt: string;
  createdBy: string;
  message?: string;
}

/** One row of a version-to-version diff. Secret values are replaced by `null` + `masked`. */
export interface ConfigDiffRow {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  before?: ConfigEntryView;
  after?: ConfigEntryView;
}

/** A page of list results, the Agora wire format (`_1x/LIST-API-SPEC.md`). */
export interface OffsetPage<T> {
  data: T[];
  meta: {
    total: number;
    perPage: number;
    currentPage: number;
    lastPage: number;
    firstPage: number;
  };
}

/** The scope's current version plus counts, for the console's overview. */
export interface ScopeSummary extends ConfigScope {
  version: number;
  entries: number;
  secrets: number;
  updatedAt: string;
  updatedBy: string;
}
