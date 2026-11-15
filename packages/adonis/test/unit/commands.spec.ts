import { mkdtempSync, rmSync } from 'node:fs';
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
import { defineConfig, stores } from '../../src/define_config.js';

/** The config:* commands through the real ace kernel of a booted control plane. */
describe('commands', () => {
  let app: ApplicationService;
  let dir: string;
  let writes: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'config-cmd-'));
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/config_provider.js')] },
        config: {
          config: defineConfig({
            topology: 'control-plane',
            verifyTenant: async () => null,
            store: stores.memory(),
            console: false,
            secrets: { key: 'command-test-key' },
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

  const scopeFlags = ['--application=shop', '--environment=production'];

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

  it('records cli:<os user> as the actor and refuses a value-less set', async () => {
    const set = await run(ConfigEntrySet as never, ['a', ...scopeFlags, '--json']);
    expect(set.instance.exitCode).toBe(1);

    await run(ConfigEntrySet as never, ['a', '1', ...scopeFlags, '--json']);
    const history = await run(ConfigHistory as never, [...scopeFlags, '--json']);
    expect(history.json().data[0].createdBy).toMatch(/^cli:/);
  });
});
