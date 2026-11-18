import {
  createTenantClient,
  setTenantBootstrap,
  type TenantClient,
  type TenantClientOptions,
  tenantBootstrapKey,
} from './topology/tenant_client.js';

export interface BootstrapOptions extends TenantClientOptions {
  /** Put the received non-secret values in `process.env` when the variable is not set. Default `true`. */
  env?: boolean;
}

export interface BootstrapResult {
  client: TenantClient;
  /** Whether the values came from the control plane or from the snapshot. */
  source: 'remote' | 'snapshot' | 'none';
  entries: number;
  version: number;
}

/**
 * Fetches the configuration **before the application exists**, so `config/*.ts` files see the remote
 * values while they load. This is the Spring Cloud Config bootstrap phase, and it runs in
 * `bin/server.ts`, before `#start/env` and the Ignitor:
 *
 * ```ts
 * import { bootstrapConfig } from '@adonis-agora/config/bootstrap'
 *
 * await bootstrapConfig({
 *   url: process.env.CONFIG_URL!,
 *   partition: process.env.CONFIG_APP!,
 *   token: { get: async () => mintTokenFromEnv() },
 *   snapshotPath: 'storage/config/snapshot.json',
 *   env: true,
 * })
 * ```
 *
 * Only the issuer, the client id/secret and the server URL come from the environment: the token is
 * obtained before the app's own config loads and must not depend on a provider this server
 * configures. The client is cached; the provider reuses it instead of fetching twice.
 */
export async function bootstrapConfig(options: BootstrapOptions): Promise<BootstrapResult> {
  const client = createTenantClient({ ...options, env: options.env ?? true });
  await client.start();
  setTenantBootstrap(tenantBootstrapKey(options), client);
  const status = client.status();
  return {
    client,
    source: status.source,
    entries: Object.keys(client.entries()).length,
    version: status.version,
  };
}

export type {
  ImportRemoteConfigOptions,
  ImportRemoteConfigResult,
  LocalEnv,
} from './import_remote.js';
export { CONFIG_RESOURCE, importRemoteConfig } from './import_remote.js';
