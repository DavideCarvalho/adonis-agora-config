import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import {
  type ConfigConfig,
  defineConfig,
  stores,
  type TenantTopologyConfig,
} from '../../src/define_config.js';
import { resetKnownTenants } from '../../src/http/control_plane.js';
import { sharedSecretVerifier, type TenantVerifier } from '../../src/topology/verify.js';
import { transports } from '../../src/transports/index.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const apps: ApplicationService[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
const env = { ...process.env };

afterEach(async () => {
  resetKnownTenants();
  for (const app of apps.splice(0)) {
    try {
      await app.terminate();
    } catch {
      // best effort
    }
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env = { ...env };
});

function root(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-transport-'));
  dirs.push(dir);
  return new URL(`file://${dir}/`);
}

async function boot(config: ConfigConfig): Promise<ApplicationService> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../../providers/config_provider.js')] },
      config: { config },
    })
    .create(root());
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  apps.push(app);
  return app;
}

async function serveControlPlane(controlPlane: { register(router: never): void }) {
  const routes: Route[] = [];
  controlPlane.register({
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
  return `${addressOf(server)}/_config`;
}

async function waitFor(label: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** A pub/sub + key/value Redis stand-in; enough for the watch/snapshot contract. */
class FakeRedis {
  readonly published: Array<{ channel: string; message: string }> = [];
  readonly values = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    for (const listener of this.#listeners.get(channel) ?? []) listener(message);
    return 1;
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<number> {
    const set = this.#listeners.get(channel) ?? new Set();
    set.add(handler);
    this.#listeners.set(channel, set);
    return 1;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
}

/** A durable control plane stand-in: fan-out to the handlers registered by the tenant. */
class FakeDurableControlPlane {
  readonly published: unknown[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();

  async publishControl(message: unknown): Promise<void> {
    this.published.push(message);
    for (const listener of this.#listeners) listener(message);
  }

  onControl(handler: (message: unknown) => void): void {
    this.#listeners.add(handler);
  }
}

const verifyTenant: TenantVerifier = sharedSecretVerifier({
  partitions: {
    shop: {
      secret: 'shop-secret',
      capabilities: ['config:read', 'config:secrets:read'],
    },
  },
});

function controlPlaneConfig(transport?: unknown): ConfigConfig {
  return defineConfig({
    topology: 'control-plane',
    environment: 'production',
    verifyTenant,
    store: stores.memory(),
    crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
    console: false,
    ...(transport ? { transport: transport as never } : {}),
  }) as ConfigConfig;
}

function tenantConfig(url: string, transport?: unknown): ConfigConfig {
  return defineConfig({
    topology: 'tenant',
    tenant: {
      url,
      partition: 'shop',
      token: 'shop-secret',
      environment: 'production',
      stream: true,
      intervalMs: 60_000,
      keyPath: false,
      ...(transport ? { transport: transport as never } : {}),
    },
  }) as TenantTopologyConfig;
}

async function tenantRuntime(app: ApplicationService) {
  return (await app.container.make('agora.config')) as {
    get(key: string, fallback?: unknown): unknown;
    status(): { source: string };
  };
}

async function setup(
  transport: unknown,
  token = 'shop-secret',
): Promise<{
  base: string;
  store: never;
  admin: ConfigAdmin;
  controlPlane: { bus: { publish(scope: never, version: number): void } };
}> {
  const controlApp = await boot(controlPlaneConfig(transport));
  const runtime = (await controlApp.container.make('agora.config')) as {
    store: never;
    controlPlane: { bus: { publish(scope: never, version: number): void } };
  };
  const base = await serveControlPlane(runtime.controlPlane);
  const built = await (transport as (ctx: unknown) => Promise<unknown>)({ app: controlApp });
  const admin = new ConfigAdmin({
    store: runtime.store,
    transport: built as never,
    onChange: (scope, version) => runtime.controlPlane.bus.publish(scope as never, version),
  });
  void token;
  return { base, store: runtime.store, admin, controlPlane: runtime.controlPlane };
}

describe('tenant transports', () => {
  it('uses transports.http with a custom fetch and URL', { timeout: 20_000 }, async () => {
    const { base, admin } = await setup(transports.http());
    const scope = { app: 'shop', environment: 'production', label: 'main' };
    await admin.setEntry(scope, 'db.host', { value: 'db-http' }, { actor: 't' });
    let calls = 0;
    const tenant = await boot(
      tenantConfig(
        'http://127.0.0.1:1/_config',
        transports.http({
          url: base,
          fetch: (input, init) => {
            calls += 1;
            return fetch(input, init);
          },
        }),
      ),
    );
    const runtime = await tenantRuntime(tenant);
    await waitFor('http transport fetch', () => runtime.get('db.host') === 'db-http');
    expect(calls).toBeGreaterThan(0);
  });

  it('mixes a redis tenant and an http tenant, and keeps the HTTP API for browsers', {
    timeout: 30_000,
  }, async () => {
    const redis = new FakeRedis();
    const { base, admin } = await setup(transports.redis({ client: redis as never }));
    const scope = { app: 'shop', environment: 'production', label: 'main' };
    await admin.setEntry(scope, 'feature.flag', { value: 'off', reloadable: true }, { actor: 't' });

    const httpTenant = await boot(tenantConfig(base));
    const redisTenant = await boot(
      tenantConfig(base, transports.redis({ client: redis as never })),
    );
    const httpRuntime = await tenantRuntime(httpTenant);
    const redisRuntime = await tenantRuntime(redisTenant);
    await waitFor('http tenant boot', () => httpRuntime.get('feature.flag') === 'off');
    await waitFor('redis tenant boot', () => redisRuntime.get('feature.flag') === 'off');

    await admin.setEntry(scope, 'feature.flag', { value: 'on' }, { actor: 't' });
    await waitFor('http tenant reload', () => httpRuntime.get('feature.flag') === 'on');
    await waitFor('redis tenant watch', () => redisRuntime.get('feature.flag') === 'on');

    // A browser/console call still uses the control plane's HTTP API, whatever the tenant
    // transport is.
    const browser = await fetch(`${base}/v1/config`, {
      headers: { authorization: 'Bearer shop-secret', 'x-config-app': 'shop' },
    });
    expect(browser.status).toBe(200);
    const unauthorized = await fetch(`${base}/v1/config`, {
      headers: { authorization: 'Bearer wrong', 'x-config-app': 'shop' },
    });
    expect(unauthorized.status).toBe(401);

    // The watch channel and the snapshot never carry a value.
    await admin.setEntry(
      scope,
      'stripe.secret',
      { value: 'sk_live', secret: true },
      { actor: 't' },
    );
    const wire = redis.published.map((entry) => entry.message).join('\n');
    expect(wire).not.toContain('sk_live');
    expect(JSON.stringify([...redis.values.values()])).not.toContain('sk_live');
  });

  it('watches over durable and mixes with an http tenant', { timeout: 30_000 }, async () => {
    const durable = new FakeDurableControlPlane();
    const { base, admin } = await setup(transports.durable({ controlPlane: durable as never }));
    const scope = { app: 'shop', environment: 'production', label: 'main' };
    await admin.setEntry(scope, 'feature.flag', { value: 'off', reloadable: true }, { actor: 't' });

    const httpTenant = await boot(tenantConfig(base));
    const durableTenant = await boot(
      tenantConfig(base, transports.durable({ controlPlane: durable as never })),
    );
    const httpRuntime = await tenantRuntime(httpTenant);
    const durableRuntime = await tenantRuntime(durableTenant);
    await waitFor('http tenant boot', () => httpRuntime.get('feature.flag') === 'off');
    await waitFor('durable tenant boot', () => durableRuntime.get('feature.flag') === 'off');

    await admin.setEntry(scope, 'feature.flag', { value: 'on' }, { actor: 't' });
    await waitFor('http tenant reload', () => httpRuntime.get('feature.flag') === 'on');
    await waitFor('durable tenant watch', () => durableRuntime.get('feature.flag') === 'on');

    const wire = JSON.stringify(durable.published);
    expect(wire).toContain('config.changed');
    expect(wire).not.toContain('sk_live');
  });

  it('boots from the broker snapshot when the control plane is down and there is no local snapshot', {
    timeout: 30_000,
  }, async () => {
    const redis = new FakeRedis();
    const secret = 'snapshot-secret-0123456789';
    const { base, admin } = await setup(transports.redis({ client: redis as never, secret }));
    const scope = { app: 'shop', environment: 'production', label: 'main' };
    await admin.setEntry(scope, 'db.host', { value: 'db-1' }, { actor: 't' });

    const tenant = await boot(
      tenantConfig(
        'http://127.0.0.1:1/_config',
        transports.redis({ client: redis as never, secret }),
      ),
    );
    const runtime = await tenantRuntime(tenant);
    await waitFor('broker snapshot boot', () => runtime.get('db.host') === 'db-1');
    expect(runtime.status().source).toBe('snapshot');
    void base;
  });

  it('never serves a snapshot that is unsigned, forged, or signed for another scope', async () => {
    const redis = new FakeRedis();
    const secret = 'snapshot-secret-0123456789';
    const ctx = {} as never;
    const plane = await transports.redis({ client: redis as never, secret })(ctx);
    const tenant = await transports.redis({ client: redis as never, secret })(ctx);
    const unsigned = await transports.redis({ client: redis as never })(ctx);
    const shop = { app: 'shop', environment: 'production', label: 'main' };
    const other = { app: 'other', environment: 'production', label: 'main' };
    const view = {
      ...shop,
      version: 3,
      fingerprint: 'f',
      entries: { 'db.host': { value: 'db-1', secret: false, reloadable: false, masked: false } },
      createdAt: new Date(0).toISOString(),
      createdBy: 't',
    } as never;

    await plane.publish?.(shop, 3, view);
    expect((await tenant.snapshot?.(shop))?.version).toBe(3);
    // Without the secret a tenant never boots from a snapshot at all.
    expect(await unsigned.snapshot?.(shop)).toBeNull();

    // Someone with Redis write access swaps in their own configuration.
    const key = [...redis.values.keys()].find((k) => k.includes(':shop:'))!;
    const stored = JSON.parse(redis.values.get(key)!);
    stored.snapshot.entries['db.host'].value = 'attacker.example';
    redis.values.set(key, JSON.stringify(stored));
    expect(await tenant.snapshot?.(shop)).toBeNull();

    // A plain (unsigned, pre-upgrade style) snapshot is refused too.
    redis.values.set(key, JSON.stringify(view));
    expect(await tenant.snapshot?.(shop)).toBeNull();

    // A valid snapshot of one scope copied onto another's key does not verify there.
    await plane.publish?.(shop, 4, view);
    const otherKey = key.replace(':shop:', ':other:');
    redis.values.set(otherKey, redis.values.get(key)!);
    expect(await tenant.snapshot?.(other)).toBeNull();
  });
});
