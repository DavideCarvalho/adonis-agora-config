export type { ConfigDocumentView, ConfigEntryView, ConfigValue } from '@adonis-agora/config-core';
export {
  ConfigClient,
  type ConfigClientOptions,
  type ConfigClientStatus,
  createConfigClient,
  fetchConfig,
  type Whoami,
} from './client.js';
export {
  resolveTenantToken,
  type TenantToken,
  type TenantTokenSource,
} from './token.js';
