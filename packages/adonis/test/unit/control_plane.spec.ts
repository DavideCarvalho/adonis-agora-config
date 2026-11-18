import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import {
  ControlPlane,
  type ControlPlaneOptions,
  configCsrfExceptions,
  resetKnownTenants,
} from '../../src/http/control_plane.js';
import type { ConfigStore } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { sharedSecretVerifier, type TenantVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];

afterEach(async () => {
  resetKnownTenants();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function router(routes: Route[]) {
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
    route(pattern: string, methods: string[], handler: Handler) {
      for (const method of methods) routes.push({ method, pattern, handler });
      return {};
    },
  };
}

async function start(
  store: ConfigStore,
  verifyTenant: TenantVerifier,
  options: Partial<ControlPlaneOptions> = {},
) {
  const controlPlane = new ControlPlane({
    store,
    verifyTenant,
    environment: 'production',
    ...options,
  });
  const routes: Route[] = [];
  controlPlane.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { controlPlane, base: `${addressOf(server)}/_config` };
}

const auth = (token: string, headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...headers,
});

describe('control plane', () => {
  it('refuses a missing or wrong token, and a token without config:read', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [['db.host', 'localhost']]);
    const verifyTenant = sharedSecretVerifier({
      partitions: {
        shop: 'shop-secret',
        noRead: { secret: 'no-read', capabilities: [] },
      },
    });
    const { base } = await start(store, verifyTenant);

    expect((await fetch(`${base}/v1/config`)).status).toBe(401);
    expect((await fetch(`${base}/v1/config`, { headers: auth('nope') })).status).toBe(401);
    const noRead = await fetch(`${base}/v1/config`, {
      headers: { ...auth('no-read'), 'x-config-app': 'noRead' },
    });
    expect(noRead.status).toBe(403);
    expect(await noRead.json()).toEqual({ error: 'token lacks the config:read capability' });
  });

  it('serves the token scope with an ETag and answers 304', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      ['db.host', 'localhost'],
      ['checkout.timeoutMs', 3000],
    ]);
    const { base } = await start(store, sharedSecretVerifier({ partitions: { shop: 's' } }));

    const response = await fetch(`${base}/v1/config`, {
      headers: { ...auth('s'), 'x-config-app': 'shop' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"shop:production:main:1"');
    expect(response.headers.get('x-config-version')).toBe('1');
    const body = await response.json();
    expect(body).toMatchObject({
      app: 'shop',
      environment: 'production',
      label: 'main',
      version: 1,
    });
    expect(body.entries['db.host']).toMatchObject({ value: 'localhost', masked: false });

    const conditional = await fetch(`${base}/v1/config`, {
      headers: {
        ...auth('s'),
        'x-config-app': 'shop',
        'if-none-match': '"shop:production:main:1"',
      },
    });
    expect(conditional.status).toBe(304);
  });

  it('derives the app from the token, never from the request', async () => {
    const store = memoryConfig();
    await seedConfig(store, { ...testScope, app: 'shop' }, [['who', 'shop']]);
    await seedConfig(store, { ...testScope, app: 'billing' }, [['who', 'billing']]);
    const verifyTenant: TenantVerifier = async ({ token }) =>
      token === 't' ? { partition: 'shop', capabilities: ['config:read'] } : null;
    const { base } = await start(store, verifyTenant);

    const response = await fetch(`${base}/v1/config`, {
      headers: { ...auth('t'), 'x-config-app': 'billing' },
    });
    const body = await response.json();
    expect(body.app).toBe('shop');
    expect(body.entries.who.value).toBe('shop');
  });

  it('masks secrets without config:secrets:read and reveals them with it', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      { key: 'db.password', value: 'hunter2', secret: true },
      { key: 'api.key', vault: 'vault://aws/prod/shop#key', secret: true },
      { key: 'missing.key', vault: 'vault://aws/gone#key', secret: true },
    ]);
    const verifyTenant: TenantVerifier = async ({ token }) => {
      if (token === 'reader') return { partition: 'shop', capabilities: ['config:read'] };
      if (token === 'secrets') {
        return { partition: 'shop', capabilities: ['config:read', 'config:secrets:read'] };
      }
      return null;
    };
    const { base } = await start(store, verifyTenant, {
      vault: async (reference) => (reference.path === 'prod/shop' ? 'from-vault' : undefined),
    });

    const masked = await (await fetch(`${base}/v1/config`, { headers: auth('reader') })).json();
    expect(masked.entries['db.password']).toMatchObject({ masked: true, secret: true });
    expect(masked.entries['db.password'].value).toBeUndefined();
    expect(masked.entries['api.key']).toMatchObject({
      masked: true,
      vault: 'vault://aws/prod/shop#key',
    });

    const revealed = await (await fetch(`${base}/v1/config`, { headers: auth('secrets') })).json();
    expect(revealed.entries['db.password']).toMatchObject({ value: 'hunter2', masked: false });
    expect(revealed.entries['api.key']).toMatchObject({ value: 'from-vault', masked: false });
    // A reference the resolver cannot answer is masked, never served as a wrong value.
    expect(revealed.entries['missing.key']).toMatchObject({ masked: true });
    expect(revealed.entries['missing.key'].value).toBeUndefined();
  });

  it('accepts wildcard capabilities: config:* and * cover reads and secrets', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      ['site.name', 'Shop'],
      { key: 'db.password', value: 'hunter2', secret: true },
    ]);
    const grants: Record<string, string[]> = {
      family: ['config:*'],
      all: ['*'],
      reader: ['config:read'],
      unrelated: ['flags:*'],
    };
    const verifyTenant: TenantVerifier = async ({ token }) =>
      grants[token] ? { partition: 'shop', capabilities: grants[token] } : null;
    const { base } = await start(store, verifyTenant);

    for (const token of ['family', 'all']) {
      const response = await fetch(`${base}/v1/config`, { headers: auth(token) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.entries['site.name'].value).toBe('Shop');
      expect(body.entries['db.password']).toMatchObject({ value: 'hunter2', masked: false });
    }

    // `config:read` alone still reads, with the secret masked: nothing is implied.
    const masked = await (await fetch(`${base}/v1/config`, { headers: auth('reader') })).json();
    expect(masked.entries['site.name'].value).toBe('Shop');
    expect(masked.entries['db.password']).toMatchObject({ masked: true });
    expect(masked.entries['db.password'].value).toBeUndefined();

    const refused = await fetch(`${base}/v1/config`, { headers: auth('unrelated') });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'token lacks the config:read capability' });
  });

  it('whoami says what the token is', async () => {
    const store = memoryConfig();
    const { base } = await start(store, sharedSecretVerifier({ partitions: { shop: 's' } }));
    const response = await fetch(`${base}/v1/whoami`, {
      headers: { ...auth('s'), 'x-config-app': 'shop' },
    });
    expect(await response.json()).toEqual({
      resource: 'urn:agora:config',
      partition: 'shop',
      environment: 'production',
      label: 'main',
      capabilities: ['config:read'],
    });
  });

  it('streams a config event on every change', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [['a', 1]]);
    const { base, controlPlane } = await start(
      store,
      sharedSecretVerifier({ partitions: { shop: 's' } }),
    );

    const controller = new AbortController();
    const response = await fetch(`${base}/v1/config/stream`, {
      headers: { ...auth('s'), 'x-config-app': 'shop' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const first = await reader.read();
    expect(first.value).toContain('event: config');

    // A write through the same admin the console/CLI/MCP use publishes on the bus.
    const admin = new ConfigAdmin({
      store,
      onChange: (scope, version) => controlPlane.bus.publish(scope, version),
    });
    await admin.setEntry(testScope, 'a', { value: 2 }, { actor: 'tester' });
    const second = await reader.read();
    expect(second.value).toContain('"version":2');
    controller.abort();
  });

  it('answers CORS preflight for allowed origins only', async () => {
    const store = memoryConfig();
    const { base } = await start(store, sharedSecretVerifier({ partitions: { shop: 's' } }), {
      corsOrigins: ['https://app.test'],
    });
    const allowed = await fetch(`${base}/v1/config`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.test' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.test');
    const denied = await fetch(`${base}/v1/config`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('configCsrfExceptions', () => {
  it('exempts only the tenant API', () => {
    expect(configCsrfExceptions('/_config/v1/config?label=main')).toBe(true);
    expect(configCsrfExceptions('/_config/v1/config/stream')).toBe(true);
    expect(configCsrfExceptions('/_config/api/entries')).toBe(false);
    expect(configCsrfExceptions('/flags', { prefix: '/flags' })).toBe(false);
    expect(configCsrfExceptions('/config/v1/config', { prefix: '/config' })).toBe(true);
  });
});
