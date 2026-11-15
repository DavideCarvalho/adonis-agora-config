import type {
  ConfigDocument,
  ConfigDocumentView,
  ConfigEntryState,
  ConfigEntryView,
} from './types.js';

export interface MaskOptions {
  /**
   * Serve a `sealTo` value as ciphertext to a reader carrying `config:secrets:read` (the tenant
   * API: only the target app's private key opens it). The console never sets this: it shows
   * "sealed for <app>" instead of a reveal.
   */
  serveSealed?: boolean;
}

/**
 * The document as `reader` may see it: a secret entry's value is dropped unless the reader carries
 * `config:secrets:read`. A vault-backed entry is treated as a secret: the reference itself names a
 * credential path. A `sealTo` entry is hidden even from a secret reader unless {@link
 * MaskOptions.serveSealed} is set, because no control plane can read it.
 */
export function maskDocument(
  document: ConfigDocument,
  canReadSecrets: boolean,
  options: MaskOptions = {},
): ConfigDocumentView {
  const entries: Record<string, ConfigEntryView> = {};
  for (const [key, entry] of Object.entries(document.entries)) {
    entries[key] = maskEntry(entry, canReadSecrets, options);
  }
  return {
    app: document.app,
    environment: document.environment,
    label: document.label,
    version: document.version,
    entries,
    createdAt: document.createdAt,
    createdBy: document.createdBy,
    ...(document.message !== undefined ? { message: document.message } : {}),
    fingerprint: document.fingerprint,
  };
}

export function maskEntry(
  entry: ConfigEntryState,
  canReadSecrets: boolean,
  options: MaskOptions = {},
): ConfigEntryView {
  const hidden =
    (!canReadSecrets && (entry.secret || entry.vault !== undefined)) ||
    (entry.sealedTo !== undefined && options.serveSealed !== true);
  if (hidden) {
    const { value: _value, ...rest } = entry;
    return { ...rest, masked: true };
  }
  return { ...entry, masked: false };
}

/** Whether an entry holds a secret (or a vault reference) at all. */
export function isHiddenEntry(entry: ConfigEntryState): boolean {
  return entry.secret || entry.vault !== undefined || entry.sealedTo !== undefined;
}
