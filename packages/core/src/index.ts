export { diffDocuments, diffSummary } from './diff.js';
export { canonicalJson, documentValues, flattenObject, unflattenObject } from './json.js';
export {
  assertConfigKey,
  cloneEntries,
  coerceEnvValue,
  envNameOf,
  envValueOf,
  isVaultReference,
  keyFromEnvName,
  parseConfigValue,
  parseVaultReference,
  serializeConfigValue,
  toConfigValue,
  type VaultReference,
  vaultReference,
} from './keys.js';
export { isHiddenEntry, type MaskOptions, maskDocument, maskEntry } from './mask.js';
export type {
  ConfigAuditAction,
  ConfigAuditRecord,
  ConfigDiffRow,
  ConfigDocument,
  ConfigDocumentView,
  ConfigEntryInput,
  ConfigEntryState,
  ConfigEntryView,
  ConfigScalar,
  ConfigScope,
  ConfigSealedTo,
  ConfigSnapshot,
  ConfigValue,
  OffsetPage,
  ScopeSummary,
} from './types.js';
export { etagMatches, etagOf, fingerprintOf } from './version.js';

/** The scopes a tenant token may carry. The product resource is `urn:agora:config`. */
export const CONFIG_SCOPES = {
  /** Read the app's configuration. */
  read: 'config:read',
  /** Read secret values (`config:read` is still required). */
  secretsRead: 'config:secrets:read',
  /** Write entries through the admin API (humans use the console gate instead). */
  write: 'config:write',
} as const;

/** The token resource every config control plane validates. */
export const CONFIG_RESOURCE = 'urn:agora:config';

/** The default label, Spring Cloud Config's `application` profile slot. */
export const DEFAULT_LABEL = 'main';

/** The default environment when neither the token nor the tenant config names one. */
export const DEFAULT_ENVIRONMENT = 'production';
