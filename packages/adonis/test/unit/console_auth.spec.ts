import { describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { configConsoleCommandHandler } from '../../src/federation/console.js';
import {
  ConsoleAuthConfigError,
  resolveAppConsoleAuth,
  resolveFederatedAppAuth,
} from '../../src/federation/console_auth.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { seedConfig, testScope, testSecretCodec } from '../../src/testing/index.js';
import { FakeAuthkit, FakeCryptoServer } from '../support/fake_siblings.js';
import { RedisBus } from '../support/redis_bus.js';

const siblings = () => {
  const authkit = new FakeAuthkit();
  return {
    crypto: new FakeCryptoServer().embedded('hub'),
    authkit: authkit.client('hub'),
  };
};

describe('resolving the app side', () => {
  it('auto crypto plus an optional authkit token when nothing is set', () => {
    const auth = resolveAppConsoleAuth({ options: {}, hasAppKey: true, siblings: siblings() });
    expect(auth.autoCrypto).toBe(true);
    expect(auth.cryptoToken).toBe('optional');
    expect(auth.tokenMode).toBe(true);
    expect(auth.modes).toEqual([
      'crypto (auto, key console-config)',
      'token checked when sent (authkit app-call, auto)',
      'token (authkit app-call, auto; sealed to key (derived from APP_KEY))',
    ]);
  });

  it('explicit crypto + verifyTenant require the token; explicit options add no auto crypto', () => {
    const cipher = new FakeCryptoServer().embedded('x').operations;
    const strict = resolveAppConsoleAuth({
      options: { crypto: { cipher }, verifyTenant: () => null },
      hasAppKey: true,
      siblings: siblings(),
    });
    expect(strict.cryptoToken).toBe('required');
    expect(strict.verifyAppCall).toBeUndefined();
    const secret = resolveAppConsoleAuth({
      options: { secret: 'a-shared-secret-of-16+' },
      hasAppKey: true,
      siblings: { crypto: siblings().crypto },
    });
    expect(secret.crypto).toBeUndefined();
    expect(secret.modes).toEqual(['secret']);
  });

  it('`verifyTenant: false` turns the authkit verifier and the control plane fallback off', () => {
    const auth = resolveAppConsoleAuth({
      options: { verifyTenant: false, secret: 'a-shared-secret-of-16+' },
      fallbackVerifyTenant: () => null,
      hasAppKey: true,
      siblings: { authkit: siblings().authkit },
    });
    expect(auth.verifyAppCall).toBeUndefined();
    expect(auth.verifyTenant).toBeUndefined();
    expect(auth.tokenMode).toBe(false);
  });

  it('throws a ConsoleAuthConfigError naming the three options', () => {
    expect(() => resolveAppConsoleAuth({ options: {}, hasAppKey: true })).toThrow(
      ConsoleAuthConfigError,
    );
  });
});

describe('resolving the console side', () => {
  it('`token: false` and `crypto: false` switch each automatic piece off', () => {
    const both = resolveFederatedAppAuth({
      id: 'shop',
      partition: 'shop',
      actions: true,
      controlPlane: {},
      siblings: siblings(),
    });
    expect(both.modes).toEqual([
      "auto (the app's published key if it publishes one, else crypto (auto, key console-config, partition shop))",
    ]);
    expect(both.autoChoice).toBe(true);
    const noToken = resolveFederatedAppAuth({
      id: 'shop',
      partition: 'shop',
      actions: true,
      controlPlane: { token: false },
      siblings: siblings(),
    });
    expect(noToken.token).toBeUndefined();
    const tokenOnly = resolveFederatedAppAuth({
      id: 'shop',
      partition: 'shop',
      actions: true,
      controlPlane: { crypto: false },
      siblings: siblings(),
    });
    expect(tokenOnly.crypto).toBeUndefined();
    expect(tokenOnly.modes).toEqual([
      "token (authkit app-call, auto; sealed to the app's published key)",
    ]);
    expect(() =>
      resolveFederatedAppAuth({
        id: 'shop',
        partition: 'shop',
        actions: true,
        controlPlane: { crypto: false, token: false },
        siblings: siblings(),
      }),
    ).toThrow(
      /actions: false to only browse it\. Run `node ace agora:doctor`.*Note: `crypto: false`.*`token: false`/s,
    );
  });

  it('an explicit token is used as given, with your own function', async () => {
    const auth = resolveFederatedAppAuth({
      id: 'shop',
      partition: 'shop',
      actions: true,
      controlPlane: { token: async () => 'my-own-jwt' },
      siblings: { authkit: siblings().authkit },
    });
    expect(await (auth.token as () => Promise<string>)()).toBe('my-own-jwt');
  });
});

describe('bring your own cipher', () => {
  it('a KMS-like cipher with its own ciphertext format, recognised through `owns`', async () => {
    const bus = new RedisBus();
    const store = new MemoryStore({ secretCodec: testSecretCodec('byo') });
    await seedConfig(store, testScope, [['feature.x', 'on']]);
    // A toy "KMS": base64 under a prefix of its own, not agora:ct1:.
    const kms = {
      encrypt: async ({ plaintext, aad }: { plaintext: string; aad?: string }) => ({
        ciphertext: `kms:v1:${Buffer.from(JSON.stringify([aad, plaintext])).toString('base64url')}`,
      }),
      decrypt: async ({ ciphertext, aad }: { ciphertext: string; aad?: string }) => {
        const [boundTo, plaintext] = JSON.parse(
          Buffer.from(ciphertext.slice(7), 'base64url').toString(),
        ) as [string, string];
        if (boundTo !== aad) throw new Error('aad mismatch');
        return { plaintext };
      },
    };
    const crypto = { cipher: kms, key: 'my-kms-key', owns: (c: string) => c.startsWith('kms:v1:') };
    const app = new RedisConsoleChannel({ client: bus.connection(), prefix: 'shop', crypto });
    await app.answer(
      configConsoleCommandHandler({
        admin: new ConfigAdmin({ store }),
        prefix: 'shop',
        actions: true,
        reveal: false,
        partitions: ['shop'],
      }),
    );
    const console = new RedisConsoleChannel({ client: bus.connection(), prefix: 'shop', crypto });
    const reply = await console.send({
      id: crypto.key + Date.now(),
      verb: 'unsetEntry',
      args: [{ scope: testScope, key: 'feature.x' }],
      capabilities: ['config:write'],
    });
    expect(reply).toMatchObject({ ok: true });
    expect((await store.read(testScope))?.entries['feature.x']).toBeUndefined();
  });
});

describe('console capabilities (canonical details)', () => {
  it('config:console:* aliases allow every command, on the viewer and on the token', async () => {
    const store = new MemoryStore({ secretCodec: testSecretCodec('alias') });
    await seedConfig(store, testScope, [['feature.x', 'on']]);
    const handler = configConsoleCommandHandler({
      admin: new ConfigAdmin({ store }),
      prefix: 'shop',
      actions: true,
      reveal: true,
      partitions: ['shop'],
    });
    const unset = (extra: Record<string, unknown>) =>
      handler({
        id: 'c',
        verb: 'unsetEntry',
        args: [{ scope: testScope, key: 'feature.x' }],
        ...extra,
      } as never);
    // A token granted only config:console:read: "the console's token lacks".
    await expect(
      unset({
        capabilities: ['config:console:*'],
        verified: { partition: 'shop', capabilities: ['config:console:read'] },
      }),
    ).rejects.toMatchObject({ status: 403, message: "the console's token lacks config:write" });
    // A token with config:console:* and a read-only viewer: "the viewer lacks".
    await expect(
      unset({
        capabilities: ['config:console:read'],
        verified: { partition: 'shop', capabilities: ['config:console:*'] },
      }),
    ).rejects.toMatchObject({ status: 403, message: 'the viewer lacks config:write' });
    await unset({
      capabilities: ['config:console:*'],
      verified: { partition: 'shop', capabilities: ['config:console:*'] },
    });
    expect((await store.read(testScope))?.entries['feature.x']).toBeUndefined();
  });

  it('the console narrows the viewer to config’s console set; the full set when authorize says none', async () => {
    const { viewerConsoleCapabilities, CONFIG_CONSOLE_CAPABILITIES } = await import(
      '../../src/federation/console.js'
    );
    expect(viewerConsoleCapabilities(undefined)).toEqual([...CONFIG_CONSOLE_CAPABILITIES]);
    expect(
      viewerConsoleCapabilities(['flags:write', 'config:console:write', 'config:secrets:*', '*']),
    ).toEqual(['config:console:write', 'config:secrets:*', '*']);
    expect(viewerConsoleCapabilities(['flags:*'])).toEqual([]);
    // access: 'read' drops every write, whatever the capabilities say.
    expect(viewerConsoleCapabilities(['config:*'], 'read')).toEqual([
      'config:read',
      'config:secrets:read',
    ]);
    expect(viewerConsoleCapabilities(undefined, 'read')).toEqual([
      'config:read',
      'config:secrets:read',
    ]);
  });

  it('console_authorize: one shape, fail-closed capabilities, anyAuthorize keeps the grant', async () => {
    const { normalizeConsoleAuthorizeResult, anyAuthorize } = await import(
      '../../src/dashboard/console_authorize.js'
    );
    expect(
      normalizeConsoleAuthorizeResult({
        allowed: true,
        apps: ['a', 'a'],
        tenants: '*',
        capabilities: ['config:read', 3, ''],
        access: 'read',
      }),
    ).toEqual({
      allowed: true,
      apps: ['a'],
      tenants: '*',
      capabilities: ['config:read'],
      access: 'read',
    });
    // Malformed capabilities allow nothing (not "everything"); an unknown access is dropped.
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, capabilities: 'config:*', access: 'all' }),
    ).toEqual({ allowed: true, capabilities: [] });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, tenants: 'x' })).toEqual({
      allowed: true,
      tenants: [],
    });
    const any = anyAuthorize(
      () => ({ allowed: false, reason: 'unauthenticated' }),
      () => ({
        allowed: true,
        apps: ['shop'],
        tenants: ['t1'],
        capabilities: ['config:console:read'],
        access: 'read',
      }),
    );
    expect(await any({} as never)).toEqual({
      allowed: true,
      apps: ['shop'],
      tenants: ['t1'],
      capabilities: ['config:console:read'],
      access: 'read',
    });
  });
});

describe('authorizeByToken (canonical template)', () => {
  const ctx = (header?: string) => ({ request: { header: () => header } }) as never;

  it('grants what its options say, normalized fail-closed, and nothing without the token', async () => {
    const { authorizeByToken } = await import('../../src/dashboard/console_authorize.js');
    const plain = authorizeByToken({ token: 'tok-123' }) as (c: unknown) => unknown;
    expect(plain(ctx('Bearer tok-123'))).toEqual({ allowed: true });
    const narrowed = authorizeByToken({
      token: 'tok-123',
      apps: ['shop', 'shop'],
      tenants: '*',
      capabilities: ['config:console:read', 7 as never],
      access: 'read',
    }) as (c: unknown) => unknown;
    expect(narrowed(ctx('Bearer tok-123'))).toEqual({
      allowed: true,
      apps: ['shop'],
      tenants: '*',
      capabilities: ['config:console:read'],
      access: 'read',
    });
    expect(narrowed(ctx('Bearer nope'))).toEqual({ allowed: false, reason: 'unauthenticated' });
    const malformed = authorizeByToken({
      token: 'tok-123',
      apps: 'shop' as never,
      capabilities: 'config:*' as never,
    }) as (c: unknown) => unknown;
    expect(malformed(ctx('Bearer tok-123'))).toEqual({ allowed: true, apps: [], capabilities: [] });
  });
});

describe('classifying a console key check', () => {
  it('only "not found" is missing; refusals and outages are named; a bad ciphertext means usable', async () => {
    const { classifyConsoleKeyError } = await import('../../src/federation/console_auth.js');
    const coded = (code: string) => Object.assign(new Error('x'), { code });
    expect(classifyConsoleKeyError(coded('not_found'))).toBe('missing');
    expect(classifyConsoleKeyError(new Error('crypto: no key named "console-config"'))).toBe(
      'missing',
    );
    expect(classifyConsoleKeyError(coded('invalid'))).toBe('usable');
    expect(classifyConsoleKeyError(coded('unreadable'))).toBe('usable');
    expect(
      classifyConsoleKeyError(new Error('Unsupported state or unable to authenticate data')),
    ).toBe('usable');
    expect(classifyConsoleKeyError(coded('forbidden'))).toBe('refused');
    expect(classifyConsoleKeyError(coded('unauthenticated'))).toBe('refused');
    expect(classifyConsoleKeyError(new Error('crypto: the token lacks crypto:decrypt:x'))).toBe(
      'refused',
    );
    expect(classifyConsoleKeyError(new Error('connect ECONNREFUSED'))).toBe('unreachable');
    expect(
      classifyConsoleKeyError(Object.assign(new Error('timed out'), { code: 'timeout' })),
    ).toBe('unreachable');
  });
});

describe('replays (§11b)', () => {
  it('only the instance that ran a command logs its replay; another instance losing the claim is silent', async () => {
    const bus = new RedisBus();
    const store = new MemoryStore({ secretCodec: testSecretCodec('replay') });
    await seedConfig(store, testScope, [['feature.x', 'on']]);
    const handler = configConsoleCommandHandler({
      admin: new ConfigAdmin({ store }),
      prefix: 'shop',
      actions: true,
      reveal: false,
      partitions: ['shop'],
    });
    const secret = 'a-shared-secret-of-16+';
    const ran: string[] = [];
    const errors: Record<'a' | 'b', unknown[]> = { a: [], b: [] };
    for (const name of ['a', 'b'] as const) {
      const instance = new RedisConsoleChannel({
        client: bus.connection(),
        prefix: 'shop',
        secret,
      });
      await instance.answer(
        async (command) => {
          ran.push(name);
          return handler(command);
        },
        { onError: (error) => errors[name].push(error) },
      );
    }
    const console = new RedisConsoleChannel({ client: bus.connection(), prefix: 'shop', secret });
    const reply = await console.send({
      id: crypto.randomUUID(),
      verb: 'unsetEntry',
      args: [{ scope: testScope, key: 'feature.x' }],
      capabilities: ['config:write'],
    });
    expect(reply).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // First delivery: one instance ran it, the other lost the claim and said nothing.
    expect(ran).toHaveLength(1);
    expect([...errors.a, ...errors.b]).toEqual([]);

    // The same signed command delivered again (inside the freshness minute).
    const sent = bus.published.find((p) => p.channel === 'shop-config-console')!;
    await bus.connection().publish('shop-config-console', sent.message);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const winner = ran[0] as 'a' | 'b';
    const loser = winner === 'a' ? 'b' : 'a';
    expect(ran).toHaveLength(1);
    expect(errors[winner]).toEqual([expect.objectContaining({ message: 'replayed' })]);
    expect(errors[loser]).toEqual([]);
  });
});

describe('the key check with hasKey (§13f)', () => {
  it('forbidden is "refused"; any other throw falls back to the decrypt probe', async () => {
    const { checkTenantConsoleKey } = await import('../../src/federation/console_auth.js');
    const server = new FakeCryptoServer();
    const tenant = server.tenant('shop', []);
    tenant.operations.hasKey = async () => {
      throw Object.assign(new Error('crypto: the token lacks crypto:decrypt:x'), {
        code: 'forbidden',
      });
    };
    expect(await checkTenantConsoleKey(tenant)).toMatchObject({
      level: 'warn',
      line: expect.stringContaining('refused this app'),
    });
    // An older server: no such route. The decrypt probe answers instead (here: missing → info).
    tenant.operations.hasKey = async () => {
      throw new Error('crypto: POST /v1/keys/has answered 404');
    };
    expect(await checkTenantConsoleKey(tenant)).toMatchObject({
      level: 'info',
      line: expect.stringContaining('does not exist in partition shop yet'),
    });
    expect(server.audit.some((a) => a.op === 'decrypt')).toBe(false);
  });
});

describe('the per-app mode choice (§13a)', () => {
  it('is cached, and decided again after any failed send', async () => {
    const { AutoModeChannel } = await import('../../src/federation/console.js');
    const sent: string[] = [];
    let tokenFails = false;
    const fake = (name: string, fail: () => boolean) =>
      ({
        prefix: 'shop',
        send: async () => {
          sent.push(name);
          if (fail()) throw new Error('no instance of "shop" answered within 0.5s');
          return { id: 'x', ok: true, data: null };
        },
        close: async () => {},
      }) as never;
    let published = true;
    let asked = 0;
    const channel = new AutoModeChannel(
      fake('token', () => tokenFails),
      fake('crypto', () => false),
      async () => {
        asked += 1;
        if (!published) throw new Error('not published');
      },
    );
    const command = { id: 'c', verb: 'unsetEntry', args: [] };
    await channel.send(command);
    await channel.send(command);
    expect(sent).toEqual(['token', 'token']);
    expect(asked).toBe(1);
    // The app moved to crypto (it no longer publishes): the next token command fails, and the
    // following one is decided again.
    tokenFails = true;
    published = false;
    await expect(channel.send(command)).rejects.toThrow(/answered/);
    await channel.send(command);
    expect(sent).toEqual(['token', 'token', 'token', 'crypto']);
    expect(asked).toBe(2);
  });
});

describe('a missing grant (§13b: info, not warn)', () => {
  it('is code invalid_target, or invalid_target / "not granted" / "no grant" in the message; nothing else', async () => {
    const { isMissingGrant } = await import('../../src/federation/console.js');
    const coded = (code: string) => Object.assign(new Error('x'), { code });
    expect(isMissingGrant(coded('invalid_target'), 'authkit refused the token')).toBe(true);
    expect(isMissingGrant(undefined, 'the app "shop" is not granted to "hub"')).toBe(true);
    expect(isMissingGrant(undefined, 'No grant for shop')).toBe(true);
    expect(isMissingGrant(coded('unauthorized_client'), 'unauthorized_client')).toBe(false);
    expect(isMissingGrant(coded('invalid_client'), 'invalid_client')).toBe(false);
    expect(
      isMissingGrant(undefined, 'authkit answered 400: invalid_target (urn:agora:app:shop)'),
    ).toBe(true);
    expect(isMissingGrant(new Error('ECONNREFUSED'), 'ECONNREFUSED')).toBe(false);
  });
});
