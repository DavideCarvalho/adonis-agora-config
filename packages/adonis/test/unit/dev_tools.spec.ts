import { describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { secretCodec } from '../../src/crypto/secrets.js';
import { configDevTools, registerConfigDevTools } from '../../src/dev_tools.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { seedConfig, testScope } from '../../src/testing/index.js';

const call = {
  ctx: {} as never,
  caller: { id: 'abc123', via: 'token' as const },
  limits: { maxRows: 100, maxBytes: 48_000 },
};

function admin(): ConfigAdmin {
  const store = new MemoryStore({ secretCodec: secretCodec('mcp-test') });
  return new ConfigAdmin({ store, canRevealSecrets: true });
}

async function seeded(): Promise<ConfigAdmin> {
  const a = admin();
  await seedConfig(a.store as MemoryStore, testScope, [
    ['db.host', 'localhost'],
    ['db.port', 5432],
    ['checkout.timeoutMs', 3000],
    { key: 'stripe.secret', value: 'sk', secret: true },
  ]);
  return a;
}

describe('config dev tools', () => {
  it('registers into the hub when one is bound', async () => {
    const registered: unknown[] = [];
    const hub = { version: 1 as const, register: (lib: unknown) => registered.push(lib) };
    const container = {
      hasBinding: (binding: string) => binding === 'agora.devTools',
      make: async () => hub,
    };
    expect(
      await registerConfigDevTools(container, {
        admin: await seeded(),
        authorize: async () => ({ allowed: true }),
      }),
    ).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ lib: 'config', title: 'Centralized configuration' });
    expect(
      (registered[0] as { tools: Array<{ name: string; kind: string }> }).tools
        .filter((tool) => tool.kind === 'action')
        .map((tool) => tool.name),
    ).toEqual(['config_set_entry', 'config_unset_entry', 'config_rollback']);
  });

  it('skips registration without the binding or with another hub version', async () => {
    const admin = await seeded();
    expect(
      await registerConfigDevTools(
        { hasBinding: () => false, make: async () => ({}) },
        { admin, authorize: async () => ({ allowed: true }) },
      ),
    ).toBe(false);
    expect(
      await registerConfigDevTools(
        { hasBinding: () => true, make: async () => ({ version: 2 }) },
        { admin, authorize: async () => ({ allowed: true }) },
      ),
    ).toBe(false);
  });

  it('lists scopes, entries and audit as { items, next }', async () => {
    const tools = configDevTools(await seeded(), { actorFor: () => 'mcp:tester' });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

    expect(await tool('config_list_scopes').run({}, call)).toEqual({
      apps: ['shop'],
      environments: ['production'],
      labels: ['main'],
    });

    const page = (await tool('config_list_entries').run({ app: 'shop', limit: 2 }, call)) as {
      items: Array<{ key: string }>;
      next: number | null;
      total: number;
    };
    expect(page.items).toHaveLength(2);
    expect(page.next).toBe(2);
    expect(page.total).toBe(4);
    const second = (await tool('config_list_entries').run(
      { app: 'shop', page: 2, limit: 2 },
      call,
    )) as { items: unknown[]; next: number | null };
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();

    const audit = (await tool('config_list_audit').run({ app: 'shop' }, call)) as {
      items: unknown[];
      total: number;
    };
    expect(audit.total).toBe(4);

    const versions = (await tool('config_list_versions').run({ app: 'shop' }, call)) as {
      items: Array<{ version: number }>;
      total: number;
    };
    expect(versions.total).toBe(1);
  });

  it('gets an entry and a version, and diffs two versions', async () => {
    const admin = await seeded();
    const tools = configDevTools(admin, { actorFor: () => 'mcp:tester' });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

    expect(
      await tool('config_get_entry').run({ app: 'shop', key: 'stripe.secret' }, call),
    ).toMatchObject({ key: 'stripe.secret', value: 'sk', masked: false });
    await expect(tool('config_get_entry').run({ app: 'shop', key: 'nope' }, call)).rejects.toThrow(
      /no entry/,
    );

    await admin.setEntry(testScope, 'db.port', { value: 5433 }, { actor: 'ann' });
    const diff = (await tool('config_diff_versions').run(
      { app: 'shop', from: 1, to: 2 },
      call,
    )) as { rows: Array<{ key: string; kind: string }> };
    expect(diff.rows).toEqual([expect.objectContaining({ key: 'db.port', kind: 'changed' })]);

    const version = (await tool('config_get_version').run({ app: 'shop', version: 1 }, call)) as {
      entries: Array<{ key: string }>;
    };
    expect(version.entries.map((entry) => entry.key)).toEqual([
      'checkout.timeoutMs',
      'db.host',
      'db.port',
      'stripe.secret',
    ]);
  });

  it('writes, unsets and rolls back with the mcp actor', async () => {
    const admin = await seeded();
    const tools = configDevTools(admin, { actorFor: () => 'mcp:tester' });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

    const set = (await tool('config_set_entry').run(
      {
        app: 'shop',
        key: 'checkout.retries',
        value: '3',
        reloadable: true,
        message: 'tune',
      },
      call,
    )) as { version: number; changed: boolean };
    expect(set).toMatchObject({ version: 2, changed: true });
    expect(
      await admin.getEntry(testScope, 'checkout.retries', { canReadSecrets: true }),
    ).toMatchObject({
      value: 3,
      reloadable: true,
      updatedBy: 'mcp:tester',
    });

    const unset = (await tool('config_unset_entry').run({ app: 'shop', key: 'db.host' }, call)) as {
      version: number;
      changed: boolean;
    };
    expect(unset).toEqual({ scope: testScope, key: 'db.host', version: 3, changed: true });

    const rollback = (await tool('config_rollback').run({ app: 'shop', to: 1 }, call)) as {
      version: number;
      changed: boolean;
    };
    expect(rollback).toMatchObject({ version: 4, changed: true });
    expect((await admin.audit(testScope, { page: 1, size: 10 })).data[0]).toMatchObject({
      actor: 'mcp:tester',
      action: 'rollback',
    });
  });

  it('refuses a write without a value and an invalid key', async () => {
    const tools = configDevTools(await seeded(), { actorFor: () => 'mcp:tester' });
    const set = tools.find((tool) => tool.name === 'config_set_entry')!;
    await expect(set.run({ app: 'shop', key: 'a' }, call)).rejects.toThrow(/pass value or vault/);
    await expect(set.run({ app: 'shop', key: 'a..b', value: '1' }, call)).rejects.toThrow(
      /invalid key/,
    );
  });
});
