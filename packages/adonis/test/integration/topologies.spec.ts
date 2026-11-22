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
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

const broadcasts: Array<{ channel: string; payload: Record<string, unknown> }> = [];

/**
 * Stands in for `@adonisjs/transmit`'s provider: it binds `transmit` in the container, and
 * `@adonisjs/transmit/services/main` is only filled after boot, so the config provider must read
 * the binding, never that module at boot.
 */
class FakeTransmitProvider {
  constructor(protected app: ApplicationService) {}
  register() {
    this.app.container.singleton('transmit' as never, () => ({
      broadcast: (channel: string, payload: Record<string, unknown>) =>
        broadcasts.push({ channel, payload }),
    }));
  }
}

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
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-int-'));
  dirs.push(dir);
  return new URL(`file://${dir}/`);
}

/** A real AdonisJS app: the core providers plus the config provider, no shortcuts. */
async function boot(
  config: ConfigConfig,
  options: { transmit?: boolean } = {},
): Promise<ApplicationService> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('../../providers/config_provider.js'),
          ...(options.transmit ? [async () => ({ default: FakeTransmitProvider as never })] : []),
        ],
      },
      config: { config },
    })
    .create(root());
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  apps.push(app);
  return app;
}

async function runtimeOf(app: ApplicationService) {
  return (await app.container.make('agora.config')) as {
    topology: string;
    app: string;
    store?: {
      cryptoStatus(): Promise<{ active: number }>;
    };
    controlPlane?: unknown;
    client?: { status(): { streaming: boolean } };
    get(key: string, fallback?: unknown): unknown;
    status(): { source: string; version: number; lastError: string | null };
  };
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

describe('real Adonis apps: standalone and control plane', () => {
  it('boots standalone, writes a secret and reports it through the runtime', {
    timeout: 20_000,
  }, async () => {
    process.env.APP_NAME = 'Integration Standalone';
    const app = await boot(
      defineConfig({
        topology: 'standalone',
        store: stores.memory(),
        crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
        console: false,
      }) as ConfigConfig,
    );
    const runtime = await runtimeOf(app);
    expect(runtime.topology).toBe('standalone');
    // `app` omitted: the provider reads APP_NAME.
    expect(runtime.app).toBe('Integration Standalone');
    expect(runtime.store).toBeDefined();

    const admin = new ConfigAdmin({ store: runtime.store as never });
    await admin.setEntry(
      { app: runtime.app, environment: 'production', label: 'main' },
      'db.host',
      { value: 'localhost' },
      { actor: 'integration' },
    );
    await admin.setEntry(
      { app: runtime.app, environment: 'production', label: 'main' },
      'stripe.secret',
      { value: 'sk_live', secret: true },
      { actor: 'integration' },
    );
    const entry = await admin.getEntry(
      { app: runtime.app, environment: 'production', label: 'main' },
      'stripe.secret',
      { canReadSecrets: true },
    );
    expect(entry?.value).toBe('sk_live');
    expect((await runtime.store!.cryptoStatus()).active).toBeGreaterThan(0);
  });

  it('serves a real control plane and a real tenant app: boot, secret, live reload', {
    timeout: 30_000,
  }, async () => {
    const controlPlaneConfig = defineConfig({
      topology: 'control-plane',
      environment: 'production',
      verifyTenant: sharedSecretVerifier({
        partitions: {
          shop: {
            secret: 'shop-secret',
            capabilities: ['config:read', 'config:secrets:read'],
          },
        },
      }),
      store: stores.memory(),
      crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
      console: false,
    }) as ConfigConfig;
    const controlApp = await boot(controlPlaneConfig);
    const controlRuntime = await runtimeOf(controlApp);
    expect(controlRuntime.topology).toBe('control-plane');
    const controlPlane = controlRuntime.controlPlane as never;
    expect(controlPlane).toBeDefined();
    const base = await serveControlPlane(controlPlane);

    const scope = { app: 'shop', environment: 'production', label: 'main' };
    const admin = new ConfigAdmin({
      store: controlRuntime.store as never,
      onChange: (changed, version) =>
        (controlPlane as { bus: { publish(scope: never, version: number): void } }).bus.publish(
          changed as never,
          version,
        ),
    });
    await admin.setEntry(scope, 'db.host', { value: 'db-1' }, { actor: 'integration' });
    await admin.setEntry(
      scope,
      'stripe.secret',
      { value: 'sk_live', secret: true },
      { actor: 'integration' },
    );
    await admin.setEntry(
      scope,
      'feature.flag',
      { value: 'off', reloadable: true },
      { actor: 'integration' },
    );

    const tenantConfig = defineConfig({
      topology: 'tenant',
      tenant: {
        url: base,
        partition: 'shop',
        token: 'shop-secret',
        environment: 'production',
        stream: true,
        intervalMs: 60_000,
        keyPath: false,
      },
    }) as TenantTopologyConfig;
    const tenantApp = await boot(tenantConfig);
    const tenant = await runtimeOf(tenantApp);
    try {
      await waitFor('the tenant fetch', () => tenant.get('db.host') === 'db-1');
    } catch (error) {
      throw new Error(
        `tenant did not load from ${base}: ${JSON.stringify(tenant.status())} value=${String(tenant.get('db.host'))} cause=${(error as Error).message}`,
      );
    }
    expect(tenant.get('stripe.secret')).toBe('sk_live');
    expect(tenant.status().source).toBe('remote');
    await waitFor('the SSE stream', () => tenant.client?.status().streaming === true, 5000);

    // A reloadable key arrives over SSE; a boot-time key keeps the value this process booted with.
    await admin.setEntry(scope, 'feature.flag', { value: 'on' }, { actor: 'integration' });
    await admin.setEntry(scope, 'db.host', { value: 'db-2' }, { actor: 'integration' });
    await waitFor('the reloadable value', () => tenant.get('feature.flag') === 'on');
    expect(tenant.get('db.host')).toBe('db-1');
  });

  it('serves the browser keys of a real tenant app, and broadcasts their live changes', {
    timeout: 30_000,
  }, async () => {
    broadcasts.length = 0;
    const controlApp = await boot(
      defineConfig({
        topology: 'control-plane',
        environment: 'production',
        verifyTenant: sharedSecretVerifier({
          partitions: {
            shop: { secret: 'shop-secret', capabilities: ['config:read', 'config:secrets:read'] },
          },
        }),
        store: stores.memory(),
        crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
        console: false,
      }) as ConfigConfig,
    );
    const controlRuntime = await runtimeOf(controlApp);
    const controlPlane = controlRuntime.controlPlane as never;
    const base = await serveControlPlane(controlPlane);
    const scope = { app: 'shop', environment: 'production', label: 'main' };
    const admin = new ConfigAdmin({
      store: controlRuntime.store as never,
      onChange: (changed, version) =>
        (controlPlane as { bus: { publish(scope: never, version: number): void } }).bus.publish(
          changed as never,
          version,
        ),
    });
    const actor = { actor: 'integration' };
    await admin.setEntry(scope, 'site.banner', { value: 'old', reloadable: true }, actor);
    await admin.setEntry(scope, 'site.token', { value: 'sk_live', secret: true }, actor);
    await admin.setEntry(scope, 'db.host', { value: 'db-1', reloadable: true }, actor);

    const tenantApp = await boot(
      defineConfig({
        topology: 'tenant',
        tenant: {
          url: base,
          partition: 'shop',
          token: 'shop-secret',
          environment: 'production',
          stream: true,
          intervalMs: 60_000,
          keyPath: false,
        },
        browser: { keys: ['site.*'], realtime: true, route: '/_config/browser' },
      }) as TenantTopologyConfig,
      { transmit: true },
    );
    const tenant = (await runtimeOf(tenantApp)) as Awaited<ReturnType<typeof runtimeOf>> & {
      browser(): Record<string, unknown>;
    };
    await waitFor('the tenant fetch', () => tenant.get('site.banner') === 'old');
    await waitFor('the SSE stream', () => tenant.client?.status().streaming === true, 5000);
    expect(tenant.get('site.token')).toBe('sk_live');
    expect(tenant.browser()).toEqual({ 'site.banner': 'old' });

    const router = (await tenantApp.container.make('router')) as unknown as {
      commit(): void;
      match(url: string, method: string): { route: { handler: unknown } } | null;
    };
    router.commit();
    const matched = router.match('/_config/browser', 'GET');
    expect(matched).not.toBeNull();
    const headers: Record<string, string> = {};
    const handler =
      (matched!.route.handler as { handle?: unknown }).handle ?? matched!.route.handler;
    const body = await (handler as (ctx: unknown) => unknown)({
      response: { header: (name: string, value: string) => (headers[name] = value) },
    });
    expect(body).toMatchObject({ values: { 'site.banner': 'old' } });
    expect(headers['cache-control']).toBe('no-store');

    // A key the browser does not read changes: no broadcast.
    await admin.setEntry(scope, 'db.host', { value: 'db-2' }, actor);
    await waitFor('the db change', () => tenant.get('db.host') === 'db-2');
    expect(broadcasts).toEqual([]);

    await admin.setEntry(scope, 'site.banner', { value: 'new' }, actor);
    await waitFor('the browser broadcast', () => broadcasts.length > 0);
    expect(broadcasts).toEqual([
      { channel: 'config/browser', payload: { version: expect.any(Number) } },
    ]);
    expect(tenant.browser()).toEqual({ 'site.banner': 'new' });
  });
});
