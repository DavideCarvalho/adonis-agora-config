import type { Server } from 'node:http';
import {
  assertScopeName,
  etagOf,
  fingerprintOf,
  isValidScopeName,
  parseVaultReference,
} from '@adonis-agora/config-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { withFingerprintKey } from '../../src/crypto/secrets.js';
import { scopedVaultResolver } from '../../src/define_config.js';
import { configDevTools } from '../../src/dev_tools.js';
import { dotenvValue, shellQuote, upsertConfigBlock } from '../../src/env_file.js';
import {
  type ConsoleCommand,
  RedisConsoleChannel,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import {
  ControlPlane,
  knownTenants,
  MAX_TENANT_PRESENCE,
  resetKnownTenants,
} from '../../src/http/control_plane.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { DocumentSealer } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope, testSecretCodec } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';
import { RedisBus } from '../support/redis_bus.js';

const servers: Server[] = [];

afterEach(async () => {
  resetKnownTenants();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function controlPlane() {
  const store = memoryConfig();
  await seedConfig(store, testScope, [['db.host', 'localhost']]);
  const plane = new ControlPlane({
    store,
    verifyTenant: sharedSecretVerifier({
      partitions: {
        shop: { secret: 'shop-secret', capabilities: ['config:read', 'config:secrets:read'] },
        reader: { secret: 'read-only', capabilities: ['config:read'] },
      },
    }),
    environment: 'production',
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  plane.register({
    get(pattern, handler) {
      routes.push({ method: 'GET', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
    route(pattern, methods, handler) {
      for (const method of methods) routes.push({ method, pattern, handler: handler as Handler });
      return {};
    },
  });
  const server = await serve(routes);
  servers.push(server);
  return { base: `${addressOf(server)}/_config`, store };
}

const as = (token: string, app: string) => ({
  authorization: `Bearer ${token}`,
  'x-config-app': app,
});

describe('label validation (a label reaches the ETag header)', () => {
  it('accepts plain and branch-like names, refuses control, non-latin1 and long ones', () => {
    for (const ok of ['main', 'release/1.2', 'v1.0.0+build', 'team:a', 'x@y']) {
      expect(isValidScopeName(ok)).toBe(true);
    }
    for (const bad of ['', '\u0001', 'a b', '日本語', 'a"b', 'a\\b', 'x'.repeat(129), 'a\r\nb']) {
      expect(isValidScopeName(bad)).toBe(false);
    }
    expect(() => assertScopeName('\u0001')).toThrow(/invalid label/);
  });

  it('percent-encodes every ETag part, so the header is always ASCII', () => {
    expect(etagOf('shop', 'production', 'main', 3)).toBe('"shop:production:main:3"');
    const etag = etagOf('shop', 'production', '\u0001日本"', 1);
    expect(etag).toMatch(/^"[\x21-\x7e]+"$/);
  });

  it('answers 400 to a bad ?label= instead of taking the process down', async () => {
    const { base } = await controlPlane();
    for (const label of ['%01', encodeURIComponent('日本語'), '%0d%0aX-Injected:1']) {
      const response = await fetch(`${base}/v1/config?label=${label}`, {
        headers: as('shop-secret', 'shop'),
      });
      expect(response.status).toBe(400);
    }
    const ok = await fetch(`${base}/v1/config?label=main`, { headers: as('shop-secret', 'shop') });
    expect(ok.status).toBe(200);
  });
});

describe('tenant key and sealed endpoints need config:secrets:read', () => {
  it('refuses a read-only token on PUT /v1/keys and POST /v1/sealed', async () => {
    const { base } = await controlPlane();
    const keys = await fetch(`${base}/v1/keys`, {
      method: 'PUT',
      headers: { ...as('read-only', 'reader'), 'content-type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    expect(keys.status).toBe(403);
    expect(await keys.json()).toEqual({
      error: 'token lacks the config:secrets:read capability',
    });
    const sealed = await fetch(`${base}/v1/sealed`, {
      method: 'POST',
      headers: { ...as('read-only', 'reader'), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, entries: [{ key: 'a', value: 'b', kid: 'k' }] }),
    });
    expect(sealed.status).toBe(403);
  });
});

describe('tenant presence is bounded', () => {
  it(`keeps at most ${MAX_TENANT_PRESENCE} rows, dropping the oldest`, async () => {
    const { base } = await controlPlane();
    const extra = 5;
    for (let i = 0; i < MAX_TENANT_PRESENCE + extra; i += 1) {
      await fetch(`${base}/v1/config?label=l${i}`, { headers: as('shop-secret', 'shop') });
    }
    const rows = knownTenants();
    expect(rows).toHaveLength(MAX_TENANT_PRESENCE);
    expect(rows.some((row) => row.label === 'l0')).toBe(false);
    expect(rows.some((row) => row.label === `l${MAX_TENANT_PRESENCE + extra - 1}`)).toBe(true);
  }, 60_000);
});

describe('fingerprints do not hash secrets without a key', () => {
  const pin = (value: string) => ({
    pin: { value, secret: true, reloadable: false },
  });

  it('keys the secret part when a digest is given', () => {
    const codec = withFingerprintKey(testSecretCodec('k'), 'app-key-0123456789abcdef');
    const digest = (value: unknown) => codec.digest!(value as never);
    // Without the key, the fingerprint of a guess matches: an offline oracle.
    expect(fingerprintOf(pin('1234'))).toBe(fingerprintOf(pin('1234')));
    const keyed = fingerprintOf(pin('1234'), { secretDigest: digest });
    expect(keyed).not.toBe(fingerprintOf(pin('1234')));
    // Stable for the same key (no-op detection), different for another key.
    expect(fingerprintOf(pin('1234'), { secretDigest: digest })).toBe(keyed);
    const other = withFingerprintKey(testSecretCodec('k'), 'another-app-key-0123456789');
    expect(fingerprintOf(pin('1234'), { secretDigest: (v) => other.digest!(v) })).not.toBe(keyed);
  });

  it('a store with a keyed codec still sees a repeated write as a no-op', async () => {
    const store = new MemoryStore({
      secretCodec: withFingerprintKey(testSecretCodec('k'), 'app-key-0123456789abcdef'),
    });
    const context = { actor: 't', now: new Date(0).toISOString() };
    const first = await store.write(
      testScope,
      [{ key: 'pin', value: '1234', secret: true }],
      context,
    );
    expect(first.document.fingerprint).not.toBe(fingerprintOf(pin('1234')));
    const again = await store.write(
      testScope,
      [{ key: 'pin', value: '1234', secret: true }],
      context,
    );
    expect(again.changed).toBe(false);
  });
});

describe('MCP read tools never return secret plaintext', () => {
  it('masks secrets in list_entries, get_version and diff_versions', async () => {
    const store = new MemoryStore({ secretCodec: testSecretCodec('mcp') });
    const admin = new ConfigAdmin({ store, canRevealSecrets: true });
    await seedConfig(store, testScope, [{ key: 'stripe.secret', value: 'sk_old', secret: true }]);
    await seedConfig(store, testScope, [{ key: 'stripe.secret', value: 'sk_new', secret: true }]);
    const tools = configDevTools(admin, { actorFor: () => 'mcp:t' });
    const run = (name: string, input: Record<string, unknown>) =>
      tools
        .find((tool) => tool.name === name)!
        .run(input, {
          ctx: {} as never,
          caller: { id: 'c', via: 'token' as const },
          limits: { maxRows: 100, maxBytes: 48_000 },
        });
    const out = JSON.stringify([
      await run('config_list_entries', { app: 'shop' }),
      await run('config_get_version', { app: 'shop', version: 1 }),
      await run('config_diff_versions', { app: 'shop', from: 1, to: 2 }),
    ]);
    expect(out).not.toContain('sk_old');
    expect(out).not.toContain('sk_new');
    // The audited path still reveals (and writes the reveal row).
    const entry = await run('config_get_entry', { app: 'shop', key: 'stripe.secret' });
    expect(JSON.stringify(entry)).toContain('sk_new');
    const audit = (await run('config_list_audit', { app: 'shop', action: 'reveal' })) as {
      total: number;
    };
    expect(audit.total).toBe(1);
  });
});

describe('config:pull output', () => {
  it('shell-quotes anything a shell would interpret', () => {
    expect(shellQuote('db-1.internal:5432')).toBe('db-1.internal:5432');
    expect(shellQuote('x; touch /tmp/pwned')).toBe("'x; touch /tmp/pwned'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('never writes a line break or an invalid name into the .env block', () => {
    expect(dotenvValue('a\nNODE_OPTIONS=--require /tmp/x.js')).toBeUndefined();
    expect(dotenvValue('cost $5')).toBe('cost \\$5');
    const result = upsertConfigBlock('', {
      DB_HOST: 'db-1',
      EVIL: 'x\nAPP_KEY=attacker',
      'BAD-NAME': 'v',
    });
    expect(result.added).toEqual(['DB_HOST']);
    expect(result.rejected.sort()).toEqual(['BAD-NAME', 'EVIL']);
    expect(result.content).not.toContain('APP_KEY');
  });
});

describe('vault references are resolved for the entry’s own app', () => {
  it('passes the scope to the resolver and enforces `allow`', async () => {
    const seen: string[] = [];
    const resolver = scopedVaultResolver({
      resolve: (reference, context) => {
        seen.push(`${context.scope.app}:${reference.path}`);
        return 'resolved';
      },
      allow: (reference, scope) => reference.path.startsWith(`${scope.app}/`),
    });
    expect(
      await resolver(parseVaultReference('vault://aws/shop/db#password'), { scope: testScope }),
    ).toBe('resolved');
    await expect(
      resolver(parseVaultReference('vault://aws/billing/db#password'), { scope: testScope }),
    ).rejects.toThrow(/not allowed for shop/);
    expect(seen).toEqual(['shop:shop/db']);

    // Through the admin (console, MCP, federation): a refused reference stays masked.
    const store = new MemoryStore({ secretCodec: testSecretCodec('v') });
    const admin = new ConfigAdmin({ store, canRevealSecrets: true, vault: resolver });
    await seedConfig(store, testScope, [
      { key: 'other', vault: 'vault://aws/billing/db#password' },
    ]);
    const entry = await admin.getEntry(testScope, 'other', { canReadSecrets: true });
    // The reference itself may show; the value behind it never does.
    expect(entry?.value).not.toBe('resolved');
    expect(JSON.stringify(entry)).not.toContain('"resolved"');
  });
});

describe('federated console channel is authenticated', () => {
  const SECRET = 'federation-secret-0123456789';

  it('neither sends nor answers without the shared secret', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: 'shop' });
    await expect(channel.answer(async () => null)).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(
      channel.send({ id: '1', verb: 'reveal', args: [] }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('refuses unsigned, tampered and stale commands, and runs a signed one', async () => {
    const bus = new RedisBus();
    const ran: ConsoleCommand[] = [];
    const errors: unknown[] = [];
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await app.answer(
      async (command) => {
        ran.push(command);
        return { ok: command.verb };
      },
      { onError: (error) => errors.push(error) },
    );
    const raw = bus.connection();
    const forged = {
      id: 'forged-1',
      verb: 'reveal',
      args: [],
      actor: 'alice',
      capabilities: ['*'],
    };
    await raw.publish('shop-config-console', JSON.stringify(forged));
    await raw.publish(
      'shop-config-console',
      JSON.stringify({ ...forged, id: 'forged-2', ts: Date.now(), mac: 'AAAA' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(2);

    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const reply = await console.send({ id: 'real-1', verb: 'writeKey', args: [], actor: 'bob' });
    expect(reply).toMatchObject({ ok: true, data: { ok: 'writeKey' } });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ actor: 'bob' });
    expect(ran[0]).not.toHaveProperty('mac');

    // The same signed message published again (a replay) does not run twice.
    const signed = bus.published.find((p) => p.message.includes('"real-1"'))!;
    await raw.publish('shop-config-console', signed.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toHaveLength(1);

    // A tampered copy of a signed command (another actor) fails the MAC.
    const tampered = { ...JSON.parse(signed.message), id: 'real-2', actor: 'mallory' };
    await raw.publish('shop-config-console', JSON.stringify(tampered));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toHaveLength(1);
  });

  it('ignores a forged reply and waits for the signed one', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A rogue subscriber answers every command first, with its own public key.
    await raw.subscribe('shop-config-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(
        'shop-config-console-reply',
        JSON.stringify({ id, ok: true, data: { kty: 'OKP', x: 'attacker' } }),
      );
    });
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await app.answer(async () => ({ kty: 'OKP', x: 'real' }));
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const reply = await console.send({ id: 'k-1', verb: 'writeKey', args: [] });
    expect(reply).toMatchObject({ ok: true, data: { x: 'real' } });
  });
});

describe('stored fingerprints never leave the store as-is', () => {
  it('passes old (unkeyed) and new fingerprints through the keyed digest', async () => {
    const codec = withFingerprintKey(testSecretCodec('k'), 'app-key-0123456789abcdef');
    const sealer = new DocumentSealer(codec);
    // A version written before fingerprints were keyed: a bare hash of the secret.
    const legacy = fingerprintOf({ pin: { value: '1234', secret: true, reloadable: false } });
    const shown = sealer.publicFingerprint(legacy);
    expect(shown).not.toBe(legacy);
    expect(sealer.publicFingerprint(legacy)).toBe(shown);
    expect(new DocumentSealer(testSecretCodec('k')).publicFingerprint(legacy)).toBe(legacy);

    // History, the latest document and a write all show the same (public) fingerprint.
    const store = new MemoryStore({ secretCodec: codec });
    const context = { actor: 't', now: new Date(0).toISOString() };
    const written = await store.write(
      testScope,
      [{ key: 'pin', value: '1', secret: true }],
      context,
    );
    const read = await store.read(testScope);
    const history = await store.listVersions(testScope, { number: 1, size: 10 });
    expect(read?.fingerprint).toBe(written.document.fingerprint);
    expect(history.rows[0]?.fingerprint).toBe(written.document.fingerprint);
  });
});

describe('a conditional GET for the current version does no decryption', () => {
  it('answers 304 from the version number alone', async () => {
    const { base, store } = await controlPlane();
    const first = await fetch(`${base}/v1/config`, { headers: as('shop-secret', 'shop') });
    const etag = first.headers.get('etag')!;
    let reads = 0;
    const read = store.read.bind(store);
    store.read = async (scope) => {
      reads += 1;
      return read(scope);
    };
    const again = await fetch(`${base}/v1/config`, {
      headers: { ...as('shop-secret', 'shop'), 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect(reads).toBe(0);
    // A stale ETag still gets the full document.
    await seedConfig(store, testScope, [['db.host', 'db-2']]);
    const changed = await fetch(`${base}/v1/config`, {
      headers: { ...as('shop-secret', 'shop'), 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    expect(reads).toBe(1);
  });
});

describe('federated console channel edge cases', () => {
  const SECRET = 'federation-secret-0123456789';

  it('delivers an answer that carries a Date (MAC computed on the wire form)', async () => {
    const bus = new RedisBus();
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await app.answer(async () => ({ at: new Date(0), nested: { skip: undefined, ok: 1 } }));
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const reply = await console.send(
      { id: 'd-1', verb: 'writeKey', args: [] },
      { timeoutMs: 1000 },
    );
    expect(reply).toMatchObject({
      ok: true,
      data: { at: new Date(0).toISOString(), nested: { ok: 1 } },
    });
  });

  it('settles waiting commands at once when the console channel closes', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // An instance that listens but never answers, so the command waits.
    await raw.subscribe('shop-config-console', () => {});
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const pending = console.send({ id: 'c-1', verb: 'writeKey', args: [] }, { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await console.close();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'federated-app-unreachable' },
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
