import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { browserKeyOf, signBrowserToken, verifyBrowserToken } from '../../src/browser_token.js';
import { defineConfig } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import type { ConfigStore } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { createTenantClient, type TenantClient } from '../../src/topology/tenant_client.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

const SECRET = 'a-control-plane-secret-of-32-chars!';
const servers: Server[] = [];
const planes: ControlPlane[] = [];
const clients: TenantClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const plane of planes.splice(0)) plane.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function start(store: ConfigStore, browser = true) {
  const plane = new ControlPlane({
    store,
    verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    environment: 'production',
    ...(browser
      ? { browser: { secret: SECRET, corsOrigins: ['https://shop.test'] }, prefix: '/_config' }
      : {}),
  });
  planes.push(plane);
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  plane.register({
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
    route(pattern: string, methods: string[], handler: Handler) {
      for (const method of methods) routes.push({ method, pattern, handler });
      return {};
    },
  } as never);
  const server = await serve(routes);
  servers.push(server);
  const url = `${addressOf(server)}/_config`;
  const client = createTenantClient({
    url,
    partition: 'shop',
    token: 'shop-secret',
    stream: false,
    intervalMs: 60_000,
    environment: 'production',
  });
  clients.push(client);
  return { plane, url, client };
}

describe('browser tokens', () => {
  it('verify for their own scope only, and expire', () => {
    const key = { key: browserKeyOf(SECRET, testScope), ...testScope };
    const { token } = signBrowserToken(
      { key: key.key, app: key.app, environment: key.environment, label: key.label },
      { keys: ['site.*', '*'] },
    );
    expect(verifyBrowserToken(token, SECRET)).toMatchObject({ scope: testScope, keys: ['site.*'] });
    expect(verifyBrowserToken(token, 'another-secret-of-32-characters!!!')).toBeNull();

    // A key derived for another app cannot sign for this one.
    const other = browserKeyOf(SECRET, { ...testScope, app: 'other' });
    const forged = signBrowserToken({
      key: other,
      ...testScope,
      environment: testScope.environment,
    });
    expect(verifyBrowserToken(forged.token, SECRET)).toBeNull();

    const expired = signBrowserToken(
      { key: key.key, app: key.app, environment: key.environment, label: key.label },
      { ttlSeconds: -1 },
    );
    expect(verifyBrowserToken(expired.token, SECRET)).toBeNull();
    expect(verifyBrowserToken('v1.garbage.sig', SECRET)).toBeNull();
  });
});

describe('the control plane browser API', () => {
  it('gives a tenant its key, and serves marked and listed values to its token', async () => {
    const store = memoryConfig();
    await seedConfig(store, { ...testScope, app: 'shop', environment: 'production' }, [
      { key: 'site.banner', value: 'hi', browser: true },
      ['support.email', 'help@shop.test'],
      ['db.host', 'db.internal'],
      { key: 'support.token', value: 'sk', secret: true },
    ]);
    const { url, client } = await start(store);
    const key = await client.browserKey();
    expect(key).toMatchObject({ app: 'shop', environment: 'production', label: 'main' });

    const { token } = signBrowserToken(key, { keys: ['support.*'] });
    const response = await fetch(`${url}/v1/browser/values`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://shop.test' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://shop.test');
    expect(await response.json()).toEqual({
      version: 1,
      values: { 'site.banner': 'hi', 'support.email': 'help@shop.test' },
    });

    const refused = await fetch(`${url}/v1/browser/values`, {
      headers: { authorization: 'Bearer v1.nope.nope', origin: 'https://evil.test' },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('streams a change only to the pages whose values changed', async () => {
    const store = memoryConfig();
    const scope = { ...testScope, app: 'shop', environment: 'production' };
    await seedConfig(store, scope, [
      { key: 'site.banner', value: 'old', browser: true },
      ['db.host', 'db-1'],
    ]);
    const { plane, url, client } = await start(store);
    const { token } = signBrowserToken(await client.browserKey());
    const response = await fetch(`${url}/v1/browser/stream?token=${token}`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const events: string[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(decoder.decode(value));
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A key the page does not read: nothing.
    const db = await store.write(scope, [{ key: 'db.host', value: 'db-2' }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    plane.bus.publish(scope, db.document.version);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.join('')).not.toContain('event: config');

    const banner = await store.write(scope, [{ key: 'site.banner', value: 'new' }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    plane.bus.publish(scope, banner.document.version);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.join('')).toContain(
      `event: config\ndata: {"version":${banner.document.version}}`,
    );
    await reader.cancel();
    await reading.catch(() => {});
  });

  it('does not exist without `browser` on the control plane', async () => {
    const { client } = await start(memoryConfig(), false);
    await expect(client.browserKey()).rejects.toThrow(/does not serve browsers/);
  });

  it('validates `browser` on both sides', () => {
    const tenant = (browser: unknown) =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://config.test/_config', partition: 'shop', token: 'secret' },
        browser,
      } as never);
    expect(() => tenant({ direct: { publicUrl: 'https://hub.test/_config' } })).not.toThrow();
    expect(() => tenant({ direct: { publicUrl: 'hub.test' } })).toThrow(/publicUrl/);
    expect(() => tenant({ direct: { tokenRoute: 'token' } })).toThrow(/tokenRoute/);
    const plane = (browser: unknown) =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant: () => null,
        browser,
      } as never);
    expect(() => plane({ corsOrigins: ['https://shop.test'] })).not.toThrow();
    expect(() => plane({ corsOrigins: ['https://shop.test/path'] })).toThrow(/corsOrigins/);
    expect(() => plane({})).toThrow(/corsOrigins/);
  });
});
