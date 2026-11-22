import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { browserChannel, browserValues, changesBrowser, isBrowserKey } from '../../src/browser.js';
import { defineConfig } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import type { ConfigStore } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { createTenantClient, type TenantClient } from '../../src/topology/tenant_client.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

const servers: Server[] = [];
const clients: TenantClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function tenantOf(store: ConfigStore): Promise<TenantClient> {
  const controlPlane = new ControlPlane({
    store,
    // The tenant may read secrets, so the test proves `browser` filters them, not the server.
    verifyTenant: sharedSecretVerifier({
      partitions: {
        shop: { secret: 'shop-secret', capabilities: ['config:read', 'config:secrets:read'] },
      },
    }),
    environment: 'production',
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  controlPlane.register({
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
  });
  const server = await serve(routes);
  servers.push(server);
  const client = createTenantClient({
    url: `${addressOf(server)}/_config`,
    partition: 'shop',
    token: 'shop-secret',
    stream: false,
    intervalMs: 60_000,
  });
  clients.push(client);
  await client.start();
  return client;
}

const tenant = (browser: unknown) =>
  defineConfig({
    topology: 'tenant',
    tenant: { url: 'https://config.test/_config', partition: 'shop', token: 'secret' },
    browser,
  } as never);

describe('browser config', () => {
  it('matches exact keys and prefixes', () => {
    expect(isBrowserKey(['site.banner', 'support.*'], 'site.banner')).toBe(true);
    expect(isBrowserKey(['site.banner', 'support.*'], 'site.bannerColor')).toBe(false);
    expect(isBrowserKey(['site.banner', 'support.*'], 'support.email')).toBe(true);
    expect(isBrowserKey(['site.banner', 'support.*'], 'db.host')).toBe(false);
  });

  it('serves the listed keys only, and never a secret even when listed', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      ['site.banner', 'Manutenção às 22h'],
      ['support.email', 'ajuda@example.com'],
      ['db.host', 'db.internal'],
      { key: 'support.token', value: 'sk_live', secret: true },
    ]);
    const client = await tenantOf(store);
    // The tenant itself reads the secret: the filter is the browser's.
    expect(client.get('support.token')).toBe('sk_live');
    expect(browserValues(client, ['site.banner', 'support.*'])).toEqual({
      'site.banner': 'Manutenção às 22h',
      'support.email': 'ajuda@example.com',
    });
    expect(browserValues(client, [])).toEqual({});
  });

  it('follows a hot-reloaded key, and reports only changes the browser can see', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      { key: 'site.banner', value: 'old', reloadable: true },
      { key: 'site.title', value: 'Shop' },
      { key: 'checkout.timeoutMs', value: 3000, reloadable: true },
    ]);
    const client = await tenantOf(store);
    const seen: boolean[] = [];
    client.onChange((change) => seen.push(changesBrowser(change, ['site.*'])));

    await store.write(testScope, [{ key: 'site.banner', value: 'new' }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    await client.refresh();
    expect(browserValues(client, ['site.*'])).toEqual({
      'site.banner': 'new',
      'site.title': 'Shop',
    });

    // A boot-time key keeps its value in this process: nothing new for the browser.
    await store.write(testScope, [{ key: 'site.title', value: 'Loja' }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    await client.refresh();
    expect(browserValues(client, ['site.*'])['site.title']).toBe('Shop');

    // A key the browser does not read.
    await store.write(testScope, [{ key: 'checkout.timeoutMs', value: 5000 }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    await client.refresh();

    expect(seen).toEqual([true, false, false]);
  });

  it('resolves the realtime channel', () => {
    expect(browserChannel(undefined)).toBeUndefined();
    expect(browserChannel({ keys: ['a'] })).toBeUndefined();
    expect(browserChannel({ keys: ['a'], realtime: true })).toBe('config/browser');
    expect(browserChannel({ keys: ['a'], realtime: { channel: 'shop/config' } })).toBe(
      'shop/config',
    );
  });

  it('refuses a browser block that cannot work', () => {
    expect(() => tenant({ keys: ['site.banner'], realtime: true, route: '/c' })).not.toThrow();
    expect(() => tenant({ keys: '*' })).toThrow(/browser\.keys must be a list/);
    expect(() => tenant({ keys: ['*'] })).toThrow(/cannot be `\*`/);
    expect(() => tenant({ keys: ['a'], route: 'config.json' })).toThrow(/starting with `\/`/);
    expect(() =>
      defineConfig({ topology: 'standalone', browser: { keys: ['a'] } } as never),
    ).toThrow(/only applies to topology "tenant"/);
  });

  it('serves an entry marked browser on the control plane, without any pattern', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      { key: 'site.banner', value: 'hi', browser: true, reloadable: true },
      ['site.title', 'Shop'],
    ]);
    const client = await tenantOf(store);
    expect(browserValues(client, [])).toEqual({ 'site.banner': 'hi' });

    // Unmarking is a change the browser sees (its value disappears).
    const seen: boolean[] = [];
    client.onChange((change) =>
      seen.push(changesBrowser(change, [], (key) => key === 'site.banner')),
    );
    await store.write(testScope, [{ key: 'site.banner', value: 'hi', browser: false }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    await client.refresh();
    expect(browserValues(client, [])).toEqual({});
    expect(seen).toEqual([true]);
  });

  it('refuses to mark a secret, a vault reference or a sealed entry', async () => {
    const store = memoryConfig();
    const now = new Date().toISOString();
    await expect(
      store.write(testScope, [{ key: 'stripe.key', value: 'sk', secret: true, browser: true }], {
        actor: 'ann',
        now,
      }),
    ).rejects.toThrow(/cannot be sent to the browser/);
    await expect(
      store.write(testScope, [{ key: 'db.pass', vault: 'vault://aws/db#pass', browser: true }], {
        actor: 'ann',
        now,
      }),
    ).rejects.toThrow(/cannot be sent to the browser/);
    // Turning a marked entry into a secret is refused too: unmark first.
    await store.write(testScope, [{ key: 'site.token', value: 't', browser: true }], {
      actor: 'ann',
      now,
    });
    await expect(
      store.write(testScope, [{ key: 'site.token', value: 't', secret: true }], {
        actor: 'ann',
        now,
      }),
    ).rejects.toThrow(/unmark browser first/);
  });

  it('keeps the fingerprint of an unmarked document, and changes it when marking', async () => {
    const store = memoryConfig();
    const now = new Date().toISOString();
    const first = await store.write(testScope, [{ key: 'a', value: 1 }], { actor: 'ann', now });
    const same = await store.write(testScope, [{ key: 'a', value: 1, browser: false }], {
      actor: 'ann',
      now,
    });
    expect(same.changed).toBe(false);
    const marked = await store.write(testScope, [{ key: 'a', value: 1, browser: true }], {
      actor: 'ann',
      now,
    });
    expect(marked.changed).toBe(true);
    expect(marked.document.fingerprint).not.toBe(first.document.fingerprint);
    expect(marked.document.entries.a?.browser).toBe(true);
  });
});
