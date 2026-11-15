import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigConfig } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/checks.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { setRuntime } from '../../src/services/accessor.js';
import { memoryConfig } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];
const dirs: string[] = [];
const env = { ...process.env };

afterEach(async () => {
  process.env = { ...env };
  setRuntime(undefined);
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-config-doctor-'));
  dirs.push(dir);
  return dir;
}

function fakeApp(config: ConfigConfig, root: string): ApplicationService {
  return {
    config: { get: (key: string) => (key === 'config' ? config : undefined) },
    makePath: (path = '') => join(root, path),
  } as unknown as ApplicationService;
}

function tenant(url: string, extra: Partial<ConfigConfig> = {}) {
  return {
    topology: 'tenant',
    tenant: {
      url,
      partition: 'shop',
      token: 'shop-secret',
      stream: false,
    },
    ...extra,
  } as ConfigConfig;
}

function check(id: string) {
  const found = agoraDoctorChecks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

async function server(
  verifyTenant = sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
) {
  const controlPlane = new ControlPlane({
    store: memoryConfig(),
    verifyTenant,
    environment: 'production',
  });
  const routes: Route[] = [];
  controlPlane.register({
    get(pattern, handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
  });
  const instance = await serve(routes);
  servers.push(instance);
  return `${addressOf(instance)}/_config`;
}

describe('config doctor checks', () => {
  it('reports a reachable control plane and a working token', async () => {
    const root = await workspace();
    const url = await server();
    const app = fakeApp(tenant(url), root);
    expect(await check('config.reachable').run(app)).toMatchObject({ status: 'ok' });
    expect(await check('config.token').run(app)).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('config:read'),
    });
  });

  it('reports an unreachable server and a refused token', async () => {
    const root = await workspace();
    const down = fakeApp(tenant('http://127.0.0.1:1/_config'), root);
    expect(await check('config.reachable').run(down)).toMatchObject({
      status: 'error',
      fix: expect.stringContaining('CONFIG_URL'),
    });

    const url = await server(async () => null);
    const refused = fakeApp(tenant(url), root);
    expect(await check('config.token').run(refused)).toMatchObject({
      status: 'error',
      message: expect.stringContaining('401'),
    });
  });

  it('warns when the snapshot is old or missing, and passes when fresh', async () => {
    const root = await workspace();
    const path = join(root, 'storage', 'snapshot.json');
    await mkdir(join(root, 'storage'), { recursive: true });
    await writeFile(path, '{}');
    const config = tenant('http://127.0.0.1:1/_config');
    (config as { tenant: { snapshotPath?: string } }).tenant.snapshotPath = 'storage/snapshot.json';
    const app = fakeApp(config, root);

    expect(await check('config.snapshot-age').run(app)).toMatchObject({ status: 'ok' });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    await utimes(path, tenDaysAgo, tenDaysAgo);
    expect(await check('config.snapshot-age').run(app)).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('10 days'),
    });

    const missing = fakeApp(
      {
        topology: 'tenant',
        tenant: {
          url: 'http://127.0.0.1:1/_config',
          partition: 'shop',
          token: 'x',
          snapshotPath: 'storage/gone.json',
        },
      } as ConfigConfig,
      root,
    );
    expect(await check('config.snapshot-age').run(missing)).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('No snapshot'),
    });
  });

  it('warns when a Sail worktree would lose its ports', async () => {
    const root = await workspace();
    await writeFile(join(root, '.env.local'), '# sail:start\nDB_PORT=5789\n# sail:end\n');
    process.env.NODE_ENV = 'development';
    const tenantConfig = tenant('http://127.0.0.1:1/_config', {
      tenant: {
        url: 'http://127.0.0.1:1/_config',
        partition: 'shop',
        token: 'x',
        localEnv: false,
      },
    } as never);
    expect(await check('config.local-env').run(fakeApp(tenantConfig, root))).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('tenant.localEnv'),
    });
    const enabled = tenant('http://127.0.0.1:1/_config', {
      tenant: {
        url: 'http://127.0.0.1:1/_config',
        partition: 'shop',
        token: 'x',
        localEnv: true,
      },
    } as never);
    expect(await check('config.local-env').run(fakeApp(enabled, root))).toMatchObject({
      status: 'ok',
    });
  });

  it('reports the default APP_KEY keyring, explicit crypto.keys, or warns without either', async () => {
    const root = await workspace();
    const config = {
      topology: 'control-plane',
      verifyTenant: async () => null,
    } as ConfigConfig;
    delete process.env.APP_KEY;
    expect(await check('config.crypto').run(fakeApp(config, root))).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('crypto.keys'),
    });

    process.env.APP_KEY = 'a-test-app-key-of-32-characters!';
    expect(await check('config.crypto').run(fakeApp(config, root))).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('APP_KEY'),
    });

    const withKeys = {
      ...config,
      crypto: { keys: [{ id: '2026-11', secret: 'a-key-of-sixteen-plus' }], active: '2026-11' },
    } as ConfigConfig;
    expect(await check('config.crypto').run(fakeApp(withKeys, root))).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('crypto keys'),
    });
  });

  it('reports the tenant sealed-secret key: off, missing, unreadable or retired', async () => {
    const root = await workspace();
    const off = {
      topology: 'tenant',
      tenant: {
        url: 'http://127.0.0.1:1/_config',
        partition: 'shop',
        token: 'x',
        keyPath: false,
      },
    } as ConfigConfig;
    expect(await check('config.tenant-key').run(fakeApp(off, root))).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('keyPath is false'),
    });

    const enabled = tenant('http://127.0.0.1:1/_config');
    setRuntime({
      topology: 'tenant',
      environment: 'production',
      app: 'shop',
      secrets: false,
      localEnv: false,
      get: () => undefined,
      all: () => ({}),
      status: () => undefined,
    } as never);
    expect(await check('config.tenant-key').run(fakeApp(enabled, root))).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('APP_KEY'),
    });

    const withStatus = (keys: Record<string, unknown>): ConfigConfig => enabled;
    const status = (value: Record<string, unknown>) => ({
      topology: 'tenant',
      environment: 'production',
      app: 'shop',
      keys: {},
      secrets: false,
      localEnv: false,
      get: () => undefined,
      all: () => ({}),
      status: () => undefined,
      client: { keyStatus: () => ({ kids: ['k'], activeKid: 'k', ...value }) },
    });

    setRuntime(status({ unreadable: 2, sealed: 2 }) as never);
    expect(await check('config.tenant-key').run(fakeApp(withStatus({}), root))).toMatchObject({
      status: 'error',
      message: expect.stringContaining('2 sealed secret(s)'),
    });

    setRuntime(status({ unreadable: 0, sealed: 2, registered: false }) as never);
    expect(await check('config.tenant-key').run(fakeApp(withStatus({}), root))).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('config:tenant:key'),
    });

    setRuntime(status({ unreadable: 0, sealed: 2, registered: true, staleKids: ['old'] }) as never);
    expect(await check('config.tenant-key').run(fakeApp(withStatus({}), root))).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('--reseal'),
    });

    setRuntime(status({ unreadable: 0, sealed: 2, registered: true, staleKids: [] }) as never);
    expect(await check('config.tenant-key').run(fakeApp(withStatus({}), root))).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('active key k'),
    });
  });
});
