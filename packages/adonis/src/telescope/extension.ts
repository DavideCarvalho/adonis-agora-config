import { type ConfigDashboardOptions, configDashboard } from './dashboard.js';
import {
  configActionsProvider,
  configChangesOverTimeProvider,
  configChangesProvider,
  configRevealsProvider,
  configStatsProvider,
  configTenantsProvider,
} from './data-providers.js';
import type { TelescopeExtension } from './telescope-sdk.js';

/**
 * The first-class `@adonis-agora/telescope` extension for `@adonis-agora/config`: a
 * "Configuration" page with the store's health, write activity, recent changes, secret reveals and
 * the tenants this control plane saw. The provider pushes it into
 * `'agora.telescope.extensions'`, so no `config/telescope.ts` change is needed; wiring it explicitly
 * also works (a configured extension wins over the bound one):
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope'
 * import { configTelescopeExtension } from '@adonis-agora/config/telescope'
 *
 * export default defineConfig({ extensions: [configTelescopeExtension()] })
 * ```
 *
 * No watcher and no entry type are contributed: the config milestones are published on the
 * diagnostics bus and telescope's generic diagnostics watcher records them as `diagnostic` entries
 * tagged `lib:config`. The returned object structurally satisfies telescope's `TelescopeExtension`
 * (it is never imported — see `telescope-sdk.ts`).
 */
export function configTelescopeExtension(opts: ConfigDashboardOptions = {}): TelescopeExtension {
  return {
    name: 'config',
    dashboards: () => [configDashboard(opts)],
    dataProviders: () => [
      configChangesProvider(),
      configRevealsProvider(),
      configChangesOverTimeProvider(),
      configActionsProvider(),
      configTenantsProvider(),
      configStatsProvider(),
    ],
  };
}
