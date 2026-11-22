import { type ConfigValue } from '@adonis-agora/config-core';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import type { ConfigChangeSet } from '../src/topology/tenant_client.js';

/**
 * `import config from '@adonis-agora/config/services/main'` — the tenant's configuration.
 *
 * ```ts
 * import config from '@adonis-agora/config/services/main'
 *
 * config.get('checkout.timeoutMs', 3000)   // reloadable: changes apply without a restart
 * config.get('db.host')                    // boot-time: changes need a restart
 * config.status()                          // where the values came from
 * ```
 *
 * On a control plane or a standalone app, `get` reads that app's own scope from the store; on a
 * tenant it reads what the tenant fetched.
 */
const config = {
  /** Whether the config runtime is booted (safe to call from anywhere). */
  get ready(): boolean {
    return hasRuntime();
  },

  get<T = ConfigValue>(key: string, fallback?: T): ConfigValue | T | undefined {
    if (!hasRuntime()) return fallback;
    return getRuntime().get(key, fallback as ConfigValue | undefined) as
      | ConfigValue
      | T
      | undefined;
  },

  /** One value as a string, for env-shaped settings. */
  getString(key: string, fallback?: string): string | undefined {
    const value = config.get(key, undefined);
    if (value === undefined) return fallback;
    return typeof value === 'string' ? value : JSON.stringify(value);
  },

  all(): Record<string, ConfigValue> {
    return hasRuntime() ? getRuntime().all() : {};
  },

  /**
   * The values this app's pages may read: the keys listed in `browser.keys`, never a secret. Share
   * them with Inertia (`sharedData: { config: () => config.browser() }`) or Edge.
   */
  browser(): Record<string, ConfigValue> {
    return hasRuntime() ? getRuntime().browser() : {};
  },

  /** The same values as nested JSON (`db.port` → `{ db: { port } }`). */
  nested(): Record<string, ConfigValue> {
    return getRuntime().client?.nested() ?? {};
  },

  get environment(): string | undefined {
    return hasRuntime() ? getRuntime().environment : undefined;
  },

  get app(): string | undefined {
    return hasRuntime() ? getRuntime().app : undefined;
  },

  get topology(): 'standalone' | 'control-plane' | 'tenant' | undefined {
    return hasRuntime() ? getRuntime().topology : undefined;
  },

  /** Where a tenant's values came from, its version and whether it is running stale. */
  status() {
    return hasRuntime() ? getRuntime().status() : undefined;
  },

  /** The tenant client (undefined on a server). */
  get client() {
    return hasRuntime() ? getRuntime().client : undefined;
  },

  /** The store (undefined on a tenant). */
  get store() {
    return hasRuntime() ? getRuntime().store : undefined;
  },

  /** Subscribes to a tenant's changes; returns an unsubscribe function. */
  onChange(listener: (change: ConfigChangeSet) => void): () => void {
    return getRuntime().client?.onChange(listener) ?? (() => {});
  },
};

export default config;
