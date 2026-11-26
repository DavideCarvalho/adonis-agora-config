import { describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { generateKeyPair, sealTo } from '../../src/crypto-kit/index.js';
import { normalizeConsoleAuthorizeResult } from '../../src/dashboard/console_authorize.js';
import { resolveConsoleConfig } from '../../src/dashboard/define_config.js';
import {
  configConsoleCommandHandler,
  consoleCommandKeys,
  FederatedConfigApp,
  readOnlyConfigStore,
  UNSUPPORTED,
  validateFederatedConfigApp,
  writeAad,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { redactEntry } from '../../src/store/store.js';
import { testSecretCodec } from '../../src/testing/index.js';
import { RedisBus } from '../support/redis_bus.js';

const scope = { app: 'et', environment: 'production', label: 'main' };
const keys = consoleCommandKeys('owning-app-key-0123456789', 'et');

async function owner(options: { actions?: boolean; reveal?: boolean; partitions?: string[] } = {}) {
  const store = new MemoryStore({ secretCodec: testSecretCodec() });
  const admin = new ConfigAdmin({ store });
  await admin.setEntry(scope, 'api.token', { value: 'tok-123', secret: true }, { actor: 'seed' });
  const handler = configConsoleCommandHandler({
    admin,
    prefix: 'et',
    actions: options.actions ?? true,
    reveal: options.reveal ?? true,
    partitions: options.partitions ?? ['et'],
    keys,
  });
  return { store, admin, handler };
}

const command = (verb: string, args: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  verb,
  args,
  actor: 'ana',
  ...extra,
});

describe('configConsoleCommandHandler', () => {
  it('refuses an unknown verb as unsupported', async () => {
    const { handler } = await owner();
    await expect(handler(command('exportEverything'))).rejects.toMatchObject({ code: UNSUPPORTED });
  });

  it('hands out the write key only with actions on', async () => {
    const write = { capabilities: ['config:write'] };
    expect(await (await owner()).handler(command('writeKey', [], write))).toEqual(keys.publicKey);
    expect(
      await (await owner({ actions: false })).handler(command('writeKey', [], write)),
    ).toBeNull();
    expect(keys.publicKey).not.toHaveProperty('d');
  });

  it('only touches the partitions it serves', async () => {
    const { handler } = await owner();
    await expect(
      handler(command('unsetEntry', [{ scope: { ...scope, app: 'other' }, key: 'a.b' }])),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('opens a write sealed to it for that entry only', async () => {
    const { handler, admin } = await owner();
    const sealed = sealTo(keys.publicKey, JSON.stringify({ value: 'v1' }), {
      aad: writeAad('et', scope, 'a.b'),
    });
    const write = { capabilities: ['config:write'] };
    await handler(command('setEntry', [{ scope, key: 'a.b', sealed }], write));
    expect((await admin.getEntry(scope, 'a.b', { canReadSecrets: false }))?.value).toBe('v1');
    // The same ciphertext replayed onto another key does not open.
    await expect(
      handler(command('setEntry', [{ scope, key: 'c.d', sealed }], write)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a command without the viewer capabilities, and changes without config:write', async () => {
    const { handler, admin } = await owner();
    const sealed = sealTo(keys.publicKey, JSON.stringify({ value: 'v1' }), {
      aad: writeAad('et', scope, 'a.b'),
    });
    const set = [{ scope, key: 'a.b', sealed }];
    await expect(handler(command('setEntry', set))).rejects.toMatchObject({ status: 403 });
    await expect(
      handler(command('setEntry', set, { capabilities: ['config:read', 'config:secrets:read'] })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      handler(command('unsetEntry', [{ scope, key: 'api.token' }], { capabilities: [] })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      handler(command('rollback', [{ scope, to: 1 }], { capabilities: ['config:read'] })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(handler(command('writeKey'))).rejects.toMatchObject({ status: 403 });
    expect(await admin.getEntry(scope, 'a.b', { canReadSecrets: false })).toBeNull();
  });

  it('reveals sealed to the requester, and only to config:secrets:read', async () => {
    const { handler } = await owner();
    const requester = generateKeyPair('x25519');
    const args = [{ scope, key: 'api.token', recipient: requester.publicKey }];
    await expect(handler(command('reveal', args))).rejects.toMatchObject({ status: 403 });
    await expect(
      handler(command('reveal', args, { capabilities: ['config:read'] })),
    ).rejects.toMatchObject({ status: 403 });
    const answer = (await handler(
      command('reveal', args, { capabilities: ['config:secrets:*'] }),
    )) as Record<string, unknown>;
    expect(answer.sealedValue).toMatch(/^agora:pk1:/);
    expect(JSON.stringify(answer)).not.toContain('tok-123');
    await expect(
      handler(
        command('reveal', [{ scope, key: 'api.token', recipient: requester.privateKey }], {
          capabilities: ['config:*'],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('the federated read side', () => {
  it('drops values and vault references of hidden entries', () => {
    expect(
      redactEntry({ value: 's', secret: true, reloadable: false, updatedAt: 'n', updatedBy: 'a' }),
    ).not.toHaveProperty('value');
    expect(
      redactEntry({
        vault: 'vault://x/y',
        secret: false,
        reloadable: false,
        updatedAt: 'n',
        updatedBy: 'a',
      }),
    ).toEqual({ secret: true, reloadable: false, updatedAt: 'n', updatedBy: 'a' });
    expect(
      redactEntry({
        value: 'plain',
        secret: false,
        reloadable: false,
        updatedAt: 'n',
        updatedBy: 'a',
      }),
    ).toHaveProperty('value', 'plain');
  });

  it('wraps any store read-only and redacted', async () => {
    const store = new MemoryStore({ secretCodec: testSecretCodec() });
    await new ConfigAdmin({ store }).setEntry(
      scope,
      'k.s',
      { value: 'x', secret: true },
      { actor: 'a' },
    );
    const reader = readOnlyConfigStore(store);
    expect((await reader.read(scope))?.entries['k.s']).not.toHaveProperty('value');
    const audit = await reader.listAudit(scope, { number: 1, size: 5 });
    expect(JSON.stringify(audit)).not.toContain('"x"');
    await expect(reader.write(scope, [], { actor: 'a', now: 'n' })).rejects.toThrow();
    await expect(reader.recordReveal(scope, 'k.s', 1, 'a')).rejects.toThrow();
  });

  it('a federated app refuses changes when its entry is read-only, before asking', async () => {
    const bus = new RedisBus();
    const app = new FederatedConfigApp({
      id: 'et',
      actions: false,
      store: new MemoryStore(),
      channel: new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }),
    });
    await expect(
      app.unsetEntry(scope, 'a.b', undefined, { actor: 'ana', capabilities: [] }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(bus.published).toEqual([]);
  });
});

describe('federatedApps config', () => {
  const redis = { names: ['main'], default: 'main' };
  const entry = { store: { connection: 'et' }, controlPlane: { prefix: 'et' } };

  it('accepts a complete entry and refuses broken ones at boot', () => {
    expect(() => validateFederatedConfigApp('et', entry, redis)).not.toThrow();
    expect(() => validateFederatedConfigApp('bad key', entry, redis)).toThrow(/key/);
    expect(() =>
      validateFederatedConfigApp('et', { ...entry, controlPlane: { prefix: '' } }, redis),
    ).toThrow(/prefix/);
    expect(() =>
      validateFederatedConfigApp(
        'et',
        { ...entry, controlPlane: { prefix: 'et', connection: 'nope' } },
        redis,
      ),
    ).toThrow(/not a connection/);
    expect(() => validateFederatedConfigApp('et', entry, undefined)).toThrow(/@adonisjs\/redis/);
    expect(() => validateFederatedConfigApp('et', { ...entry, timeoutMs: -1 }, redis)).toThrow(
      /timeoutMs/,
    );
  });

  it('requires the shared secret (web) for an entry that may act', () => {
    const web = { requireSecret: true };
    expect(() => validateFederatedConfigApp('et', entry, redis, web)).toThrow(
      /controlPlane\.secret/,
    );
    expect(() =>
      validateFederatedConfigApp(
        'et',
        { ...entry, controlPlane: { prefix: 'et', secret: 'short' } },
        redis,
        web,
      ),
    ).toThrow(/controlPlane\.secret/);
    expect(() =>
      validateFederatedConfigApp(
        'et',
        { ...entry, controlPlane: { prefix: 'et', secret: 'a-shared-secret-0123456789' } },
        redis,
        web,
      ),
    ).not.toThrow();
    expect(() =>
      validateFederatedConfigApp('et', { ...entry, actions: false }, redis, web),
    ).not.toThrow();
    // Ace never sends commands: no secret needed there.
    expect(() => validateFederatedConfigApp('et', entry, redis)).not.toThrow();
  });

  it('keeps federatedApps and appLabel in the resolved console config', () => {
    const resolved = resolveConsoleConfig(
      { federatedApps: { et: entry }, appLabel: 'Hub' },
      { environment: 'production' },
    );
    expect(resolved.federatedApps).toEqual({ et: entry });
    expect(resolved.appLabel).toBe('Hub');
  });

  it("keeps the authorizer's capabilities", () => {
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, capabilities: ['config:secrets:read', 1] }),
    ).toEqual({ allowed: true, capabilities: ['config:secrets:read'] });
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, apps: ['et'], capabilities: [] }),
    ).toEqual({ allowed: true, apps: ['et'], capabilities: [] });
  });
});
