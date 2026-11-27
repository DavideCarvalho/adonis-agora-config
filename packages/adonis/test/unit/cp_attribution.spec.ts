import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { normalizeConsoleAuthorizeResult } from '../../src/dashboard/console_authorize.js';
import { defineConfig } from '../../src/define_config.js';
import { configDevTools } from '../../src/dev_tools.js';
import { emitConfig } from '../../src/diagnostics.js';
import { ControlPlane, resetKnownTenants } from '../../src/http/control_plane.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import {
  createTenantClient,
  type TenantClient,
  tenantBootstrapKey,
} from '../../src/topology/tenant_client.js';
import { TenantUrl } from '../../src/topology/tenant_url.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

interface Emitted {
  lib: string;
  event: string;
  payload: Record<string, unknown>;
  opts?: { app?: string };
}

const servers: Server[] = [];
const clients: TenantClient[] = [];

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
  resetKnownTenants();
  for (const client of clients.splice(0)) await client.stop();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function capture(): Emitted[] {
  const emitted: Emitted[] = [];
  (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
    lib: string,
    event: string,
    payload: Record<string, unknown>,
    opts?: { app?: string },
  ) => {
    emitted.push({ lib, event, payload, ...(opts ? { opts } : {}) });
  };
  return emitted;
}

async function controlPlane() {
  const store = memoryConfig();
  await seedConfig(store, testScope, [['db.host', 'localhost']]);
  const plane = new ControlPlane({
    store,
    verifyTenant: sharedSecretVerifier({ partitions: { shop: 's' } }),
    environment: 'production',
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  plane.register({
    get(pattern, handler) {
      routes.push({ method: 'GET', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
  });
  const server = await serve(routes);
  servers.push(server);
  return `${addressOf(server)}/_config`;
}

function tenant(options: Parameters<typeof createTenantClient>[0]): TenantClient {
  const client = createTenantClient(options);
  clients.push(client);
  return client;
}

describe('diagnostics app attribution', () => {
  it('passes the payload app as the envelope app', () => {
    const emitted = capture();
    emitConfig('key.registered', { app: 'shop', kids: ['k1'], actor: 'shop' });
    emitConfig('crypto.reseal', { dryRun: true, all: false, scanned: 0, resealed: 0, failed: 0 });
    expect(emitted[0]).toMatchObject({
      lib: 'config',
      event: 'key.registered',
      opts: { app: 'shop' },
    });
    expect(emitted[1]?.opts).toBeUndefined();
  });

  it('the control plane emits tenant.fetch for a served document, not for a 304 poll', async () => {
    const emitted = capture();
    const base = await controlPlane();
    const headers = { authorization: 'Bearer s', 'x-config-app': 'shop' };
    expect((await fetch(`${base}/v1/config`, { headers })).status).toBe(200);
    const fetches = emitted.filter((item) => item.event === 'tenant.fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({
      opts: { app: 'shop' },
      payload: {
        app: 'shop',
        environment: 'production',
        label: 'main',
        version: 1,
        actor: 'shop',
        entries: 1,
        secrets: false,
      },
    });
    expect(JSON.stringify(fetches)).not.toContain('localhost');

    const notModified = await fetch(`${base}/v1/config`, {
      headers: { ...headers, 'if-none-match': '"shop:production:main:1"' },
    });
    expect(notModified.status).toBe(304);
    expect(emitted.filter((item) => item.event === 'tenant.fetch')).toHaveLength(1);
  });
});

describe('lazy tenant url', () => {
  it('accepts a function in defineConfig and still refuses a relative string', () => {
    const lazy = async () => 'https://config.example.com/_config';
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: lazy, partition: 'shop', token: 's' } }),
    ).not.toThrow();
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: '/_config', partition: 'shop', token: 's' },
      }),
    ).toThrow(/absolute http/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: undefined as never, partition: 'shop', auto: false, token: 's' },
      }),
    ).toThrow(/tenant.url is required/);
  });

  it('resolves once, shares concurrent lookups and refuses a non-http answer', async () => {
    let calls = 0;
    const url = new TenantUrl(async () => {
      calls += 1;
      return 'https://cp.example.com/_config/';
    });
    expect(url.current).toBeUndefined();
    const [a, b] = await Promise.all([url.resolve(), url.resolve()]);
    expect(a).toBe('https://cp.example.com/_config');
    expect(b).toBe(a);
    await url.resolve();
    expect(calls).toBe(1);
    await expect(new TenantUrl(async () => 'nope').resolve()).rejects.toThrow(/absolute http/);
    expect(await new TenantUrl('https://fixed.example.com').refresh()).toBe(false);
  });

  it('resolves before the first fetch and keys a lazy bootstrap by partition', async () => {
    const base = await controlPlane();
    const client = tenant({
      url: async () => base,
      partition: 'shop',
      token: 's',
      stream: false,
    });
    expect(client.url).toBeUndefined();
    await client.load();
    expect(client.url).toBe(base);
    expect(client.get('db.host')).toBe('localhost');
    expect(tenantBootstrapKey({ url: async () => base, partition: 'shop' })).toBe(
      tenantBootstrapKey({ url: async () => 'https://other', partition: 'shop' }),
    );
  });

  it('refreshes the url when the old one stops answering, and retries there', async () => {
    const base = await controlPlane();
    let current = 'http://127.0.0.1:9/_config'; // nothing listens on the discard port
    let refreshed = 0;
    const url = Object.assign(async () => current, {
      refresh: async () => {
        refreshed += 1;
        current = base;
        return current;
      },
    });
    const client = tenant({ url, partition: 'shop', token: 's', stream: false });
    await client.load();
    expect(refreshed).toBe(1);
    expect(client.status().source).toBe('remote');
    expect(client.url).toBe(base);
  });

  it('refreshes on a 404 (the control plane moved behind the same host)', async () => {
    const base = await controlPlane();
    let current = `${base}/old`;
    const url = Object.assign(async () => current, {
      refresh: async () => {
        current = base;
        return current;
      },
    });
    const client = tenant({ url, partition: 'shop', token: 's', stream: false });
    await client.load();
    expect(client.get('db.host')).toBe('localhost');
  });

  it('a lazy url that never resolves leaves the app on its local configuration', async () => {
    const client = tenant({
      url: async () => {
        throw new Error('discovery down');
      },
      partition: 'shop',
      token: 's',
      stream: false,
      logger: { info: () => {}, warn: () => {} },
    });
    await client.load();
    expect(client.status()).toMatchObject({ source: 'none', lastError: 'discovery down' });
  });
});

describe('per-viewer apps grant', () => {
  it('normalizes the grant fail-closed', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: ['shop', 'shop', ''] })).toEqual({
      allowed: true,
      apps: ['shop'],
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: 'shop' })).toEqual({
      allowed: true,
      apps: [],
    });
  });

  it('dev tools only see and act on granted apps', async () => {
    const store = new MemoryStore();
    await seedConfig(store, testScope, [['db.host', 'localhost']]);
    await seedConfig(store, { ...testScope, app: 'billing' }, [['db.host', 'billing-db']]);
    const tools = configDevTools(new ConfigAdmin({ store }), {
      actorFor: () => 'mcp:t',
      appAllowed: (_ctx, app) => app === 'shop',
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const call = {
      ctx: {} as never,
      caller: { id: 't', via: 'token' as const },
      limits: { maxRows: 100, maxBytes: 48_000 },
    };
    expect(((await tool('config_list_scopes').run({}, call)) as { apps: string[] }).apps).toEqual([
      'shop',
    ]);
    await expect(tool('config_list_entries').run({ app: 'billing' }, call)).rejects.toThrow(
      /not granted/,
    );
    await expect(
      tool('config_set_entry').run({ app: 'billing', key: 'x', value: '1' }, call),
    ).rejects.toThrow(/not granted/);
    await expect(tool('config_list_entries').run({ app: 'shop' }, call)).resolves.toBeDefined();
  });
});
