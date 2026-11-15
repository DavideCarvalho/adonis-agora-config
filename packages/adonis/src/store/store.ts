import {
  assertConfigKey,
  type ConfigAuditRecord,
  type ConfigDocument,
  type ConfigEntryInput,
  type ConfigEntryState,
  type ConfigScope,
  type ConfigValue,
  fingerprintOf,
  isVaultReference,
} from '@adonis-agora/config-core';
import type { SecretCodec } from '../crypto/secrets.js';

/** One version row, as history lists it. */
export interface VersionSummary {
  version: number;
  createdAt: string;
  createdBy: string;
  message?: string;
  entries: number;
  secrets: number;
  fingerprint: string;
}

/** A page of store rows. */
export interface StorePage<T> {
  rows: T[];
  total: number;
}

/** Who writes: always a resolved actor (`actor ?? sub`). */
export interface WriteContext {
  actor: string;
  now: string;
  message?: string;
}

/** One entry a write produced, for the audit trail. */
export interface TouchedEntry {
  key: string;
  before?: ConfigEntryState;
  after?: ConfigEntryState;
}

/** The store every control plane reads and writes. */
export interface ConfigStore {
  /** Creates the store's tables (Lucid), when the driver needs it. Idempotent. */
  setup?(): Promise<void> | void;
  /** The current version of a scope, or null when nothing was ever written. */
  read(scope: ConfigScope): Promise<ConfigDocument | null>;
  /** One past version. */
  readVersion(scope: ConfigScope, version: number): Promise<ConfigDocument | null>;
  /** Versions of a scope, newest first. */
  listVersions(
    scope: ConfigScope,
    page: { number: number; size: number },
  ): Promise<StorePage<VersionSummary>>;
  /** Every scope with something in it, sorted by app, environment, label. */
  listScopes(): Promise<ConfigScope[]>;
  /** Applies the changes atomically and produces the next version. A no-op returns `changed: false`. */
  write(
    scope: ConfigScope,
    changes: ConfigEntryInput[],
    context: WriteContext,
  ): Promise<{ document: ConfigDocument; changed: boolean; touched: TouchedEntry[] }>;
  /** Copies a past version's entries into a new version. */
  rollback(
    scope: ConfigScope,
    toVersion: number,
    context: WriteContext,
  ): Promise<{ document: ConfigDocument; changed: boolean }>;
  /** Audit rows of a scope, newest first, optionally filtered by key and action. */
  listAudit(
    scope: ConfigScope,
    page: { number: number; size: number },
    filters?: { key?: string; action?: string },
  ): Promise<StorePage<ConfigAuditRecord>>;
  /** Records that somebody read a secret value (the console's reveal). */
  recordReveal(scope: ConfigScope, key: string, version: number, actor: string): Promise<void>;
}

/**
 * Encrypts secret values at the store boundary. A store only ever sees ciphertext, so a dump of the
 * memory store or the database never contains a secret. Without a codec, writing a secret is an
 * error — silently storing it in plain text is exactly what this package exists to prevent.
 */
export class DocumentSealer {
  constructor(private readonly codec: SecretCodec | undefined) {}

  get configured(): boolean {
    return this.codec !== undefined;
  }

  sealEntry(entry: ConfigEntryState): ConfigEntryState {
    if (!entry.secret || entry.vault !== undefined || entry.value === undefined)
      return { ...entry };
    if (!this.codec) {
      throw new Error(
        '@adonis-agora/config: a secret was written but no secrets key is configured. Set `controlPlane.secrets.key` (usually APP_KEY).',
      );
    }
    return { ...entry, value: this.codec.seal(entry.value) };
  }

  openEntry(entry: ConfigEntryState): ConfigEntryState {
    if (!entry.secret || typeof entry.value !== 'string' || !this.codec?.owns(entry.value)) {
      return { ...entry };
    }
    return { ...entry, value: this.codec.open(entry.value) };
  }

  sealDocument(document: ConfigDocument): ConfigDocument {
    return {
      ...document,
      entries: Object.fromEntries(
        Object.entries(document.entries).map(([key, entry]) => [key, this.sealEntry(entry)]),
      ),
    };
  }

  openDocument(document: ConfigDocument): ConfigDocument {
    return {
      ...document,
      entries: Object.fromEntries(
        Object.entries(document.entries).map(([key, entry]) => [key, this.openEntry(entry)]),
      ),
    };
  }

  sealAudit(record: ConfigAuditRecord): ConfigAuditRecord {
    return {
      ...record,
      ...(record.before ? { before: this.sealEntry(record.before) } : {}),
      ...(record.after ? { after: this.sealEntry(record.after) } : {}),
    };
  }

  openAudit(record: ConfigAuditRecord): ConfigAuditRecord {
    return {
      ...record,
      ...(record.before ? { before: this.openEntry(record.before) } : {}),
      ...(record.after ? { after: this.openEntry(record.after) } : {}),
    };
  }
}

/** Whether two entries hold the same value and flags (after sealing). */
function sameEntry(a: ConfigEntryState | undefined, b: ConfigEntryState | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.secret === b.secret &&
    a.reloadable === b.reloadable &&
    (a.description ?? '') === (b.description ?? '') &&
    (a.vault ?? '') === (b.vault ?? '') &&
    JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
  );
}

function normalizeInput(input: ConfigEntryInput): ConfigEntryInput {
  assertConfigKey(input.key);
  let value = input.value;
  let vault = input.vault;
  if (vault !== undefined && value !== undefined) {
    throw new Error(`config: entry "${input.key}" cannot have both a value and a vault reference`);
  }
  if (value !== undefined && isVaultReference(value)) {
    vault = value;
    value = undefined;
  }
  if (vault !== undefined && !vault.startsWith('vault://')) {
    throw new Error(`config: entry "${input.key}" has an invalid vault reference "${vault}"`);
  }
  return {
    key: input.key,
    ...(value !== undefined ? { value } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    ...(input.reloadable !== undefined ? { reloadable: input.reloadable } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

/**
 * Applies entry changes to the current document and builds the next version. Pure: both stores share
 * it, so memory and Lucid behave identically (same defaults, same no-op detection, same versioning).
 */
export function applyChanges(
  current: ConfigDocument | null,
  changes: readonly ConfigEntryInput[],
  context: WriteContext,
): { document: ConfigDocument; changed: boolean; touched: TouchedEntry[] } {
  const entries: Record<string, ConfigEntryState> = { ...(current?.entries ?? {}) };
  const touched: TouchedEntry[] = [];

  for (const raw of changes) {
    const input = normalizeInput(raw);
    const existing = entries[input.key];
    const unset = input.value === undefined && input.vault === undefined;
    if (unset) {
      delete entries[input.key];
      touched.push({ key: input.key, ...(existing ? { before: existing } : {}) });
      continue;
    }
    const next: ConfigEntryState = {
      ...(input.value !== undefined ? { value: input.value as ConfigValue } : {}),
      ...(input.vault !== undefined ? { vault: input.vault } : {}),
      secret: input.secret ?? existing?.secret ?? input.vault !== undefined,
      reloadable: input.reloadable ?? existing?.reloadable ?? false,
      ...(input.description === null
        ? {}
        : input.description !== undefined
          ? { description: input.description }
          : existing?.description !== undefined
            ? { description: existing.description }
            : {}),
      updatedAt: context.now,
      updatedBy: context.actor,
    };
    entries[input.key] = next;
    touched.push({ key: input.key, ...(existing ? { before: existing } : {}), after: next });
  }

  const fingerprint = fingerprintOf(entries);
  const changed =
    current === null
      ? Object.keys(entries).length > 0
      : fingerprint !== current.fingerprint ||
        Object.keys(entries).length !== Object.keys(current.entries).length;
  const document: ConfigDocument = {
    app: current?.app ?? '',
    environment: current?.environment ?? '',
    label: current?.label ?? '',
    version: changed ? (current?.version ?? 0) + 1 : (current?.version ?? 0),
    entries,
    createdAt: context.now,
    createdBy: context.actor,
    ...(context.message !== undefined ? { message: context.message } : {}),
    fingerprint,
  };
  return { document, changed, touched: changed ? touched : [] };
}

/** Builds the audit rows for a write: one per touched entry. */
export function auditRows(
  scope: ConfigScope,
  version: number,
  touched: readonly TouchedEntry[],
  context: WriteContext,
  sealer: DocumentSealer,
  id: () => string,
): ConfigAuditRecord[] {
  return touched
    .filter((entry) => !sameEntry(entry.before, entry.after) || entry.after === undefined)
    .map((entry) => ({
      id: id(),
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
      actor: context.actor,
      action: entry.after === undefined ? 'unset' : 'set',
      key: entry.key,
      version,
      ...(context.message !== undefined ? { message: context.message } : {}),
      at: context.now,
      ...(entry.before ? { before: sealer.sealEntry(entry.before) } : {}),
      ...(entry.after ? { after: sealer.sealEntry(entry.after) } : {}),
    }));
}

/** `app:environment:label`, the key a store uses for a scope in memory. */
export function scopeKey(scope: ConfigScope): string {
  return `${scope.app}\u0000${scope.environment}\u0000${scope.label}`;
}

/** Fills in the scope after {@link applyChanges} built a document without one. */
export function withScope(document: ConfigDocument, scope: ConfigScope): ConfigDocument {
  return { ...document, app: scope.app, environment: scope.environment, label: scope.label };
}

/** Secret count and entry count of a document. */
export function countsOf(document: ConfigDocument): { entries: number; secrets: number } {
  const values = Object.values(document.entries);
  return { entries: values.length, secrets: values.filter((entry) => entry.secret).length };
}
