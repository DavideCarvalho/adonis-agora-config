import { describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { ConfigSync, type ConfigSyncChange, type ConfigSyncTarget } from '../../src/sync.js';
import { memoryConfig, testScope } from '../../src/testing/index.js';

function recorder(name = 'fake'): ConfigSyncTarget & { changes: ConfigSyncChange[] } {
  const changes: ConfigSyncChange[] = [];
  return {
    name,
    changes,
    async apply(change) {
      changes.push(change);
    },
  };
}

function setup(options: { keep?: string[]; debounceMs?: number } = {}) {
  const target = recorder();
  let sync: ConfigSync | undefined;
  const admin = new ConfigAdmin({
    store: memoryConfig(),
    onChange: (scope, version) => sync?.notify(scope, version),
  });
  sync = new ConfigSync(admin, {
    environment: 'production',
    debounceMs: options.debounceMs ?? 5,
    rules: [{ app: 'shop', target, ...(options.keep ? { keep: options.keep } : {}) }],
  });
  const set = (key: string, value: unknown, secret = false) =>
    admin.setEntry(testScope, key, { value: value as never, secret }, { actor: 'test' });
  return { admin, sync, target, set };
}

describe('ConfigSync', () => {
  it('a full push sends every variable as env names, secrets flagged, keep left out', async () => {
    const { sync, target, set } = setup({ keep: ['CONFIG_URL'] });
    await set('resend.api.key', 're_123', true);
    await set('mail.from', 'noreply@example.com');
    await set('config.url', 'http://elsewhere');
    await set('checkout.timeoutMs', 3000);
    await sync.flush();
    target.changes.length = 0;

    const [result] = await sync.syncAll();
    expect(result?.error).toBeUndefined();
    expect(target.changes).toHaveLength(1);
    const change = target.changes[0] as ConfigSyncChange;
    expect(change.mode).toBe('full');
    expect(change.remove).toEqual([]);
    expect(change.set).toEqual({
      RESEND_API_KEY: { value: 're_123', secret: true },
      MAIL_FROM: { value: 'noreply@example.com', secret: false },
      CHECKOUT_TIMEOUT_MS: { value: '3000', secret: false },
    });
  });

  it('a burst of writes becomes one delta; an unset key is removed', async () => {
    const { admin, sync, target, set } = setup({ debounceMs: 20 });
    await set('a.b', '1');
    await set('c.d', '2');
    await sync.flush();
    expect(target.changes).toHaveLength(0); // flush cancels a pending debounce

    await sync.syncAll();
    target.changes.length = 0;

    await set('a.b', '10');
    await admin.unsetEntry(testScope, 'c.d', { actor: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await sync.flush();
    expect(target.changes).toHaveLength(1);
    expect(target.changes[0]).toMatchObject({
      mode: 'delta',
      set: { A_B: { value: '10', secret: false } },
      remove: ['C_D'],
    });
  });

  it('scopes without a rule are not pushed', async () => {
    const { sync, target } = setup();
    sync.notify({ ...testScope, app: 'other' }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sync.flush();
    expect(target.changes).toEqual([]);
  });

  it('a failing target is reported by syncAll and never throws from notify', async () => {
    const admin = new ConfigAdmin({ store: memoryConfig() });
    await admin.setEntry(testScope, 'x.y', { value: '1' }, { actor: 'test' });
    const failing: ConfigSyncTarget = {
      name: 'broken',
      apply: async () => {
        throw new Error('platform down');
      },
    };
    const sync = new ConfigSync(admin, {
      environment: 'production',
      debounceMs: 1,
      rules: [{ app: 'shop', target: failing }],
    });
    const [result] = await sync.syncAll();
    expect(result?.error).toBe('platform down');
    sync.notify(testScope, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(sync.flush()).resolves.toBeUndefined();
  });

  it('an app with no configuration yet pushes nothing', async () => {
    const { sync, target } = setup();
    const [result] = await sync.syncAll();
    expect(result?.change).toBeNull();
    expect(target.changes).toEqual([]);
  });
});
