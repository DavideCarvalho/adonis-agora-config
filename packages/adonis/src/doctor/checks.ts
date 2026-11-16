import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import type { ConfigConfig, TenantTopologyConfig } from '../define_config.js';
import { getRuntime, hasRuntime } from '../services/accessor.js';
import { createTenantClient } from '../topology/tenant_client.js';
import { TenantUrl } from '../topology/tenant_url.js';
import { resolveTenantToken } from '../topology/token.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/config';

function tenantConfig(app: ApplicationService): TenantTopologyConfig | null {
  const config = app.config.get<ConfigConfig | undefined>('config');
  return config?.topology === 'tenant' ? config : null;
}

function tenantEnvironment(config: TenantTopologyConfig): string {
  return config.tenant.environment ?? config.environment ?? process.env.NODE_ENV ?? 'production';
}

/** The headers a tenant call carries: the token, plus the claims a shared-secret verifier needs. */
async function headers(config: TenantTopologyConfig): Promise<Record<string, string>> {
  const token = await resolveTenantToken(config.tenant.token).get();
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'x-config-app': config.tenant.partition,
    'x-config-environment': tenantEnvironment(config),
    'x-config-label': config.tenant.label ?? 'main',
  };
}

/**
 * The config checks: can a tenant reach the server, does its token work, is the snapshot fresh,
 * does a Sail worktree keep its own ports, and is there an encryption codec. `agora:doctor` runs them;
 * cheap checks read config and files, deep ones touch the network (use `--deep`).
 */
export const agoraDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'config.reachable',
    lib: 'config',
    title: 'Control plane reachable',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = tenantConfig(app);
      if (!config) {
        const server = app.config.get<ConfigConfig | undefined>('config');
        return server?.topology === 'control-plane'
          ? {
              status: 'skip',
              message: 'This process is a control plane: it serves tenants and reads no server.',
            }
          : { status: 'skip', message: 'This process is standalone: it reads no server.' };
      }
      const client = createTenantClient({
        url: config.tenant.url,
        partition: config.tenant.partition,
        token: config.tenant.token,
        environment: tenantEnvironment(config),
        ...(config.tenant.label ? { label: config.tenant.label } : {}),
        stream: false,
      });
      try {
        await client.refresh();
        const status = client.status();
        if (status.lastError !== null) {
          const lazy = typeof config.tenant.url === 'function';
          if (lazy && client.url === undefined) {
            return {
              status: 'error',
              message: `The lazy tenant.url did not resolve: ${status.lastError}.`,
              fix: 'Check that the issuer publishes a control plane for urn:agora:config in its discovery document.',
              docs: `${DOCS}/tenant`,
            };
          }
          return {
            status: 'error',
            message: `${client.url} answered nothing: ${status.lastError}.`,
            fix: lazy
              ? 'Check that the control plane the issuer publishes is running (and its /_config prefix).'
              : 'Check CONFIG_URL (including its /_config prefix) and that the control plane is running.',
            docs: `${DOCS}/tenant`,
          };
        }
        return {
          status: 'ok',
          message: `${status.app}/${status.environment}/${status.label} at v${status.version} (${Object.keys(client.entries()).length} entries).`,
        };
      } catch (error) {
        return {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          fix: 'Check the tenant configuration.',
          docs: `${DOCS}/tenant`,
        };
      } finally {
        await client.stop();
      }
    },
  },
  {
    id: 'config.token',
    lib: 'config',
    title: 'Tenant token accepted',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = tenantConfig(app);
      if (!config) {
        return {
          status: 'skip',
          message: 'No tenant token in this process (a server validates tokens instead).',
        };
      }
      try {
        const base = await new TenantUrl(config.tenant.url).resolve();
        const response = await fetch(`${base}/v1/whoami`, {
          headers: await headers(config),
        });
        if (response.status === 401) {
          return {
            status: 'error',
            message: 'The control plane refused the tenant token (401).',
            fix: 'Check CONFIG_TOKEN / the authkit client credentials, and that the client is registered for urn:agora:config.',
            docs: `${DOCS}/authentication`,
          };
        }
        if (response.status === 403) {
          return {
            status: 'error',
            message: 'The token was accepted but lacks config:read (403).',
            fix: 'Grant the client the config:read scope (and config:secrets:read where secrets are needed).',
            docs: `${DOCS}/authentication`,
          };
        }
        if (!response.ok) {
          return {
            status: 'error',
            message: `The control plane answered ${response.status} to /v1/whoami.`,
            fix: 'Check CONFIG_URL and the server logs.',
            docs: `${DOCS}/control-plane`,
          };
        }
        const who = (await response.json()) as {
          partition?: string;
          environment?: string;
          capabilities?: string[];
          expiresAt?: string;
        };
        return {
          status: 'ok',
          message: `Token for ${who.partition ?? config.tenant.partition}/${who.environment ?? '?'} (${(who.capabilities ?? []).join(', ') || 'no capabilities'})${who.expiresAt ? `, expires ${who.expiresAt}` : ''}.`,
        };
      } catch (error) {
        return {
          status: 'error',
          message: `Could not reach the token check: ${error instanceof Error ? error.message : String(error)}`,
          fix: 'Check CONFIG_URL and the network between the app and the control plane.',
          docs: `${DOCS}/deployment`,
        };
      }
    },
  },
  {
    id: 'config.snapshot-age',
    lib: 'config',
    title: 'Snapshot is fresh',
    cost: 'cheap',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = tenantConfig(app);
      if (!config?.tenant.snapshotPath) {
        return {
          status: 'skip',
          message:
            'No snapshotPath: an outage at boot leaves the app with its local configuration.',
          fix: 'Set tenant.snapshotPath so the app can boot from the last document.',
          docs: `${DOCS}/tenant`,
        };
      }
      const path = join(app.makePath(), config.tenant.snapshotPath);
      try {
        const info = await stat(path);
        const days = Math.floor((Date.now() - info.mtimeMs) / 86_400_000);
        if (days > 7) {
          return {
            status: 'warn',
            message: `The snapshot at ${config.tenant.snapshotPath} is ${days} days old.`,
            fix: 'The tenant may have been unable to refresh for a while; check config:reachable and the server logs.',
            docs: `${DOCS}/tenant`,
          };
        }
        return {
          status: 'ok',
          message: `Snapshot written ${days === 0 ? 'today' : `${days} day(s) ago`} (${config.tenant.snapshotPath}).`,
        };
      } catch {
        return {
          status: 'warn',
          message: `No snapshot yet at ${config.tenant.snapshotPath}.`,
          fix: 'It is written after the first successful fetch; check config:reachable.',
          docs: `${DOCS}/tenant`,
        };
      }
    },
  },
  {
    id: 'config.local-env',
    lib: 'config',
    title: 'Sail worktree keeps its ports',
    cost: 'cheap',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = tenantConfig(app);
      if (!config) return { status: 'skip', message: 'Not a tenant.' };
      if (config.tenant.localEnv !== false && config.tenant.localEnv !== undefined) {
        return { status: 'ok', message: 'tenant.localEnv is on: local variables win per key.' };
      }
      if (process.env.NODE_ENV === 'production') {
        return {
          status: 'ok',
          message: 'localEnv is off in production: the config server is the source of truth.',
        };
      }
      let sail = false;
      try {
        const env = await readFile(join(app.makePath(), '.env.local'), 'utf8');
        sail = env.includes('# sail:start');
      } catch {
        sail = false;
      }
      if (!sail) {
        return { status: 'ok', message: 'No Sail-managed .env.local detected.' };
      }
      return {
        status: 'warn',
        message:
          'This looks like a Sail worktree, but tenant.localEnv is off: the server’s db.port can shadow the worktree’s ports.',
        fix: 'Set tenant.localEnv: true (it is the default outside production in the provider; an explicit false turns it off).',
        docs: `${DOCS}/sail`,
      };
    },
  },
  {
    id: 'config.crypto',
    lib: 'config',
    title: 'Secret encryption and rotation',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = app.config.get<ConfigConfig | undefined>('config');
      if (!config || config.topology === 'tenant') {
        return {
          status: 'skip',
          message: 'A tenant reads secrets from the server; it has no key of its own.',
        };
      }
      if (hasRuntime() && getRuntime().store?.cryptoStatus) {
        try {
          const counts = await getRuntime().store!.cryptoStatus!();
          const broken = counts.unreadable;
          const old = counts.retired + counts.legacy;
          if (broken > 0) {
            return {
              status: 'error',
              message: `${broken} stored secret(s) cannot be opened with the current keys.`,
              fix: 'Restore the missing key in crypto.keys, or re-seal the values with `node ace config:crypto:reseal`.',
              docs: `${DOCS}/secrets`,
            };
          }
          if (old > 0) {
            return {
              status: 'warn',
              message: `${counts.retired} retired and ${counts.legacy} legacy secret(s) need re-sealing.`,
              fix: 'Run `node ace config:crypto:reseal` (add --dry-run to preview).',
              docs: `${DOCS}/secrets`,
            };
          }
          return {
            status: 'ok',
            message: `${counts.active} stored secret(s) use the active key.`,
          };
        } catch {
          // A custom store without the scan falls through to the key-presence check.
        }
      }
      if (config.crypto?.keys?.length) {
        return { status: 'ok', message: `${config.crypto.keys.length} crypto keys configured.` };
      }
      if (config.crypto?.encryption) {
        return {
          status: 'ok',
          message: 'Secrets use the encryption instance passed in `crypto.encryption`.',
        };
      }
      if (process.env.APP_KEY) {
        return {
          status: 'ok',
          message:
            'Secrets use the app encryption service (`config/encryption.ts`); APP_KEY is the fallback.',
        };
      }
      return {
        status: 'warn',
        message: 'No encryption service, APP_KEY or crypto.keys: writing a secret will fail.',
        fix: 'Set up `config/encryption.ts` (the default), or pass `crypto.keys` in config/config.ts, or set APP_KEY.',
        docs: `${DOCS}/secrets`,
      };
    },
  },
  {
    id: 'config.tenant-key',
    lib: 'config',
    title: 'Sealed secrets: the app key',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = app.config.get<ConfigConfig | undefined>('config');
      if (!config || config.topology !== 'tenant') {
        return {
          status: 'skip',
          message: 'Only a tenant holds the private key secrets are sealed to.',
        };
      }
      if (config.tenant.keyPath === false) {
        return {
          status: 'ok',
          message: 'tenant.keyPath is false: this app receives no sealed secrets.',
        };
      }
      if (!hasRuntime()) {
        return { status: 'skip', message: 'The config runtime is not built yet.' };
      }
      const runtime = getRuntime();
      if (!runtime.keys) {
        return {
          status: 'warn',
          message:
            'No tenant keyring: no encryption key (config/encryption.ts or APP_KEY), so the app cannot hold the X25519 key sealed values need.',
          fix: 'Set up `config/encryption.ts` (or APP_KEY) so the private key can be sealed at rest, or set tenant.keyPath: false if this app never receives sealed secrets.',
          docs: `${DOCS}/secrets#sealed-to-an-app`,
        };
      }
      const status = runtime.client?.keyStatus();
      if (!status) {
        return { status: 'skip', message: 'The tenant client is not running.' };
      }
      if (status.unreadable > 0) {
        return {
          status: 'error',
          message: `${status.unreadable} sealed secret(s) could not be opened (missing private key, changed encryption key, or a copied key file).`,
          fix: 'Restore the old private key in the key file, or ask an operator to re-write the entry so it is sealed to the active key.',
          docs: `${DOCS}/secrets#sealed-to-an-app`,
        };
      }
      if (status.registered === false) {
        return {
          status: 'warn',
          message: `The public key ${status.activeKid} is not registered with the control plane${status.error ? ` (${status.error})` : ''}.`,
          fix: 'Run `node ace config:tenant:key` (or check the token/URL) so operators can seal values to this app.',
          docs: `${DOCS}/secrets#sealed-to-an-app`,
        };
      }
      if (status.staleKids.length > 0) {
        return {
          status: 'warn',
          message: `${status.sealed - status.unreadable} sealed secret(s) still use retired key(s): ${status.staleKids.join(', ')}.`,
          fix: 'Run `node ace config:tenant:key --reseal` to seal them to the active key.',
          docs: `${DOCS}/secrets#sealed-to-an-app`,
        };
      }
      return {
        status: 'ok',
        message: `${status.sealed} sealed secret(s) on active key ${status.activeKid}.`,
      };
    },
  },
];
