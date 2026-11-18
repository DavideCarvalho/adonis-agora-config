export {
  CONFIG_RESOURCE,
  CONFIG_SCOPES,
  type ConfigAuditRecord,
  type ConfigDiffRow,
  type ConfigDocument,
  type ConfigDocumentView,
  type ConfigEntryInput,
  type ConfigEntryState,
  type ConfigEntryView,
  type ConfigScope,
  type ConfigSealedTo,
  type ConfigSnapshot,
  type ConfigValue,
  capabilityAllows,
  DEFAULT_ENVIRONMENT,
  DEFAULT_LABEL,
  diffDocuments,
  flattenObject,
  maskDocument,
  type OffsetPage,
  type ScopeSummary,
  unflattenObject,
} from '@adonis-agora/config-core';
export {
  ConfigAdmin,
  ConfigCursorError,
  type EntryFilters,
  type EntryRow,
  type EntrySort,
  type SetEntryOptions,
} from './admin.js';
export { type BootstrapOptions, type BootstrapResult, bootstrapConfig } from './bootstrap.js';
export {
  ConfigClient,
  type ConfigClientOptions,
  type ConfigClientStatus,
  createConfigClient,
  fetchConfig,
  type Whoami,
} from './client.js';
export {
  CONFIG_SECRET_PURPOSE,
  type CryptoKey,
  type CryptoOptions,
  createConfigKeyring,
  type EncrypterLike,
  entryAad,
  isKitValue,
  keyringCodec,
  type SecretCodec,
} from './crypto/secrets.js';
export {
  activeTenantKey,
  normalizePublicKey,
  registerTenantKeys,
  resealTenantEntries,
  sealForApp,
  type TenantResealUpdate,
} from './crypto/tenant_keys.js';
export { type ConsoleActor, consoleActor } from './dashboard/actor.js';
export {
  anyAuthorize,
  authorizeByToken,
  type ConsoleAuthorize,
  type ConsoleAuthorizeDecision,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  type ConsoleAuthorizerClass,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './dashboard/console_authorize.js';
export {
  type ConfigConsoleConfig,
  consolePath,
  type ResolvedConsoleConfig,
  resolveConsoleConfig,
} from './dashboard/define_config.js';
export {
  type ConfigConfig,
  type ControlPlaneConfig,
  defineConfig,
  type Factory,
  type FactoryContext,
  type StandaloneConfig,
  stores,
  type TenantTopologyConfig,
  type VaultConfig,
  type VaultResolver,
} from './define_config.js';
export { configDevTools, registerConfigDevTools } from './dev_tools.js';
export { agoraDoctorChecks } from './doctor/checks.js';
export {
  ChangeBus,
  ControlPlane,
  type ControlPlaneOptions,
  configCsrfExceptions,
  knownTenants,
  resetKnownTenants,
  type TenantPresence,
} from './http/control_plane.js';
export { LucidStore, type LucidStoreOptions } from './store/lucid_store.js';
export { MemoryStore } from './store/memory_store.js';
export {
  CONFIG_AUDIT_INDEXES,
  type ConfigSchemaOptions,
  createConfigAuditIndexes,
  createConfigTables,
  dropConfigAuditIndexes,
  dropConfigTables,
} from './store/schema.js';
export type {
  AuditPosition,
  ConfigStore,
  StorePage,
  TenantPublicKey,
  TouchedEntry,
  VersionSummary,
  WriteContext,
} from './store/store.js';
export type {
  ConfigSyncChange,
  ConfigSyncOptions,
  ConfigSyncResult,
  ConfigSyncRule,
  ConfigSyncTarget,
  SyncedVariable,
} from './sync.js';
export { ConfigSync } from './sync.js';
export {
  type ConfigChangeSet,
  createTenantClient,
  TenantClient,
  type TenantClientOptions,
  type TenantKeyStatus,
  type TenantStatus,
} from './topology/tenant_client.js';
export {
  DEFAULT_TENANT_KEY_PATH,
  TenantKeyring,
  type TenantKeyringOptions,
  type TenantKeyringStatus,
} from './topology/tenant_keyring.js';
export { TenantUrl, type TenantUrlSource } from './topology/tenant_url.js';
export { resolveTenantToken, type TenantToken, type TenantTokenSource } from './topology/token.js';
export {
  bearerToken,
  checkVerifiedTenant,
  resolveTenantVerifier,
  type SharedSecretTenant,
  sharedSecretVerifier,
  type TenantAuthRequest,
  type TenantVerifier,
  type TenantVerifierInput,
  type TenantVerifierModule,
  type TenantVerifierObject,
  type VerifiedTenant,
} from './topology/verify.js';
export {
  type ConfigTransport,
  type ConfigTransportContext,
  type ConfigTransportFactory,
  type DurableControlPlaneLike,
  type DurableTransportConfig,
  type HttpTransportConfig,
  type RedisTransportConfig,
  transports,
} from './transports/index.js';
