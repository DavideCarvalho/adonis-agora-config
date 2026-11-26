import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drivers, defineConfig as encryptionConfig } from '@adonisjs/core/encryption';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { type ConfigConfig, defineConfig, stores } from '../../src/define_config.js';
import {
  consoleCommandsCheck,
  consoleCommandsKeyCheck,
} from '../../src/doctor/console_commands.js';
import { buildFederatedConfigApp, FederatedAppError } from '../../src/federation/console.js';
import { consoleSiblingsOf } from '../../src/federation/console_auth.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testSecretCodec } from '../../src/testing/index.js';
import { FakeAuthkit, FakeCryptoServer } from '../support/fake_siblings.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * Console-command authentication through the real provider and boot path: an AdonisJS app with the
 * config provider, plus fake `'agora.crypto'` / `'authkit.client'` bindings standing in for the
 * sibling libs, and a fake Redis shared by the apps of one test.
 */

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

const SCOPE = { app: 'shop', environment: 'production', label: 'main' };
const APP_KEY = 'shop-app-key-0123456789abcdef';
const SECRET = 'a-shared-secret-of-16+';

interface BootOptions {
  bindings?: Record<string, unknown>;
  bus?: RedisBus;
  environment?: 'web' | 'console';
  lines?: string[];
  /** More of the app's config (`encryption`, say). */
  config?: Record<string, unknown>;
}

async function boot(config: ConfigConfig, options: BootOptions = {}): Promise<ApplicationService> {
  const dir = mkdtempSync(join(tmpdir(), 'agora-config-auth-'));
  dirs.push(dir);
  const bus = options.bus ?? new RedisBus();
  const lines = options.lines ?? [];
  const bindings: Record<string, unknown> = {
    ...options.bindings,
    redis: { connection: () => bus.connection() },
    logger: {
      info: (line: string) => lines.push(`info ${line}`),
      warn: (line: string) => lines.push(`warn ${line}`),
      error: (line: string) => lines.push(`error ${line}`),
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => bindings.logger,
    },
  };
  class FakeSiblings {
    constructor(protected app: ApplicationService) {}
    register() {
      for (const [name, value] of Object.entries(bindings)) {
        this.app.container.singleton(name as never, async () => value as never);
      }
    }
  }
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('../../providers/config_provider.js'),
          async () => ({ default: FakeSiblings }),
        ],
      },
      config: {
        config,
        redis: { connection: 'main', connections: { main: {} } },
        ...options.config,
      },
    })
    .create(new URL(`file://${dir}/`));
  const app = ignitor.createApp(options.environment ?? 'web');
  apps.push(app);
  await app.init();
  await app.boot();
  await app.start(async () => {});
  return app;
}

/** The owning app: standalone "shop", answering consoleCommands. */
function shop(consoleCommands: Record<string, unknown>, store?: MemoryStore): ConfigConfig {
  return defineConfig({
    topology: 'standalone',
    app: 'shop',
    environment: 'production',
    store: store ? async () => store : stores.memory(),
    crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
    console: false,
    consoleCommands: { prefix: 'shop', actions: true, ...consoleCommands } as never,
  }) as ConfigConfig;
}

/** The Hub: a console that federates "shop" (its store handed in, read-only). */
function hub(entry: Record<string, unknown>, store: MemoryStore): ConfigConfig {
  return defineConfig({
    topology: 'standalone',
    app: 'hub',
    environment: 'production',
    store: stores.memory(),
    crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
    console: {
      federatedApps: {
        shop: { store, controlPlane: { prefix: 'shop' }, timeoutMs: 500, ...entry },
      },
    } as never,
  }) as ConfigConfig;
}

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore({ secretCodec: testSecretCodec('shop') });
  await new ConfigAdmin({ store }).setEntry(SCOPE, 'feature.x', { value: 'on' }, { actor: 'seed' });
  return store;
}

/** The Hub's view of "shop", built with the Hub app's own container (its siblings). */
async function hubView(hubApp: ApplicationService, bus: RedisBus, store: MemoryStore, entry = {}) {
  return buildFederatedConfigApp(
    'shop',
    { store, controlPlane: { prefix: 'shop' }, timeoutMs: 500, ...entry },
    {
      db: async () => {
        throw new Error('unused');
      },
      redis: async () => bus.connection(),
      siblings: await consoleSiblingsOf(hubApp.container),
    },
  );
}

const writer = { actor: 'ana@hub', capabilities: ['config:*'] };

describe('automatic crypto mode (nothing configured)', () => {
  it('Hub with crypto embedded, app a crypto tenant with no grant at all: commands just work', async () => {
    const server = new FakeCryptoServer();
    const bus = new RedisBus();
    const store = await seeded();
    const shopLines: string[] = [];
    await boot(shop({}, store), {
      bus,
      lines: shopLines,
      bindings: { 'agora.crypto': server.tenant('shop', []) },
    });
    expect(shopLines).toContain(
      'info [@adonis-agora/config] console commands: crypto (auto, key console-config); actions on',
    );
    const hubLines: string[] = [];
    const hubApp = await boot(hub({}, store), {
      bus,
      lines: hubLines,
      bindings: { 'agora.crypto': server.embedded('hub') },
    });
    expect(hubLines).toContain(
      'info [@adonis-agora/config] console commands to "shop": crypto (auto, key console-config, partition shop)',
    );

    const view = await hubView(hubApp, bus, store);
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect((await store.read(SCOPE))?.entries['feature.x']).toBeUndefined();
    // The Hub created the key in shop's partition, encrypted there; shop decrypted with its own.
    expect(server.audit.map((a) => `${a.op}:${a.partition}:${a.key}:${a.actor}`)).toEqual([
      'create:shop:console-config:config:console',
      'encrypt:shop:console-config:config:console',
      'decrypt:shop:console-config:client:shop',
    ]);
    expect(bus.wire).not.toContain('feature.x');
  });

  it('crypto embedded in the app itself: it creates the key in its own partition', async () => {
    const server = new FakeCryptoServer();
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), { bus, bindings: { 'agora.crypto': server.embedded('shop') } });
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'agora.crypto': server.tenant('hub', ['crypto:seal:console-*']) },
    });
    const view = await hubView(hubApp, bus, store);
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect(await server.service.store.getKey('shop', 'console-config')).not.toBeNull();
    // The Hub, a crypto tenant, sealed with shop's key through its own channel (crypto:seal).
    expect(server.audit.find((a) => a.op === 'encrypt')).toMatchObject({
      partition: 'shop',
      actor: 'client:hub',
    });
  });

  it('a Hub that is a crypto tenant says what to grant or upgrade when the server refuses to seal', async () => {
    const server = new FakeCryptoServer();
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), { bus, bindings: { 'agora.crypto': server.embedded('shop') } });
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'agora.crypto': server.tenant('hub', ['crypto:encrypt:*']) },
    });
    const view = await hubView(hubApp, bus, store);
    await expect(view.unsetEntry(SCOPE, 'feature.x', undefined, writer)).rejects.toThrow(
      /crypto:seal:console-\*/,
    );
    server.old = true;
    await expect(view.unsetEntry(SCOPE, 'feature.x', undefined, writer)).rejects.toThrow(
      /upgrade @adonis-agora\/crypto/,
    );
  });

  it('an app on a crypto tenant logs one info line when the key is missing (provisioned on first seal)', async () => {
    const server = new FakeCryptoServer();
    const lines: string[] = [];
    await boot(shop({}), {
      lines,
      bindings: { 'agora.crypto': server.tenant('shop', []) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines.filter((l) => l.includes('crypto key "console-config"'))).toEqual([
      'info [@adonis-agora/config] console commands: the crypto key "console-config" does not exist in partition shop yet; the crypto server creates it on the console\'s first command (if it has sealProvisioning off: node ace crypto:keys:create console-config --type aes256-gcm --application shop)',
    ]);
    // With crypto:keys:manage:console-* it creates the key instead.
    const managed = new FakeCryptoServer();
    const quiet: string[] = [];
    await boot(shop({}), {
      lines: quiet,
      bindings: {
        'agora.crypto': managed.tenant('shop', ['crypto:keys:manage:console-*']),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(quiet.some((l) => l.includes('created the crypto key "console-config"'))).toBe(true);
    expect(await managed.service.store.getKey('shop', 'console-config')).not.toBeNull();
  });
});

describe('explicit options win', () => {
  it('a secret is used as given, with no automatic crypto on top', async () => {
    const server = new FakeCryptoServer();
    const lines: string[] = [];
    await boot(shop({ secret: 'a-shared-secret-of-16+' }), {
      lines,
      bindings: { 'agora.crypto': server.embedded('shop') },
    });
    expect(lines).toContain('info [@adonis-agora/config] console commands: secret; actions on');
  });

  it('`crypto: false` turns automatic crypto off (and says so when nothing else is left)', async () => {
    const server = new FakeCryptoServer();
    await expect(
      boot(shop({ crypto: false }), { bindings: { 'agora.crypto': server.embedded('shop') } }),
    ).rejects.toThrow(/`crypto: false` turned the automatic crypto mode off/);
  });
});

describe('misconfiguration fails at boot', () => {
  it('app side: a verifier without an APP_KEY says so', async () => {
    delete process.env.APP_KEY;
    const authkit = new FakeAuthkit();
    // No key anywhere: not in app.appKey, not in config/encryption.ts, not in the environment.
    const noKey = encryptionConfig({ list: { a: drivers.aes256gcm({ id: 'a', keys: [''] }) } });
    await expect(
      boot(shop({}), {
        bindings: { 'authkit.client': authkit.client('shop') },
        config: { encryption: noKey },
      }),
    ).rejects.toThrow(/authkit app-call, auto\), but token mode needs an APP_KEY/);
  });

  it('app side: consoleCommands with no way to authenticate', async () => {
    const error = await boot(shop({})).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/consoleCommands needs authentication/);
    expect(error.message).toMatch(/@adonis-agora\/crypto/);
    expect(error.message).toMatch(/consoleCommands\.secret/);
    expect(error.message).toMatch(/consoleCommands\.verifyTenant/);
  });

  it('console side: an entry that may act with no way to authenticate; `actions: false` browses', async () => {
    const store = await seeded();
    await expect(boot(hub({}, store))).rejects.toThrow(
      /federatedApps\["shop"\].*controlPlane\.secret.*controlPlane\.token.*actions: false/s,
    );
    const lines: string[] = [];
    await boot(hub({ actions: false }, store), { lines });
    expect(lines).toContain(
      'info [@adonis-agora/config] console commands to "shop": none (actions: false, browse only)',
    );
  });

  it('never fails an ace command, which starts no channel', async () => {
    const store = await seeded();
    await expect(boot(shop({}), { environment: 'console' })).resolves.toBeDefined();
    await expect(boot(hub({}, store), { environment: 'console' })).resolves.toBeDefined();
  });
});

describe('automatic token from authkit (calls between apps)', () => {
  it('no crypto: the token is sealed to the app key, verified by audience, capped by its grant', async () => {
    process.env.APP_KEY = APP_KEY;
    const authkit = new FakeAuthkit();
    authkit.grant('hub', 'shop', ['config:read']);
    const bus = new RedisBus();
    const store = await seeded();
    const lines: string[] = [];
    await boot(shop({}, store), {
      bus,
      lines,
      bindings: { 'authkit.client': authkit.client('shop', { calls: false }) },
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^info \[@adonis-agora\/config\] console commands: token \(authkit app-call, auto; sealed to key [A-Za-z0-9_-]{8}\); actions on$/,
        ),
      ]),
    );
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'authkit.client': authkit.client('hub', { verifies: false }) },
    });
    const view = await hubView(hubApp, bus, store);
    // Its grant on shop is read-only: a viewer with config:* still cannot write.
    await expect(view.unsetEntry(SCOPE, 'feature.x', undefined, writer)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/token lacks config:write/),
    });
    // Granted write: it runs, though the token's partition ("hub") is not the target ("shop").
    authkit.grant('hub', 'shop', ['config:*']);
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect((await store.read(SCOPE))?.entries['feature.x']).toBeUndefined();
    expect(bus.wire).not.toContain('call:hub:shop');
  });

  it('with crypto too: sealed with crypto and carrying the token; a bad token is refused', async () => {
    const authkit = new FakeAuthkit();
    authkit.grant('hub', 'shop', ['config:*']);
    const server = new FakeCryptoServer();
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), {
      bus,
      bindings: {
        'agora.crypto': server.tenant('shop', []),
        'authkit.client': authkit.client('shop'),
      },
    });
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: {
        'agora.crypto': server.embedded('hub'),
        'authkit.client': authkit.client('hub'),
      },
    });
    const view = await hubView(hubApp, bus, store);
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect(authkit.issued).toBeGreaterThan(0);
    // `token: false` sends none (the seal alone is accepted); a token that fails is refused.
    const untokened = await hubView(hubApp, bus, store, {
      controlPlane: { prefix: 'shop', token: false },
    });
    await expect(untokened.rollback(SCOPE, 1, undefined, writer)).resolves.toMatchObject({
      changed: true,
    });
    authkit.grants.clear();
    await expect(view.rollback(SCOPE, 1, undefined, writer)).rejects.toBeInstanceOf(
      FederatedAppError,
    );
  });
});

describe("authkit's key directory (token mode, no SELECT on the app's keys)", () => {
  it('the app publishes its command key; a console that cannot read the store uses it', async () => {
    process.env.APP_KEY = APP_KEY;
    const authkit = new FakeAuthkit();
    authkit.grant('hub', 'shop', ['config:*']);
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), {
      bus,
      bindings: { 'authkit.client': authkit.client('shop', { calls: false }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const published = authkit.directory.get('shop/console:config');
    expect(published).toMatchObject({ kty: 'OKP', crv: 'X25519' });
    expect(published).not.toHaveProperty('d');

    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'authkit.client': authkit.client('hub', { verifies: false }) },
    });
    // The console's store connection has no SELECT on config_tenant_keys.
    const blind = Object.assign(Object.create(store) as MemoryStore, {
      listTenantKeys: async () => {
        throw new Error('permission denied for table config_tenant_keys');
      },
    });
    const view = await hubView(hubApp, bus, blind);
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect((await store.read(SCOPE))?.entries['feature.x']).toBeUndefined();
  });
});

describe('fallback verifier on a control plane', () => {
  it("uses the control plane's own verifyTenant when consoleCommands has none", async () => {
    process.env.APP_KEY = APP_KEY;
    const lines: string[] = [];
    await boot(
      defineConfig({
        topology: 'control-plane',
        environment: 'production',
        store: stores.memory(),
        crypto: { keys: ['a-real-app-key-of-32-characters!!'] },
        verifyTenant: () => null,
        console: false,
        consoleCommands: { prefix: 'cp', partitions: ['shop'] },
      }) as ConfigConfig,
      { lines },
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^info \[@adonis-agora\/config\] console commands: token \(the control plane's verifyTenant; sealed to key [A-Za-z0-9_-]{8}\); actions off \(set consoleCommands\.actions to let the console act\)$/,
        ),
      ]),
    );
  });
});

describe('agora:doctor console commands checks', () => {
  it('reports the mode on each side, probes the key, and errors when unauthenticated', async () => {
    const server = new FakeCryptoServer();
    const store = await seeded();
    const ok = await boot(hub({}, store), {
      environment: 'console',
      bindings: { 'agora.crypto': server.embedded('hub') },
    });
    expect(consoleCommandsCheck.id).toBe('config.console-commands');
    expect(consoleCommandsKeyCheck).toMatchObject({
      id: 'config.console-commands-key',
      cost: 'deep',
    });
    expect(await consoleCommandsCheck.run(ok)).toEqual([
      {
        status: 'ok',
        message: 'console commands to "shop": crypto (auto, key console-config, partition shop)',
      },
    ]);
    expect(await consoleCommandsKeyCheck.run(ok)).toEqual([
      expect.objectContaining({
        status: 'ok',
        message: '"shop": "console-config" encrypts and decrypts in partition shop.',
      }),
    ]);
    const broken = await boot(shop({}), { environment: 'console' });
    expect(await consoleCommandsCheck.run(broken)).toEqual([
      expect.objectContaining({
        status: 'error',
        message: expect.stringMatching(/unauthenticated/),
      }),
    ]);
    expect(await consoleCommandsKeyCheck.run(broken)).toMatchObject({ status: 'skip' });
  });

  it('a missing key on a crypto tenant is ok with a note (the server provisions it), naming the command', async () => {
    const server = new FakeCryptoServer();
    server.keys.clear();
    const app = await boot(hub({}, await seeded()), {
      environment: 'console',
      bindings: { 'agora.crypto': server.tenant('hub', ['crypto:seal:console-*']) },
    });
    expect(await consoleCommandsKeyCheck.run(app)).toEqual([
      {
        status: 'ok',
        message:
          '"shop": "console-config" does not exist in partition shop yet; the crypto server creates it on the console\'s first command (if it has sealProvisioning off: node ace crypto:keys:create console-config --type aes256-gcm --application shop).',
      },
    ]);
  });
});

describe('the console key on a crypto tenant is never silent', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const keyLines = (lines: string[]) =>
    lines.filter((l) => l.includes('crypto key "console-config"'));

  it('refused (the crypto server rejects this app): one warn line, no grant asked for', async () => {
    const server = new FakeCryptoServer();
    const tenant = server.tenant('shop', []);
    tenant.operations.decrypt = async () => {
      throw Object.assign(new Error('crypto: the server refused the token'), {
        code: 'unauthenticated',
      });
    };
    const lines: string[] = [];
    await boot(shop({}), { lines, bindings: { 'agora.crypto': tenant } });
    await settle();
    expect(keyLines(lines)).toEqual([
      'warn [@adonis-agora/config] console commands: the crypto server refused this app on the crypto key "console-config" in partition shop (crypto: the server refused the token); no grant is needed for an app\'s own console keys (crypto:decrypt:console-* is harmless if present): check this app\'s crypto token is valid and the crypto server is up to date',
    ]);
  });

  it('unreachable: one warn line; the next command is the retry, and its success clears it', async () => {
    const server = new FakeCryptoServer();
    await server.service.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'setup' },
      { name: 'console-config', type: 'aes256-gcm' },
    );
    const tenant = server.tenant('shop', []);
    let down = true;
    const decrypt = tenant.operations.decrypt;
    let calls = 0;
    tenant.operations.decrypt = async (input) => {
      calls += 1;
      if (down) throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      return decrypt(input);
    };
    const bus = new RedisBus();
    const store = await seeded();
    const lines: string[] = [];
    await boot(shop({}, store), { bus, lines, bindings: { 'agora.crypto': tenant } });
    await settle();
    expect(keyLines(lines)).toEqual([
      expect.stringMatching(/^warn .*could not check the crypto key .*is the crypto server up/),
    ]);
    expect(calls).toBe(1);
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'agora.crypto': server.embedded('hub') },
    });
    const view = await hubView(hubApp, bus, store);
    // Still down: the command fails with ONE decrypt call, and the same line is not logged again.
    await expect(view.unsetEntry(SCOPE, 'feature.x', undefined, writer)).rejects.toThrow();
    expect(calls).toBe(2);
    expect(keyLines(lines)).toHaveLength(1);
    // Back up: the next command works with one call.
    down = false;
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect(calls).toBe(3);
    expect((await store.read(SCOPE))?.entries['feature.x']).toBeUndefined();
  });
});

describe('uniform DX strings and behaviour (§11)', () => {
  it('the app-side boot error, word for word', async () => {
    const error = await boot(shop({})).catch((e: unknown) => e as Error);
    expect(error.name).toBe('ConsoleAuthConfigError');
    expect(error.message).toBe(
      "[@adonis-agora/config] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key console-config), or configure authkit-client's `service` (automatic: the console uses an authkit app-call token; grant it config:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). Run `node ace agora:doctor` to see every Agora lib's console auth at once. Docs: https://davidecarvalho.github.io/agora/docs/config/federated-console#authenticating-the-console",
    );
  });

  it('the console-side boot error, word for word', async () => {
    const error = await boot(hub({}, await seeded())).catch((e: unknown) => e as Error);
    expect(error.name).toBe('ConsoleAuthConfigError');
    expect(error.message).toBe(
      '[@adonis-agora/config] console.federatedApps["shop"]: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set console.federatedApps["shop"].controlPlane.secret, or console.federatedApps["shop"].controlPlane.token — or actions: false to only browse it. Run `node ace agora:doctor` to see every Agora lib\'s console auth at once.',
    );
  });

  it('the console creates the key of each federated app at boot, before any command', async () => {
    const server = new FakeCryptoServer();
    const lines: string[] = [];
    await boot(hub({}, await seeded()), {
      lines,
      bindings: { 'agora.crypto': server.embedded('hub') },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await server.service.store.getKey('shop', 'console-config')).not.toBeNull();
    expect(server.audit.map((a) => a.op)).toEqual(['create']);
    expect(lines).toContain(
      'info [@adonis-agora/config] console commands: created the crypto key "console-config" in partition shop',
    );
  });

  it('the console says which app did not answer, and where to look', async () => {
    const bus = new RedisBus();
    const store = await seeded();
    // The app listens but never answers (a refused command, say).
    await bus.connection().subscribe('shop-config-console', () => {});
    const hubApp = await boot(hub({ controlPlane: { prefix: 'shop', secret: SECRET } }, store), {
      bus,
    });
    const view = await hubView(hubApp, bus, store, {
      controlPlane: { prefix: 'shop', secret: SECRET },
      timeoutMs: 200,
    });
    await expect(view.unsetEntry(SCOPE, 'feature.x', undefined, writer)).rejects.toThrow(
      'no instance of "shop" answered within 0.2s — the app may have refused the command (check its logs, or run `node ace agora:doctor` there)',
    );
  });

  it('never crashes on a bad message: garbage is logged once per reason, and it keeps serving', async () => {
    const bus = new RedisBus();
    const store = await seeded();
    const lines: string[] = [];
    await boot(shop({ secret: SECRET }, store), { bus, lines });
    const raw = bus.connection();
    const garbage = [
      'not json',
      'not json either',
      'null',
      '42',
      '[]',
      '{}',
      '{"id":5}',
      '{"id":"a","sealed":"agora:ct1:console-config:1:zz"}',
      '{"id":"b","mac":"forged","verb":"unsetEntry","args":[],"ts":1}',
      '{"id":"c","verb":"unsetEntry","args":"nope","capabilities":["*"]}',
      `{"id":"d","pad":"${'x'.repeat(100_000)}"}`,
    ];
    for (const message of garbage) await raw.publish('shop-config-console', message);
    // A command signed with the right secret but no capabilities, and one with a wrong signature.
    await raw.publish(
      'shop-config-console',
      JSON.stringify({ id: 'e', verb: 'unsetEntry', args: [], ts: Date.now(), mac: 'nope' }),
    );
    const sender = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await sender.send(
      { id: crypto.randomUUID(), verb: 'unsetEntry', args: [{ scope: SCOPE, key: 'x.y' }] },
      { timeoutMs: 500 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const warnings = lines.filter((l) => l.includes('refused a command'));
    // One line per distinct reason, not one per message, with the uniform reasons.
    expect(new Set(warnings).size).toBe(warnings.length);
    const prefix = 'warn [@adonis-agora/config] console commands: refused a command';
    expect(warnings.sort()).toEqual(
      [
        `${prefix} (not JSON)`,
        `${prefix} (no command id)`,
        `${prefix} (stale)`,
        `${prefix} (bad signature)`,
        `${prefix} (capabilities-required)`,
        `${prefix} (mode not accepted here (this app accepts: secret; the command came as crypto (key console-config)))`,
        `${prefix} (mode not accepted here (this app accepts: secret; the command came as an unsigned message))`,
      ].sort(),
    );

    // Still serving: a real command runs.
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const reply = await console.send(
      {
        id: crypto.randomUUID(),
        verb: 'unsetEntry',
        args: [{ scope: SCOPE, key: 'feature.x' }],
        capabilities: ['config:write'],
      },
      { timeoutMs: 500 },
    );
    expect(reply).toMatchObject({ ok: true });
    expect((await store.read(SCOPE))?.entries['feature.x']).toBeUndefined();
  });
});

describe('mixed Hubs: some apps with crypto, some without (§13)', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  /** The Hub: crypto embedded and authkit, no auth line for the app. */
  async function theHub(
    server: FakeCryptoServer,
    authkit: FakeAuthkit,
    bus: RedisBus,
    store: MemoryStore,
    lines: string[] = [],
  ) {
    const hubApp = await boot(hub({}, store), {
      bus,
      lines,
      bindings: { 'agora.crypto': server.embedded('hub'), 'authkit.client': authkit.client('hub') },
    });
    return { hubApp, view: await hubView(hubApp, bus, store) };
  }
  const sealedAs = (bus: RedisBus) =>
    bus.published
      .filter((p) => p.channel === 'shop-config-console')
      .map((p) => (JSON.parse(p.message) as { sealed?: string }).sealed?.slice(0, 10));

  it('13a: an app with crypto is reached in crypto mode, and publishes nothing (13e: says nothing)', async () => {
    process.env.APP_KEY = APP_KEY;
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit();
    authkit.grant('hub', 'shop', ['config:console:*']);
    const bus = new RedisBus();
    const store = await seeded();
    const shopLines: string[] = [];
    await boot(shop({}, store), {
      bus,
      lines: shopLines,
      bindings: {
        'agora.crypto': server.tenant('shop', []),
        'authkit.client': authkit.client('shop'),
      },
    });
    await settle();
    // Crypto reaches it: no command key in its store, none in authkit's directory, no warning.
    expect(await store.listTenantKeys!('@console-commands:shop')).toEqual([]);
    expect(authkit.directory.size).toBe(0);
    expect(shopLines.filter((l) => l.startsWith('warn '))).toEqual([]);
    const hubLines: string[] = [];
    const { view } = await theHub(server, authkit, bus, store, hubLines);
    expect(hubLines).toContain(
      `info [@adonis-agora/config] console commands to "shop": auto (the app's published key if it publishes one, else crypto (auto, key console-config, partition shop))`,
    );
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect(sealedAs(bus)).toEqual(['agora:ct1:']);
  });

  it('13a: an authkit-only app publishes its key and is reached in token mode, with no lib config', async () => {
    process.env.APP_KEY = APP_KEY;
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit();
    authkit.grant('hub', 'shop', ['config:console:*']);
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), { bus, bindings: { 'authkit.client': authkit.client('shop') } });
    await settle();
    const { view } = await theHub(server, authkit, bus, store);
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect(sealedAs(bus)).toEqual(['agora:pk1:']);
    expect((await store.read(SCOPE))?.entries['feature.x']).toBeUndefined();
  });

  it('13b: in crypto mode a token that fails to mint never blocks the command (info for a missing grant)', async () => {
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit();
    authkit.mintError = 'invalid_target';
    authkit.mintCode = 'invalid_target';
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), { bus, bindings: { 'agora.crypto': server.tenant('shop', []) } });
    const lines: string[] = [];
    const hubApp = await boot(hub({}, store), {
      bus,
      lines,
      bindings: { 'agora.crypto': server.embedded('hub'), 'authkit.client': authkit.client('hub') },
    });
    const view = await buildFederatedConfigApp(
      'shop',
      { store, controlPlane: { prefix: 'shop' }, timeoutMs: 500 },
      {
        db: async () => {
          throw new Error('unused');
        },
        redis: async () => bus.connection(),
        siblings: await consoleSiblingsOf(hubApp.container),
        logger: {
          warn: (line) => lines.push(`warn ${line}`),
          info: (line) => lines.push(`info ${line}`),
        },
      },
    );
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    await view.rollback(SCOPE, 1, undefined, writer);
    const warnings = lines.filter((l) => l.includes('without an authkit app-call token'));
    expect(warnings).toEqual([
      'info [@adonis-agora/config] console commands to "shop": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client config:console:* on "shop" in authkit.',
    ]);
    expect(authkit.issued).toBe(0);
  });

  it('13b: any other minting failure (authkit unreachable) is a warning, same wording', async () => {
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit();
    authkit.mintError = 'authkit unreachable (ECONNREFUSED)';
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), { bus, bindings: { 'agora.crypto': server.tenant('shop', []) } });
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'agora.crypto': server.embedded('hub'), 'authkit.client': authkit.client('hub') },
    });
    const lines: string[] = [];
    const view = await buildFederatedConfigApp(
      'shop',
      { store, controlPlane: { prefix: 'shop' }, timeoutMs: 500 },
      {
        db: async () => {
          throw new Error('unused');
        },
        redis: async () => bus.connection(),
        siblings: await consoleSiblingsOf(hubApp.container),
        logger: {
          warn: (line) => lines.push(`warn ${line}`),
          info: (line) => lines.push(`info ${line}`),
        },
      },
    );
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    expect(lines.filter((l) => l.includes('without an authkit app-call token'))).toEqual([
      'warn [@adonis-agora/config] console commands to "shop": sending without an authkit app-call token (crypto only): authkit unreachable (ECONNREFUSED). To attach it: grant the console\'s service client config:console:* on "shop" in authkit.',
    ]);
  });

  it('13b: in token mode the token is required, and its error says which grant to add', async () => {
    process.env.APP_KEY = APP_KEY;
    const authkit = new FakeAuthkit();
    const bus = new RedisBus();
    const store = await seeded();
    await boot(shop({}, store), { bus, bindings: { 'authkit.client': authkit.client('shop') } });
    await settle();
    authkit.mintError = 'invalid_target';
    authkit.mintCode = 'invalid_target';
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'authkit.client': authkit.client('hub') },
    });
    const view = await hubView(hubApp, bus, store);
    await expect(view.unsetEntry(SCOPE, 'feature.x', undefined, writer)).rejects.toThrow(
      /invalid_target\. To attach it: grant the console's service client config:console:\* on "shop" in authkit\./,
    );
  });

  it('13f: the key check asks hasKey when crypto offers it, and never probes with a decrypt', async () => {
    const server = new FakeCryptoServer();
    await server.service.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'setup' },
      { name: 'console-config', type: 'aes256-gcm' },
    );
    const tenant = server.tenant('shop', [], { hasKey: true });
    const lines: string[] = [];
    await boot(shop({}), { lines, bindings: { 'agora.crypto': tenant } });
    await settle();
    expect(server.audit.filter((a) => a.op === 'decrypt')).toEqual([]);
    expect(lines.filter((l) => l.includes('crypto key "console-config"'))).toEqual([]);
    const missing = new FakeCryptoServer();
    const quiet: string[] = [];
    await boot(shop({}), {
      lines: quiet,
      bindings: { 'agora.crypto': missing.tenant('shop', [], { hasKey: true }) },
    });
    await settle();
    expect(quiet.filter((l) => l.includes('does not exist in partition shop yet'))).toHaveLength(1);
    expect(missing.audit.filter((a) => a.op === 'decrypt')).toEqual([]);
  });
});

describe('stale command keys (§13e follow-up)', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const REMOVED =
    'info [@adonis-agora/config] console commands: removed the console command key it no longer publishes (crypto is enough)';

  it('an app with crypto removes the key an older version of it published, once', async () => {
    process.env.APP_KEY = APP_KEY;
    const authkit = new FakeAuthkit();
    const store = await seeded();
    // An older boot, authkit only: token mode, key published in its store.
    await boot(shop({}, store), { bindings: { 'authkit.client': authkit.client('shop') } });
    await settle();
    expect(await store.listTenantKeys!('@console-commands:shop')).toHaveLength(1);
    // Now with crypto: crypto is enough, the row goes.
    const server = new FakeCryptoServer();
    const lines: string[] = [];
    await boot(shop({}, store), {
      lines,
      bindings: {
        'agora.crypto': server.tenant('shop', []),
        'authkit.client': authkit.client('shop'),
      },
    });
    await settle();
    expect(await store.listTenantKeys!('@console-commands:shop')).toEqual([]);
    expect(lines.filter((l) => l === REMOVED)).toHaveLength(1);
    // Idempotent: the next boot finds nothing to remove and says nothing.
    const again: string[] = [];
    await boot(shop({}, store), {
      lines: again,
      bindings: {
        'agora.crypto': server.tenant('shop', []),
        'authkit.client': authkit.client('shop'),
      },
    });
    await settle();
    expect(again).not.toContain(REMOVED);
  });

  it('a console that picked token mode but cannot mint the token sends by crypto instead', async () => {
    process.env.APP_KEY = APP_KEY;
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit();
    const bus = new RedisBus();
    const store = await seeded();
    // An older app version: crypto booted, yet its key row is still in its store (it cannot
    // remove it), so the Hub picks token mode for it.
    // (An older version has no removeTenantKeys.)
    const old = Object.assign(store, { removeTenantKeys: undefined });
    const { consoleCommandKeys } = await import('../../src/federation/console.js');
    const { d: _d, ...publicKey } = consoleCommandKeys(APP_KEY, 'shop').publicKey;
    await store.registerTenantKey!({
      app: '@console-commands:shop',
      kid: publicKey.kid,
      publicKey,
      active: true,
      createdAt: new Date(0).toISOString(),
      createdBy: 'config:console-commands',
    });
    await boot(shop({}, old), {
      bus,
      bindings: {
        'agora.crypto': server.tenant('shop', []),
        'authkit.client': authkit.client('shop'),
      },
    });
    await settle();
    authkit.mintError = 'invalid_target';
    authkit.mintCode = 'invalid_target';
    const lines: string[] = [];
    const hubApp = await boot(hub({}, store), {
      bus,
      bindings: { 'agora.crypto': server.embedded('hub'), 'authkit.client': authkit.client('hub') },
    });
    const view = await buildFederatedConfigApp(
      'shop',
      { store, controlPlane: { prefix: 'shop' }, timeoutMs: 500 },
      {
        db: async () => {
          throw new Error('unused');
        },
        redis: async () => bus.connection(),
        siblings: await consoleSiblingsOf(hubApp.container),
        logger: {
          warn: (line) => lines.push(`warn ${line}`),
          info: (line) => lines.push(`info ${line}`),
        },
      },
    );
    await view.unsetEntry(SCOPE, 'feature.x', undefined, writer);
    await view.rollback(SCOPE, 1, undefined, writer);
    expect((await store.read(SCOPE))?.version).toBeGreaterThan(2);
    const sealed = bus.published
      .filter((p) => p.channel === 'shop-config-console')
      .map((p) => (JSON.parse(p.message) as { sealed?: string }).sealed?.slice(0, 10));
    expect(sealed).toEqual(['agora:ct1:', 'agora:ct1:']);
    expect(lines.filter((l) => l.includes('without an authkit app-call token'))).toEqual([
      'info [@adonis-agora/config] console commands to "shop": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client config:console:* on "shop" in authkit.',
    ]);
  });
});
