import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapConfig } from '../../src/bootstrap.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { takeTenantBootstrap, tenantBootstrapKey } from '../../src/topology/tenant_client.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import type { Handler } from '../http_harness.js';
import { addressOf, serve } from '../http_harness.js';

const servers: Server[] = [];
const env = { ...process.env };

afterEach(async () => {
  process.env = { ...env };
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function start(store: ReturnType<typeof memoryConfig>) {
  const controlPlane = new ControlPlane({
    store,
    verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    environment: 'production',
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  controlPlane.register({
    get(pattern, handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
  });
  const server = await serve(routes);
  servers.push(server);
  return `${addressOf(server)}/_config`;
}

describe('bootstrapConfig', () => {
  it('loads before the app exists, fills unset env vars and caches the client', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      ['db.host', 'db.internal'],
      ['db.port', 5432],
      ['checkout.timeoutMs', 3000],
    ]);
    const url = await start(store);
    process.env.DB_HOST = 'from-local-env';
    delete process.env.CHECKOUT_TIMEOUT_MS;

    const result = await bootstrapConfig({
      url,
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
      intervalMs: 60_000,
      env: true,
    });

    expect(result.source).toBe('remote');
    expect(result.version).toBe(1);
    expect(result.entries).toBe(3);
    // An existing env var is never overwritten: `.env.local` (and Sail) wins.
    expect(process.env.DB_HOST).toBe('from-local-env');
    expect(process.env.DB_PORT).toBe('5432');
    expect(process.env.CHECKOUT_TIMEOUT_MS).toBe('3000');

    const key = tenantBootstrapKey({ url, partition: 'shop' });
    expect(takeTenantBootstrap(key)).toBe(result.client);
    expect(takeTenantBootstrap('other')).toBeUndefined();
    await result.client.stop();
  });

  it('boots from the snapshot when the control plane is unreachable', async () => {
    const path = join(tmpdir(), `agora-config-bootstrap-${Date.now()}.json`);
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        app: 'shop',
        environment: 'production',
        label: 'main',
        version: 3,
        fingerprint: 'x',
        entries: {
          'db.host': {
            value: 'snapshot-host',
            secret: false,
            reloadable: false,
            updatedAt: new Date(0).toISOString(),
            updatedBy: 'ann',
            masked: false,
          },
        },
        createdAt: new Date(0).toISOString(),
        createdBy: 'ann',
      }),
    );
    try {
      const result = await bootstrapConfig({
        url: 'http://127.0.0.1:1/_config',
        partition: 'shop',
        token: 'shop-secret',
        snapshotPath: path,
        stream: false,
        intervalMs: 60_000,
      });
      expect(result.source).toBe('snapshot');
      expect(result.client.get('db.host')).toBe('snapshot-host');
      await result.client.stop();
    } finally {
      await rm(path, { force: true });
    }
  });
});
