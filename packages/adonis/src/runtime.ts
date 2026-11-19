import type { ConfigValue } from '@adonis-agora/config-core';
import type { ControlPlane } from './http/control_plane.js';
import type { ConfigStore } from './store/store.js';
import type { TenantClient, TenantStatus } from './topology/tenant_client.js';
import type { TenantKeyring } from './topology/tenant_keyring.js';

/** Everything the provider built, shared by the service, the console and the commands. */
export interface ConfigRuntime {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** The environment this process belongs to. */
  environment: string;
  /** The app name on a standalone/control-plane, the partition on a tenant. */
  app: string;
  /** Control plane and standalone only. */
  store?: ConfigStore;
  controlPlane?: ControlPlane;
  /** Tenant only. */
  client?: TenantClient;
  /** Tenant only: the app's own X25519 keyring (opens secrets sealed to it). */
  keys?: TenantKeyring;
  /** Whether an encryption codec is configured (secrets can be stored and read). */
  secrets: boolean;
  /** `true` when the tenant lets local env win (`tenant.localEnv`, on outside production). */
  localEnv: boolean;
  /** One value: the tenant's resolved config, or the standalone app's own document. */
  get(key: string, fallback?: ConfigValue): ConfigValue | undefined;
  /** Every value the app may use. */
  all(): Record<string, ConfigValue>;
  /** What the tenant loaded: source, version, staleness. Undefined on a server. */
  status(): TenantStatus | undefined;
}
