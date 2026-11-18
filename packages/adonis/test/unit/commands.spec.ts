import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigAudit,
  ConfigDiff,
  ConfigEntryGet,
  ConfigEntryList,
  ConfigEntrySet,
  ConfigEntryUnset,
  ConfigEnv,
  ConfigHistory,
  ConfigRollback,
  ConfigVersionShow,
} from '../../commands/config.js';
import ConfigCryptoReseal from '../../commands/crypto.js';
import ConfigPull from '../../commands/pull.js';
import ConfigTenantKey from '../../commands/tenant_key.js';
import { generateKeyPair } from '../../src/crypto-kit/index.js';
import { defineConfig, stores } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testSecretCodec } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

/** The config:* commands through the real ace kernel of a booted control plane. */
describe('commands', () => {
  let app: ApplicationService;
  let dir: string;
  let writes: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'config-cmd-'));
    mkdirSync(join(process.cwd(), 'test/unit/tmp'), { recursive: true });
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/config_provider.js')] },
        config: {
          config: defineConfig({
            topology: 'control-plane',
            verifyTenant: async () => null,
            store: stores.memory(),
            crypto: { keys: [{ id: 'app', secret: 'a-test-key-of-32-characters!!!' }] },
            console: false,
          }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('console') as ApplicationService;
    await app.init();
    await app.boot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.terminate();
    rmSync(dir, { recursive: true, force: true });
    for (const file of ['.env.local', '.env.remote', '.gitignore']) {
      rmSync(join(app.makePath(), file), { force: true });
    }
  });

  async function run(command: never, args: string[]) {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const ace = await app.container.make('ace');
    const instance = await ace.create(command, args);
    instance.ui.switchMode('raw');
    await instance.exec();
    return { instance, json: () => JSON.parse(writes.join('')) };
  }

  const scopeFlags = ['--app=shop', '--environment=production'];

  async function seed(): Promise<void> {
    await run(ConfigEntrySet as never, [
      'db.host',
      'localhost',
      ...scopeFlags,
      '--message=first',
      '--json',
    ]);
    await run(ConfigEntrySet as never, [
      'checkout.timeoutMs',
      '3000',
      ...scopeFlags,
      '--reloadable',
      '--json',
    ]);
    await run(ConfigEntrySet as never, [
      'stripe.secret',
      'sk_test',
      ...scopeFlags,
      '--secret',
      '--json',
    ]);
  }

  it('picks the app with --app, and still with --application and -a', async () => {
    await seed();
    for (const flag of ['--app=shop', '--application=shop', '-a=shop']) {
      const list = await run(ConfigEntryList as never, [
        flag,
        '--environment=production',
        '--json',
      ]);
      list.instance.assertSucceeded();
      expect(list.json().meta.total, flag).toBe(3);
    }
  });

  it('sets, lists, gets, reveals and unsets entries', async () => {
    const set = await run(ConfigEntrySet as never, [
      'db.host',
      'localhost',
      ...scopeFlags,
      '--message=first',
      '--json',
    ]);
    set.instance.assertSucceeded();
    expect(set.json()).toMatchObject({ key: 'db.host', changed: true, version: 1 });

    await seed();

    const list = await run(ConfigEntryList as never, [...scopeFlags, '--json']);
    list.instance.assertSucceeded();
    const entries = list.json();
    expect(entries.meta.total).toBe(3);
    expect(
      entries.data.find((entry: { key: string }) => entry.key === 'stripe.secret'),
    ).toMatchObject({ masked: true, secret: true });

    const search = await run(ConfigEntryList as never, [...scopeFlags, '--search=db', '--json']);
    expect(search.json().data.map((entry: { key: string }) => entry.key)).toEqual(['db.host']);

    const maskedGet = await run(ConfigEntryGet as never, [
      'stripe.secret',
      ...scopeFlags,
      '--json',
    ]);
    expect(maskedGet.json()).toMatchObject({ masked: true });
    const revealed = await run(ConfigEntryGet as never, [
      'stripe.secret',
      ...scopeFlags,
      '--secrets',
      '--json',
    ]);
    expect(revealed.json()).toMatchObject({ value: 'sk_test', masked: false });

    const missing = await run(ConfigEntryGet as never, ['nope', ...scopeFlags, '--json']);
    expect(missing.instance.exitCode).toBe(1);

    const unset = await run(ConfigEntryUnset as never, [
      'db.host',
      ...scopeFlags,
      '--force',
      '--json',
    ]);
    expect(unset.json()).toMatchObject({ key: 'db.host', changed: true });
  });

  it('shows history and rolls back to a version', async () => {
    await seed();
    const history = await run(ConfigHistory as never, [...scopeFlags, '--json']);
    history.instance.assertSucceeded();
    expect(history.json().meta.total).toBe(3);
    expect(history.json().data[0].version).toBe(3);

    const rollback = await run(ConfigRollback as never, [
      '--to=1',
      ...scopeFlags,
      '--force',
      '--message=back to the start',
      '--json',
    ]);
    rollback.instance.assertSucceeded();
    expect(rollback.json()).toMatchObject({ to: 1, version: 4, changed: true });

    const list = await run(ConfigEntryList as never, [...scopeFlags, '--json']);
    expect(list.json().data.map((entry: { key: string }) => entry.key)).toEqual(['db.host']);

    const refused = await run(ConfigRollback as never, [
      '--to=99',
      ...scopeFlags,
      '--force',
      '--json',
    ]);
    expect(refused.instance.exitCode).toBe(1);

    const version = await run(ConfigVersionShow as never, ['1', ...scopeFlags, '--json']);
    expect(version.json().entries.map((entry: { key: string }) => entry.key)).toEqual(['db.host']);
    expect(
      (await run(ConfigVersionShow as never, ['99', ...scopeFlags, '--json'])).instance.exitCode,
    ).toBe(1);

    const diff = await run(ConfigDiff as never, ['--from=1', '--to=3', ...scopeFlags, '--json']);
    diff.instance.assertSucceeded();
    expect(
      diff.json().rows.map((row: { key: string; kind: string }) => [row.key, row.kind]),
    ).toEqual([
      ['checkout.timeoutMs', 'added'],
      ['stripe.secret', 'added'],
    ]);

    const audit = await run(ConfigAudit as never, [...scopeFlags, '--action=set', '--json']);
    expect(audit.json().meta.total).toBe(3);
    expect(audit.json().data[0].actor).toMatch(/^cli:/);
  });

  it('prints the resolved values as KEY=value (secrets only with --secrets)', async () => {
    await seed();
    const masked = await run(ConfigEnv as never, [...scopeFlags, '--json']);
    masked.instance.assertSucceeded();
    expect(masked.json()).toMatchObject({
      DB_HOST: 'localhost',
      CHECKOUT_TIMEOUT_MS: '3000',
    });
    expect(masked.json().STRIPE_SECRET).toBeUndefined();

    const revealed = await run(ConfigEnv as never, [...scopeFlags, '--secrets', '--json']);
    expect(revealed.json().STRIPE_SECRET).toBe('sk_test');

    const human = await run(ConfigEnv as never, [...scopeFlags]);
    expect(
      human.instance.ui.logger
        .getLogs()
        .map((log) => log.message)
        .join('\n'),
    ).toContain('DB_HOST=localhost');
  });

  it('pulls values into the managed block, keeping local (Sail) keys and secrets masked', async () => {
    await seed();
    const root = app.makePath();
    writeFileSync(
      join(root, '.env.local'),
      '# sail:start\nDB_HOST=127.0.0.1\nDB_PORT=5789\n# sail:end\n',
    );

    const pull = await run(ConfigPull as never, [
      '--app=shop',
      '--environment=production',
      '--write=.env.local',
      '--json',
    ]);
    pull.instance.assertSucceeded();
    expect(pull.json()).toMatchObject({
      source: 'store',
      file: '.env.local',
      added: ['CHECKOUT_TIMEOUT_MS'],
      skipped: ['DB_HOST'],
      gitignore: 'added',
    });
    const file = readFileSync(join(root, '.env.local'), 'utf8');
    expect(file).toContain('# config:start');
    expect(file).toContain('DB_HOST=127.0.0.1');
    expect(file).toContain('CHECKOUT_TIMEOUT_MS=3000');
    expect(file).not.toContain('STRIPE_SECRET=sk_test');
    expect(file).toContain('DB_PORT=5789');
    expect(file.indexOf('# config:start')).toBeLessThan(file.indexOf('# sail:start'));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.env.local');

    const again = await run(ConfigPull as never, [
      '--app=shop',
      '--environment=production',
      '--write=.env.local',
      '--json',
    ]);
    expect(again.json().added).toEqual(['CHECKOUT_TIMEOUT_MS']);
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(file);

    await run(ConfigPull as never, [
      '--app=shop',
      '--environment=production',
      '--write=.env.remote',
      '--secrets',
      '--json',
    ]);
    expect(readFileSync(join(root, '.env.remote'), 'utf8')).toContain('STRIPE_SECRET=sk_test');
  });

  it('refuses to write into a varlock-encrypted file', async () => {
    await seed();
    const root = app.makePath();
    writeFileSync(join(root, '.env.local'), 'SECRET=varlock(local:abc)\n');
    const pull = await run(ConfigPull as never, [
      '--app=shop',
      '--environment=production',
      '--write=.env.local',
      '--json',
    ]);
    expect(pull.instance.exitCode).toBe(1);
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe('SECRET=varlock(local:abc)\n');
  });

  it('prints KEY=value without --write and can fetch from a remote control plane', async () => {
    await seed();
    const local = await run(ConfigPull as never, [
      '--app=shop',
      '--environment=production',
      '--json',
    ]);
    expect(local.json()).toMatchObject({
      source: 'store',
      env: { DB_HOST: 'localhost', CHECKOUT_TIMEOUT_MS: '3000' },
    });

    const store = new MemoryStore({ secretCodec: testSecretCodec('remote-test') });
    await store.write(
      { app: 'billing', environment: 'production', label: 'main' },
      [{ key: 'db.host', value: 'remote-host' }],
      { actor: 'ann', now: new Date().toISOString() },
    );
    const controlPlane = new ControlPlane({
      store,
      verifyTenant: sharedSecretVerifier({ partitions: { billing: 'billing-secret' } }),
      environment: 'production',
    });
    const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
    controlPlane.register({
      get(pattern, handler) {
        routes.push({ method: 'GET', pattern, handler });
        return { as: () => {} };
      },
    });
    const server: Server = await serve(routes);
    try {
      const remote = await run(ConfigPull as never, [
        '--app=billing',
        '--environment=production',
        `--url=${addressOf(server)}/_config`,
        '--token=billing-secret',
        '--json',
      ]);
      remote.instance.assertSucceeded();
      expect(remote.json()).toMatchObject({
        source: 'remote',
        env: { DB_HOST: 'remote-host' },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports the crypto keyring status and a dry-run reseal', async () => {
    await seed();
    const status = await run(ConfigCryptoReseal as never, ['--dry-run', '--json']);
    status.instance.assertSucceeded();
    const report = status.json();
    expect(report).toMatchObject({
      dryRun: true,
      scanned: expect.any(Number),
      resealed: 0,
      failed: 0,
    });
    expect(report.statuses.active).toBeGreaterThan(0);
    expect(status.json().statuses.retired).toBe(0);

    const real = await run(ConfigCryptoReseal as never, ['--json']);
    real.instance.assertSucceeded();
    expect(real.json()).toMatchObject({ all: false, dryRun: false, resealed: 0, failed: 0 });

    // `--all` rewrites even values already on the active key (rotating the app's own key).
    const all = await run(ConfigCryptoReseal as never, ['--all', '--dry-run', '--json']);
    all.instance.assertSucceeded();
    expect(all.json()).toMatchObject({ all: true, dryRun: true, failed: 0 });
    expect(all.json().resealed).toBe(all.json().scanned);
    expect(all.json().resealed).toBeGreaterThan(0);
  });

  it('seals an entry from the CLI and lists the registered app keys', async () => {
    const runtime = (await app.container.make('agora.config')) as {
      store?: {
        registerTenantKey?: (key: {
          app: string;
          kid: string;
          publicKey: unknown;
          active: boolean;
          createdAt: string;
          createdBy: string;
        }) => Promise<unknown>;
      };
    };
    const pair = generateKeyPair('x25519');
    await runtime.store?.registerTenantKey?.({
      app: 'shop',
      kid: pair.publicKey.kid,
      publicKey: pair.publicKey,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });

    const set = await run(ConfigEntrySet as never, [
      'stripe.sealed',
      'sk_live_123',
      ...scopeFlags,
      '--sealed',
      '--json',
    ]);
    set.instance.assertSucceeded();

    const got = await run(ConfigEntryGet as never, [
      'stripe.sealed',
      ...scopeFlags,
      '--secrets',
      '--json',
    ]);
    const entry = got.json();
    expect(entry).toMatchObject({
      masked: true,
      secret: true,
      sealedTo: { app: 'shop', kid: pair.publicKey.kid },
    });
    expect(entry.value).toBeUndefined();

    const keys = await run(ConfigTenantKey as never, ['--app=shop', '--json']);
    const body = keys.json();
    expect(body.app).toBe('shop');
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kid: pair.publicKey.kid, active: true });
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it('records cli:<os user> as the actor and refuses a value-less set', async () => {
    const set = await run(ConfigEntrySet as never, ['a', ...scopeFlags, '--json']);
    expect(set.instance.exitCode).toBe(1);

    await run(ConfigEntrySet as never, ['a', '1', ...scopeFlags, '--json']);
    const history = await run(ConfigHistory as never, [...scopeFlags, '--json']);
    expect(history.json().data[0].createdBy).toMatch(/^cli:/);
  });
});
