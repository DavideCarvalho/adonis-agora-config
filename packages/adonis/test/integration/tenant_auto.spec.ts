import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { type ConfigConfig, defineConfig } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/checks.js';
import { ControlPlane, resetKnownTenants } from '../../src/http/control_plane.js';
import { memoryConfig } from '../../src/testing/index.js';
import {
  type AuthkitTenantLike,
  resolveTenantFields,
  TenantFieldsError,
} from '../../src/topology/tenant_auto.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

const apps: ApplicationService[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

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
});

const ERROR_TAIL =
  "Configure @adonis-agora/authkit-client's `service` (config/authkit_client.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/config.ts.";

/** A control plane serving `db.host` to the `shop` partition, behind a shared secret. */
async function controlPlane(): Promise<string> {
  const store = memoryConfig();
  const plane = new ControlPlane({
    store,
    verifyTenant: sharedSecretVerifier({
      partitions: { shop: { secret: 'shop-secret', capabilities: ['config:read'] } },
    }),
    environment: 'production',
  });
  await new ConfigAdmin({ store }).setEntry(
    { app: 'shop', environment: 'production', label: 'main' },
    'db.host',
    { value: 'db-1' },
    { actor: 'test' },
  );
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
  return `${addressOf(server)}/_config`;
}

/** What authkit-client's `tenantOf` hands out, recording the resources asked for. */
function fakeTenantOf(base: string, partition = 'shop') {
  const calls: string[] = [];
  const counters = { refresh: 0, reset: 0 };
  const tenantOf = (resource: string): AuthkitTenantLike => {
    calls.push(resource);
    const url = Object.assign(async () => base, {
      refresh: async () => {
        counters.refresh += 1;
        return base;
      },
    });
    const token = Object.assign(async () => 'shop-secret', {
      reset: () => {
        counters.reset += 1;
      },
    });
    return { url, token, partition };
  };
  return { tenantOf, calls, counters };
}

/** Binds `authkit.client` like authkit-client's provider does (any object; only its shape counts). */
function authkitProvider(client: unknown) {
  return class FakeAuthkitProvider {
    constructor(protected app: ApplicationService) {}
    register() {
      this.app.container.singleton('authkit.client' as never, () => client as never);
    }
  };
}

async function boot(
  config: ConfigConfig,
  options: { authkit?: unknown; environment?: 'web' | 'console' } = {},
): Promise<ApplicationService> {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-auto-'));
  dirs.push(dir);
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          ...(options.authkit !== undefined
            ? [async () => ({ default: authkitProvider(options.authkit) as never })]
            : []),
          () => import('../../providers/config_provider.js'),
        ],
      },
      config: { config },
    })
    .create(new URL(`file://${dir}/`));
  const app = ignitor.createApp(options.environment ?? 'web');
  apps.push(app);
  await app.init();
  await app.boot();
  return app;
}

async function runtimeOf(app: ApplicationService) {
  return (await app.container.make('agora.config' as never)) as {
    app: string;
    get(key: string): unknown;
  };
}

function check(id: string) {
  const found = agoraDoctorChecks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe('tenant url, token and partition from authkit-client', () => {
  it('fills all three from a fake authkit.client binding: defineConfig({ topology: tenant }) is enough', {
    timeout: 20_000,
  }, async () => {
    const base = await controlPlane();
    const fake = fakeTenantOf(base);
    const app = await boot(defineConfig({ topology: 'tenant' }) as ConfigConfig, {
      authkit: { tenantOf: fake.tenantOf },
    });
    const runtime = await runtimeOf(app);
    expect(runtime.app).toBe('shop');
    expect(runtime.get('db.host')).toBe('db-1');
    expect(fake.calls).toContain('urn:agora:config');
    expect(await check('config.tenant-source').run(app)).toEqual({
      status: 'ok',
      message:
        'tenant url: authkit-client (auto), token: authkit-client (auto), partition: authkit-client (auto).',
    });
    expect(await check('config.token').run(app)).toMatchObject({ status: 'ok' });
  });

  it('lets each explicit field win over the discovered one', async () => {
    const base = await controlPlane();
    // authkit-client would say `other` with the wrong URL: explicit partition and url win.
    const fake = fakeTenantOf('http://127.0.0.1:1/_config', 'other');
    const app = await boot(
      defineConfig({
        topology: 'tenant',
        tenant: { url: base, partition: 'shop', stream: false, keyPath: false },
      }) as ConfigConfig,
      { authkit: { tenantOf: fake.tenantOf } },
    );
    const runtime = await runtimeOf(app);
    expect(runtime.app).toBe('shop');
    expect(runtime.get('db.host')).toBe('db-1');
    expect(await check('config.tenant-source').run(app)).toMatchObject({
      status: 'ok',
      message: 'tenant url: explicit, token: authkit-client (auto), partition: explicit.',
    });
  });

  it('never calls tenantOf when every field is explicit (authkit-client for login only)', async () => {
    let called = false;
    const fields = await resolveTenantFields(
      {
        hasBinding: () => true,
        make: async () => ({
          tenantOf: () => {
            called = true;
            throw new Error('no service');
          },
        }),
      },
      { url: 'https://c.test/_config', token: 's', partition: 'shop' },
    );
    expect(called).toBe(false);
    expect(fields.missing).toEqual([]);
  });

  it('refuses to boot a web process without the binding, naming the fields and both fixes', async () => {
    await expect(boot(defineConfig({ topology: 'tenant' }) as ConfigConfig)).rejects.toThrow(
      `[@adonis-agora/config] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. ${ERROR_TAIL}`,
    );
    await expect(
      boot(defineConfig({ topology: 'tenant', tenant: { partition: 'shop' } }) as ConfigConfig),
    ).rejects.toThrow(
      `[@adonis-agora/config] topology 'tenant' needs tenant.url, tenant.token. ${ERROR_TAIL}`,
    );
  });

  it('only warns in `node ace`; agora.config throws when used and the doctor names the fix', async () => {
    const app = await boot(defineConfig({ topology: 'tenant' }) as ConfigConfig, {
      environment: 'console',
    });
    await expect(runtimeOf(app)).rejects.toBeInstanceOf(TenantFieldsError);
    expect(await check('config.tenant-source').run(app)).toMatchObject({
      status: 'error',
      message: 'tenant url: missing, token: missing, partition: missing.',
      fix: expect.stringContaining(ERROR_TAIL),
    });
    expect(await check('config.reachable').run(app)).toMatchObject({ status: 'error' });
  });

  it('treats an authkit-client without tenantOf (older release) as absent', async () => {
    const older = { appCallTokens: () => undefined, appKey: async () => null };
    await expect(
      boot(defineConfig({ topology: 'tenant' }) as ConfigConfig, { authkit: older }),
    ).rejects.toThrow(`needs tenant.url, tenant.token, tenant.partition. ${ERROR_TAIL}`);
  });

  it('treats a throwing tenantOf (no `service`) as absent and carries its message', async () => {
    const authkit = {
      tenantOf: () => {
        throw Object.assign(
          new Error('authkit-client: tenantOf() needs `service` in config/authkit_client.ts'),
          { code: 'E_AUTHKIT_SERVICE_NOT_CONFIGURED' },
        );
      },
    };
    await expect(
      boot(defineConfig({ topology: 'tenant' }) as ConfigConfig, { authkit }),
    ).rejects.toThrow(
      `needs tenant.url, tenant.token, tenant.partition (authkit-client: authkit-client: tenantOf() needs \`service\` in config/authkit_client.ts). ${ERROR_TAIL}`,
    );
    // An explicit tenant is unaffected by an authkit-client without `service`.
    const fields = await resolveTenantFields(
      { hasBinding: () => true, make: async () => authkit },
      { url: 'https://c.test/_config', token: 's', partition: 'shop' },
    );
    expect(fields.missing).toEqual([]);
  });

  it('ignores the binding with tenant.auto: false', async () => {
    const fake = fakeTenantOf('https://c.test/_config');
    const fields = await resolveTenantFields(
      { hasBinding: () => true, make: async () => ({ tenantOf: fake.tenantOf }) },
      { partition: 'shop', auto: false },
    );
    expect(fake.calls).toEqual([]);
    expect(fields.missing).toEqual(['url', 'token']);
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { partition: 'shop', auto: false } }),
    ).toThrow(/tenant.url is required/);
  });

  it('hands the discovered url refresh() and token reset() to the tenant client', async () => {
    const fake = fakeTenantOf('https://c.test/_config');
    const fields = await resolveTenantFields(
      { hasBinding: () => true, make: async () => ({ tenantOf: fake.tenantOf }) },
      {},
    );
    const { TenantUrl } = await import('../../src/topology/tenant_url.js');
    const { resolveTenantToken } = await import('../../src/topology/token.js');
    await new TenantUrl(fields.url!).refresh();
    resolveTenantToken(fields.token!).reset?.();
    expect(fake.counters).toEqual({ refresh: 1, reset: 1 });
  });
});
