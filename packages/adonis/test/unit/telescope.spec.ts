import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { CONFIG_DIAGNOSTIC_EVENTS } from '../../src/diagnostics.js';
import {
  configActionsProvider,
  configChangesOverTimeProvider,
  configChangesProvider,
  configDashboard,
  configRevealsProvider,
  configStatsProvider,
  configTelescopeExtension,
  type ExtensionContext,
  registerConfigTelescopeExtension,
  type TelescopeEntryLike,
  type TelescopeExtension,
} from '../../src/telescope/index.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
});

function entry(
  event: string,
  payload: Record<string, unknown>,
  minutesAgo = 0,
): TelescopeEntryLike {
  return { content: { event, payload }, createdAt: new Date(Date.now() - minutesAgo * 60_000) };
}

function ctxWith(
  entries: TelescopeEntryLike[] = [],
  runtime?: Record<string, unknown>,
): ExtensionContext {
  return {
    store: { list: async () => entries },
    container: {
      async make(token: unknown) {
        if (token === 'agora.config' && runtime) return runtime;
        throw new Error(`no ${String(token)}`);
      },
    },
    config: {},
  } as unknown as ExtensionContext;
}

const change = (action: 'set' | 'unset' | 'rollback', key: string, minutesAgo = 0) =>
  entry(
    action === 'rollback' ? 'rollback' : `entry.${action}`,
    {
      app: 'shop',
      environment: 'production',
      label: 'main',
      key,
      version: 2,
      actor: 'ann',
      secret: true,
      reloadable: false,
      ...(action === 'set' ? { sealedTo: { app: 'shop', kid: 'k1' } } : {}),
    },
    minutesAgo,
  );

const reveal = (key: string, minutesAgo = 0) =>
  entry(
    'entry.reveal',
    { app: 'shop', environment: 'production', label: 'main', key, version: 2, actor: 'ops' },
    minutesAgo,
  );

describe('telescope extension', () => {
  it('exposes one dashboard and the config providers', () => {
    const extension = configTelescopeExtension();
    expect(extension.name).toBe('config');
    const ctx = ctxWith();
    expect(extension.dashboards?.(ctx).map((dashboard) => dashboard.id)).toEqual([
      'config.overview',
    ]);
    expect(extension.dataProviders?.(ctx).map((provider) => provider.name)).toEqual([
      'config.changes',
      'config.reveals',
      'config.changesOverTime',
      'config.actions',
      'config.tenants',
      'config.stats',
    ]);
    const dashboard = configDashboard();
    const providers = dashboard
      .sections!.flatMap((section) => section.panels)
      .map((panel) => panel.data.provider);
    for (const provider of providers) {
      expect(extension.dataProviders?.(ctx).map((p) => p.name)).toContain(provider);
    }
  });

  it('serves recent changes, paged and filtered, without values', async () => {
    const entries = [
      change('set', 'db.host', 1),
      change('unset', 'legacy.flag', 2),
      change('rollback', 'db.pool', 3),
      reveal('db.password', 4),
    ];
    const provider = configChangesProvider();
    const page = (await provider.resolve({ page: 1, size: 2 }, ctxWith(entries))) as {
      rows: Array<Record<string, unknown>>;
      total: number;
      page: number;
      size: number;
    };
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({
      app: 'shop',
      action: 'set',
      key: 'db.host',
      actor: 'ann',
      version: 2,
      flags: 'secret sealed:shop',
    });
    expect(JSON.stringify(page)).not.toContain('hunter2');

    const byKey = (await provider.resolve({ key: 'db.host' }, ctxWith(entries))) as {
      total: number;
    };
    expect(byKey.total).toBe(1);
  });

  it('aggregates actions and changes over time', async () => {
    const entries = [
      change('set', 'a', 1),
      change('set', 'b', 2),
      change('unset', 'c', 3),
      change('rollback', 'd', 4),
      reveal('e', 5),
    ];
    const actions = (await configActionsProvider().resolve(undefined, ctxWith(entries))) as {
      segments: Array<{ label: string; value: number }>;
    };
    expect(Object.fromEntries(actions.segments.map((s) => [s.label, s.value]))).toEqual({
      set: 2,
      unset: 1,
      rollback: 1,
      reveal: 1,
    });

    const over = (await configChangesOverTimeProvider().resolve(
      { buckets: 6 },
      ctxWith(entries),
    )) as { rows: Array<Record<string, number | string>> };
    expect(over.rows).toHaveLength(6);
    const total = over.rows.reduce(
      (sum, row) => sum + Number(row.set) + Number(row.unset) + Number(row.rollback),
      0,
    );
    expect(total).toBe(4);
  });

  it('lists secret reveals only', async () => {
    const entries = [reveal('db.password', 1), change('set', 'db.host', 2)];
    const result = (await configRevealsProvider().resolve(undefined, ctxWith(entries))) as {
      rows: Array<{ key: string; actor: string }>;
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({ key: 'db.password', actor: 'ops' });
  });

  it('counts the live store and the recorded activity', async () => {
    const store = memoryConfig();
    await seedConfig(store, testScope, [
      { key: 'db.host', value: 'localhost' },
      { key: 'stripe.secret', value: 'sk', secret: true },
    ]);
    const runtime = { topology: 'control-plane', app: '', store };
    const ctx = ctxWith([change('set', 'a', 1), reveal('stripe.secret', 2)], runtime);
    const stats = configStatsProvider();
    expect(await stats.resolve({ metric: 'entries' }, ctx)).toEqual({ value: 2 });
    expect(await stats.resolve({ metric: 'secrets' }, ctx)).toEqual({ value: 1 });
    expect(await stats.resolve({ metric: 'apps' }, ctx)).toEqual({ value: 1 });
    expect(await stats.resolve({ metric: 'scopes' }, ctx)).toEqual({ value: 1 });
    expect(await stats.resolve({ metric: 'changes' }, ctx)).toEqual({ value: 1 });
    expect(await stats.resolve({ metric: 'reveals' }, ctx)).toEqual({ value: 1 });
    expect(await stats.resolve({ metric: 'unreadable' }, ctx)).toEqual({ value: 0 });
  });

  it('registers itself into the telescope binding once', async () => {
    const bindings = new Map<string, unknown>();
    const container = {
      hasBinding: (key: string) => bindings.has(key),
      bindValue: (key: string, value: unknown) => bindings.set(key, value),
      make: async (key: string) => bindings.get(key),
    };
    expect(await registerConfigTelescopeExtension(container)).toBe(true);
    expect(await registerConfigTelescopeExtension(container)).toBe(false);
    const list = bindings.get('agora.telescope.extensions') as TelescopeExtension[];
    expect(list.map((extension) => extension.name)).toEqual(['config']);

    const broken = {
      hasBinding: () => true,
      bindValue: () => {},
      make: async () => {
        throw new Error('nope');
      },
    };
    expect(await registerConfigTelescopeExtension(broken)).toBe(false);
  });

  it('emits diagnostics for writes, reveals, unsets and rollbacks without values', async () => {
    const emitted: Array<{ lib: string; event: string; payload: Record<string, unknown> }> = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: Record<string, unknown>,
    ) => {
      emitted.push({ lib, event, payload });
    };
    const store = memoryConfig();
    const admin = new ConfigAdmin({ store });
    await admin.setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', secret: true },
      { actor: 'ann' },
    );
    expect(emitted.at(-1)).toMatchObject({
      lib: 'config',
      event: 'entry.set',
      payload: { app: 'shop', key: 'stripe.secret', actor: 'ann', version: 1, secret: true },
    });
    expect(JSON.stringify(emitted)).not.toContain('sk_live_123');

    await admin.getEntry(testScope, 'stripe.secret', {
      canReadSecrets: true,
      reveal: { actor: 'ops' },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: 'entry.reveal',
      payload: { key: 'stripe.secret', actor: 'ops' },
    });

    await admin.unsetEntry(testScope, 'stripe.secret', { actor: 'ann' });
    expect(emitted.at(-1)).toMatchObject({
      event: 'entry.unset',
      payload: { key: 'stripe.secret', version: 2 },
    });

    await admin.setEntry(testScope, 'db.host', { value: 'localhost' }, { actor: 'ann' });
    await admin.rollback(testScope, 1, { actor: 'ann' });
    expect(emitted.at(-1)).toMatchObject({
      event: 'rollback',
      payload: { toVersion: 1, version: 4 },
    });

    // Every emitted event is one of the documented names.
    for (const item of emitted) expect(CONFIG_DIAGNOSTIC_EVENTS).toContain(item.event);
  });
});
