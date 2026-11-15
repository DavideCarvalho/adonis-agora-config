/**
 * The `@adonis-agora/diagnostics` emit capability, read STRUCTURALLY: this package never imports
 * or depends on the diagnostics package. When it is installed (the usual companion of
 * `@adonis-agora/telescope`), every config milestone is published on `agora:config:<event>` and
 * Telescope's generic diagnostics watcher records it as a `diagnostic` entry tagged `lib:config`.
 * Without it, emitting is an inert no-op.
 */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/** Every config milestone published on `agora:config:<event>`. */
export const CONFIG_DIAGNOSTIC_EVENTS = [
  'entry.set',
  'entry.unset',
  'rollback',
  'entry.reveal',
  'sealed.reseal',
  'key.registered',
  'tenant.reload',
  'crypto.reseal',
] as const;

export type ConfigDiagnosticEvent = (typeof CONFIG_DIAGNOSTIC_EVENTS)[number];

/** A write or unset of one entry. Never carries the value (a secret stays secret). */
export interface ConfigEntryChangePayload {
  app: string;
  environment: string;
  label: string;
  key: string;
  version: number;
  actor: string;
  secret: boolean;
  reloadable: boolean;
  /** Present when the value is sealed to an app's X25519 key. */
  sealedTo?: { app: string; kid: string };
  message?: string;
}

export interface ConfigRollbackPayload {
  app: string;
  environment: string;
  label: string;
  version: number;
  actor: string;
  toVersion: number;
  message?: string;
}

/** Somebody read a secret value (the console's reveal, `--secrets`, an MCP call). */
export interface ConfigRevealPayload {
  app: string;
  environment: string;
  label: string;
  key: string;
  version: number;
  actor: string;
}

/** A tenant re-sealed values to its active key through the control plane. */
export interface ConfigSealedResealPayload {
  app: string;
  environment: string;
  label: string;
  version: number;
  actor: string;
  keys: string[];
}

/** A tenant app published its X25519 public keys. */
export interface ConfigKeyRegisteredPayload {
  app: string;
  active?: string;
  kids: string[];
  actor: string;
}

/** A running tenant applied a new version: what reloaded, what needs a restart. */
export interface ConfigTenantReloadPayload {
  app: string;
  environment: string;
  label: string;
  version: number;
  reloadable: string[];
  restartRequired: string[];
}

/** The `config:crypto:reseal` result. Counts only; never a value. */
export interface ConfigCryptoResealPayload {
  dryRun: boolean;
  all: boolean;
  scanned: number;
  resealed: number;
  failed: number;
}

export type ConfigDiagnosticPayloads = {
  'entry.set': ConfigEntryChangePayload;
  'entry.unset': ConfigEntryChangePayload;
  rollback: ConfigRollbackPayload;
  'entry.reveal': ConfigRevealPayload;
  'sealed.reseal': ConfigSealedResealPayload;
  'key.registered': ConfigKeyRegisteredPayload;
  'tenant.reload': ConfigTenantReloadPayload;
  'crypto.reseal': ConfigCryptoResealPayload;
};

/**
 * Publishes one `agora:config:<event>` through whatever `@adonis-agora/diagnostics` registered on
 * the global slot. Never throws: observability must not break a write or a read.
 */
export function emitConfig<E extends ConfigDiagnosticEvent>(
  event: E,
  payload: ConfigDiagnosticPayloads[E],
): void {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
  if (typeof emit !== 'function') return;
  try {
    emit('config', event, payload);
  } catch {
    // A broken diagnostics subscriber must never take a config operation down with it.
  }
}
