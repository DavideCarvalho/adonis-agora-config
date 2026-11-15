export { type ConfigDashboardOptions, configDashboard } from './dashboard.js';
export {
  configActionsProvider,
  configChangesOverTimeProvider,
  configChangesProvider,
  configRevealsProvider,
  configStatsProvider,
  configTenantsProvider,
} from './data-providers.js';
export { configTelescopeExtension } from './extension.js';
export {
  registerConfigTelescopeExtension,
  TELESCOPE_EXTENSIONS_BINDING,
  type TelescopeContainerLike,
} from './register.js';
export type {
  Column,
  ContainerLike,
  DashboardSection,
  DashboardSpec,
  DataBinding,
  DataProvider,
  ExtensionContext,
  LinkSpec,
  Panel,
  PanelThresholds,
  TelescopeEntryLike,
  TelescopeExtension,
  TelescopeStoreLike,
} from './telescope-sdk.js';
