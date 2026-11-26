import { describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import {
  commandKeyReader,
  configConsoleCommandHandler,
  consoleCommandKeys,
  consoleKeyOwner,
} from '../../src/federation/console.js';
import {
  type ConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { seedConfig, testScope, testSecretCodec } from '../../src/testing/index.js';
import type { TenantVerifier } from '../../src/topology/verify.js';
import { RedisBus } from '../support/redis_bus.js';

const PREFIX = 'shop';
const APP_KEY = 'app-key-of-the-shop-0123456789';

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-writer') {
    return { partition: 'shop', capabilities: ['config:read', 'config:write'], clientId: 'hub' };
  }
  if (token === 'hub-reader') {
    return { partition: 'shop', capabilities: ['config:read'], clientId: 'hub-ro' };
  }
  if (token === 'hub-other-app') {
    return { partition: 'billing', capabilities: ['config:*'], clientId: 'hub-billing' };
  }
  return null;
};

async function setup() {
  const bus = new RedisBus();
  const store = new MemoryStore({ secretCodec: testSecretCodec('fed') });
  await seedConfig(store, testScope, [
    ['db.host', 'db-1'],
    ['feature.x', 'on'],
  ]);
  const admin = new ConfigAdmin({ store, canRevealSecrets: true });
  const keys = consoleCommandKeys(APP_KEY, PREFIX);
  // What the provider does at boot: publish the public half in the app's own store.
  const { d: _d, ...publicKey } = keys.publicKey;
  await store.registerTenantKey({
    app: consoleKeyOwner(PREFIX),
    kid: keys.publicKey.kid,
    publicKey,
    active: true,
    createdAt: new Date(0).toISOString(),
    createdBy: 'config:console-commands',
  });
  const seen: ConsoleCommand[] = [];
  const handler = configConsoleCommandHandler({
    admin,
    prefix: PREFIX,
    actions: true,
    reveal: true,
    partitions: ['shop'],
    keys,
  });
  const errors: unknown[] = [];
  const app = new RedisConsoleChannel({
    client: bus.connection(),
    prefix: PREFIX,
    keys,
    verifyTenant,
  });
  await app.answer(
    async (command) => {
      seen.push(command);
      return handler(command);
    },
    { onError: (error) => errors.push(error) },
  );
  const consoleWith = (token: string, onReset?: () => void) =>
    new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: Object.assign(async () => token, { reset: () => onReset?.() }),
      // The console reads the key from the app's store (it already reads that store), not Redis.
      recipient: commandKeyReader(store, PREFIX),
    });
  return { bus, store, admin, seen, errors, consoleWith };
}

const unset = (key: string, actor = 'alice@hub') => ({
  id: crypto.randomUUID(),
  verb: 'unsetEntry',
  args: [{ scope: testScope, key }],
  actor,
  capabilities: ['config:read', 'config:write'],
});

describe('federated console, token mode (authkit)', () => {
  it('runs a command whose token the app verifies, with the token never readable on Redis', async () => {
    const { bus, store, seen, consoleWith } = await setup();
    const reply = await consoleWith('hub-writer').send(unset('feature.x'));
    expect(reply).toMatchObject({ ok: true });
    expect((await store.read(testScope))?.entries['feature.x']).toBeUndefined();
    expect(seen[0]?.verified).toEqual({
      partition: 'shop',
      capabilities: ['config:read', 'config:write'],
      clientId: 'hub',
    });
    // The command and its token cross Redis sealed: a reader learns neither.
    expect(bus.wire).not.toContain('hub-writer');
    expect(bus.wire).not.toContain('feature.x');
  });

  it('refuses an unknown token (and the console drops its cached token)', async () => {
    const { store, consoleWith } = await setup();
    let resets = 0;
    const reply = await consoleWith('stolen-or-made-up', () => {
      resets += 1;
    }).send(unset('feature.x'));
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(resets).toBe(1);
    expect((await store.read(testScope))?.entries['feature.x']).toBeDefined();
  });

  it('lets the token decide the app and the capabilities, whatever the message claims', async () => {
    const { consoleWith } = await setup();
    // A token for another app cannot act on this one.
    const other = await consoleWith('hub-other-app').send(unset('feature.x'));
    expect(other).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!other.ok && other.error.message).toMatch(/token is for "billing"/);
    // A read-only token cannot write, even if the message claims every capability.
    const reader = await consoleWith('hub-reader').send({
      ...unset('feature.x'),
      capabilities: ['*'],
    });
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!reader.ok && reader.error.message).toMatch(/lacks config:write/);
    // The viewer's capabilities only narrow the token's: no secrets:read for this reveal.
    const reveal = await consoleWith('hub-writer').send({
      id: crypto.randomUUID(),
      verb: 'reveal',
      args: [
        {
          scope: testScope,
          key: 'db.host',
          recipient: { kty: 'OKP', crv: 'X25519', x: 'x', kid: 'k' },
        },
      ],
      capabilities: ['config:*'],
    });
    expect(reveal).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('refuses unsealed, tampered and replayed commands', async () => {
    const { bus, store, seen, errors, consoleWith } = await setup();
    const raw = bus.connection();
    // Someone with Redis access publishes a plain command claiming to be a console.
    await raw.publish(
      'shop-config-console',
      JSON.stringify({
        ...unset('feature.x'),
        capabilities: ['*'],
        verified: { partition: 'shop', capabilities: ['*'] },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });

    // A real command, then a bit-flipped copy and a straight replay of it.
    await consoleWith('hub-writer').send(unset('db.host'));
    const sent = bus.published.find(
      (p) => p.channel === 'shop-config-console' && p.message.includes('sealed'),
    )!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    await raw.publish(
      'shop-config-console',
      JSON.stringify({ id: crypto.randomUUID(), sealed: wire.sealed }),
    );
    await raw.publish('shop-config-console', JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish('shop-config-console', sent.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
    expect((await store.read(testScope))?.entries['feature.x']).toBeDefined();
  });

  it('ignores a forged answer and waits for the app', async () => {
    const { bus, consoleWith } = await setup();
    const raw = bus.connection();
    await raw.subscribe('shop-config-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(
        'shop-config-console-reply',
        JSON.stringify({
          id,
          ok: true,
          data: { kty: 'OKP', crv: 'X25519', x: 'attacker', kid: 'evil' },
        }),
      );
    });
    const reply = await consoleWith('hub-writer').send({
      id: crypto.randomUUID(),
      verb: 'writeKey',
      args: [],
    });
    expect(reply.ok && (reply.data as { kid: string }).kid).not.toBe('evil');
    expect(reply.ok && (reply.data as { x: string }).x).not.toBe('attacker');
  });

  it('the console refuses to send when the app has not published its key', async () => {
    const bus = new RedisBus();
    const empty = new MemoryStore();
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: 'hub-writer',
      recipient: commandKeyReader(empty, PREFIX),
    });
    await expect(channel.send(unset('feature.x'), { timeoutMs: 100 })).rejects.toThrow(
      /has not published its console-command key/,
    );
  });
});
