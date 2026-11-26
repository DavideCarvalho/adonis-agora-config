import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConfigConfig, defineConfig, stores } from '../../src/define_config.js';

const apps: ApplicationService[] = [];
const dirs: string[] = [];
const env = { ...process.env };

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.terminate();
    } catch {
      // best effort
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env = { ...env };
});

function root(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-console-'));
  dirs.push(dir);
  return new URL(`file://${dir}/`);
}

/** A real AdonisJS app: the core providers plus the config provider, no shortcuts. */
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

function standalone(consoleConfig: unknown = {}): ConfigConfig {
  return defineConfig({
    topology: 'standalone',
    environment: 'production',
    store: stores.memory(),
    crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
    console: consoleConfig as never,
  }) as ConfigConfig;
}

interface RouterLike {
  match(uri: string, method: string): unknown;
}

/** Boots the HTTP server, which is when AdonisJS commits the routes (and detects duplicates). */
async function commitRoutes(app: ApplicationService): Promise<RouterLike> {
  const server = (await app.container.make('server' as never)) as { boot(): Promise<void> };
  await server.boot();
  return (await app.container.make('router' as never)) as RouterLike;
}

describe('console routes on a real Adonis app', () => {
  it('boots with the console mounted once and answers with and without the trailing slash', async () => {
    const app = await boot(standalone());
    const router = await commitRoutes(app);
    expect(router.match('/_config', 'GET')).not.toBeNull();
    expect(router.match('/_config/', 'GET')).not.toBeNull();
    // The API routes are untouched.
    expect(router.match('/_config/api/meta', 'GET')).not.toBeNull();
  });

  it('mounts a custom path once, with and without the trailing slash', async () => {
    const app = await boot(standalone({ path: '/settings' }));
    const router = await commitRoutes(app);
    expect(router.match('/settings', 'GET')).not.toBeNull();
    expect(router.match('/settings/', 'GET')).not.toBeNull();
    expect(router.match('/settings/api/meta', 'GET')).not.toBeNull();
  });

  it('mounts the console at the root path without duplicating "/"', async () => {
    const app = await boot(standalone({ path: '' }));
    const router = await commitRoutes(app);
    expect(router.match('/', 'GET')).not.toBeNull();
    expect(router.match('/api/meta', 'GET')).not.toBeNull();
  });
});

describe('federated console commands fail closed', () => {
  it('a web process with consoleCommands and no secret refuses to start, naming the option', async () => {
    const app = await boot({
      ...standalone(),
      app: 'et',
      consoleCommands: { prefix: 'et', actions: true },
    } as ConfigConfig);
    await expect(app.start(async () => {})).rejects.toThrow(/consoleCommands\.secret/);
  });

  it('a web console whose federated app may act needs controlPlane.secret', async () => {
    const config = standalone({
      federatedApps: { et: { store: { connection: 'et' }, controlPlane: { prefix: 'et' } } },
    });
    await expect(boot(config)).rejects.toThrow(/controlPlane\.secret/);
  });
});
