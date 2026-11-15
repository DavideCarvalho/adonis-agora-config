import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlPlane } from '../../src/http/control_plane.js';
import type { ConfigStore } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { createTenantClient, type TenantClient } from '../../src/topology/tenant_client.js';
import { tokens } from '../../src/topology/token.js';
import { sharedSecretVerifier, type TenantVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];
const clients: TenantClient[] = [];
const dirs: string[] = [];
const env = { ...process.env };

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  process.env = { ...env };
});

function router(routes: Route[]) {
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
  };
}

async function startServer(store: ConfigStore, verifyTenant?: TenantVerifier) {
  const controlPlane = new ControlPlane({
    store,
    verifyTenant: verifyTenant ?? sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    environment: 'production',
  });
  const routes: Route[] = [];
  controlPlane.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { server, controlPlane, url: `${addressOf(server)}/_config` };
}

async function snapshotPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-config-'));
  dirs.push(dir);
  return join(dir, 'snapshot.json');
}

function client(options: Parameters<typeof createTenantClient>[0]): TenantClient {
  const created = createTenantClient(options);
  clients.push(created);
  return created;
}

describe('tenant client', () => {
  it('loads the document at start, exposes values and snapshots it', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      ['db.host', 'localhost'],
      ['checkout.timeoutMs', 3000],
    ]);
    const { url } = await startServer(store);
    const path = await snapshotPath();
    const tenant = client({
      url,
      partition: 'shop',
      token: 'shop-secret',
      snapshotPath: path,
      stream: false,
      intervalMs: 60_000,
      environment: 'production',
    });
    await tenant.start();

    expect(tenant.get('db.host')).toBe('localhost');
    expect(tenant.get('missing', 'fallback')).toBe('fallback');
    expect(tenant.getString('checkout.timeoutMs')).toBe('3000');
    expect(tenant.nested()).toEqual({ db: { host: 'localhost' }, checkout: { timeoutMs: 3000 } });
    expect(tenant.status()).toMatchObject({ source: 'remote', version: 1, stale: false });
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    expect(snapshot.app).toBe('shop');
    expect(snapshot.entries['db.host'].value).toBe('localhost');
  });

  it('hot-reloads reloadable keys and keeps boot-time values until a restart', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      { key: 'checkout.timeoutMs', value: 3000, reloadable: true },
      { key: 'db.host', value: 'localhost' },
    ]);
    const { url } = await startServer(store);
    const path = await snapshotPath();
    const tenant = client({
      url,
      partition: 'shop',
      token: 'shop-secret',
      snapshotPath: path,
      stream: false,
      intervalMs: 60_000,
    });
    const changes: Array<{ reloadable: string[]; restartRequired: string[] }> = [];
    tenant.onChange((change) => changes.push(change));
    await tenant.start();

    await store.write(
      testScope,
      [
        { key: 'checkout.timeoutMs', value: 5000 },
        { key: 'db.host', value: 'db.internal' },
        { key: 'checkout.enabled', value: true, reloadable: true },
      ],
      { actor: 'ann', now: new Date().toISOString() },
    );
    expect(await tenant.refresh()).toBe(true);

    expect(tenant.get('checkout.timeoutMs')).toBe(5000);
    expect(tenant.get('checkout.enabled')).toBe(true);
    // Boot-time key: the app keeps what it booted with.
    expect(tenant.get('db.host')).toBe('localhost');
    expect(changes.at(-1)).toMatchObject({
      reloadable: expect.arrayContaining(['checkout.timeoutMs', 'checkout.enabled']),
      restartRequired: ['db.host'],
    });
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    expect(snapshot.version).toBe(2);
    expect(snapshot.entries['db.host'].value).toBe('db.internal');
  });

  it('treats extra `tenant.reloadable` keys (and prefixes) as reloadable', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [['feature.a', false]]);
    const { url } = await startServer(store);
    const tenant = client({
      url,
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
      intervalMs: 60_000,
      reloadable: ['feature.*'],
    });
    await tenant.start();
    await store.write(testScope, [{ key: 'feature.a', value: true }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    await tenant.refresh();
    expect(tenant.get('feature.a')).toBe(true);
  });

  it('keeps the last values and reports staleness when the server goes down', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [['db.host', 'localhost']]);
    const { server, url } = await startServer(store);
    const tenant = client({
      url,
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
      intervalMs: 60_000,
    });
    await tenant.start();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);

    expect(await tenant.refresh()).toBe(false);
    expect(tenant.get('db.host')).toBe('localhost');
    expect(tenant.status()).toMatchObject({ stale: true, source: 'remote' });
    expect(tenant.status().lastError).toMatch(/ECONNREFUSED|fetch failed|connect/i);
  });

  it('boots from the snapshot when the server is down', async () => {
    const path = await snapshotPath();
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        app: 'shop',
        environment: 'production',
        label: 'main',
        version: 7,
        fingerprint: 'abc',
        entries: {
          'db.host': {
            value: 'from-snapshot',
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
    const tenant = client({
      url: 'http://127.0.0.1:1/_config',
      partition: 'shop',
      token: 'shop-secret',
      snapshotPath: path,
      stream: false,
      intervalMs: 60_000,
    });
    await tenant.start();
    expect(tenant.get('db.host')).toBe('from-snapshot');
    expect(tenant.status()).toMatchObject({ source: 'snapshot', version: 7, stale: true });
  });

  it('fails the boot when required and there is neither a server nor a snapshot', async () => {
    const tenant = client({
      url: 'http://127.0.0.1:1/_config',
      partition: 'shop',
      token: 'shop-secret',
      required: true,
      stream: false,
    });
    await expect(tenant.start()).rejects.toThrow(/no snapshot.*required/);
  });

  it('boots with local configuration when not required and nothing is reachable', async () => {
    const tenant = client({
      url: 'http://127.0.0.1:1/_config',
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
      intervalMs: 60_000,
    });
    await tenant.start();
    expect(tenant.status().source).toBe('none');
    expect(tenant.get('anything', 'local')).toBe('local');
  });

  it('lets a Sail worktree’s ports win over the server (localEnv)', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      ['db.port', 5432],
      ['db.host', 'db.internal'],
      ['checkout.timeoutMs', 3000],
    ]);
    const { url } = await startServer(store);
    process.env.DB_PORT = '5789';
    process.env.CHECKOUT_TIMEOUT_MS = '8000';
    const tenant = client({
      url,
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
      intervalMs: 60_000,
      localEnv: true,
    });
    await tenant.start();
    // Coerced to the remote value's type: a number, not the string .env carries.
    expect(tenant.get('db.port')).toBe(5789);
    expect(tenant.get('checkout.timeoutMs')).toBe(8000);
    // A key with no local override keeps the server's value.
    expect(tenant.get('db.host')).toBe('db.internal');

    const withoutLocal = client({
      url,
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
      intervalMs: 60_000,
    });
    await withoutLocal.start();
    expect(withoutLocal.get('db.port')).toBe(5432);
  });

  it('invalidates a cached token on 401', async () => {
    const store = memoryConfig();
    const { url } = await startServer(store, async () => null);
    const invalidate = vi.fn();
    const token = { get: async () => 'stale', invalidate };
    const tenant = client({
      url,
      partition: 'shop',
      token,
      stream: false,
      intervalMs: 60_000,
    });
    await tenant.start();
    expect(invalidate).toHaveBeenCalled();
    expect(tenant.status().lastError).toMatch(/401/);
  });

  it('reads a token source object or a function', async () => {
    expect(await tokens.static('x').get()).toBe('x');
    const fromFn = createTenantClient({
      url: 'http://127.0.0.1:1/_config',
      partition: 'shop',
      token: async () => 'from-function',
      stream: false,
    });
    expect(fromFn.status().app).toBe('shop');
  });
});
