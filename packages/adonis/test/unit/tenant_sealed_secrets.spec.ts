import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { entryAad } from '../../src/crypto/secrets.js';
import { openWith, SealedValueError, sealedToKid } from '../../src/crypto-kit/index.js';
import { ControlPlane, resetKnownTenants } from '../../src/http/control_plane.js';
import { type ConfigStore, resealTenantEntries } from '../../src/index.js';
import { memoryConfig, testScope, testSecretCodec } from '../../src/testing/index.js';
import { createTenantClient } from '../../src/topology/tenant_client.js';
import { TenantKeyring } from '../../src/topology/tenant_keyring.js';
import { sharedSecretVerifier, type TenantVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  resetKnownTenants();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agora-sealed-'));
  dirs.push(dir);
  return dir;
}

async function keyringFor(app = 'shop', appKey = 'test-secret-key-for-agora-config') {
  return TenantKeyring.load({
    path: join(tempDir(), 'config-tenant-key.json'),
    codec: testSecretCodec(appKey),
    aad: `config:tenant-key:${app}`,
  });
}

function router(routes: Route[]) {
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
    route(pattern: string, methods: string[], handler: Handler) {
      for (const method of methods) routes.push({ method, pattern, handler });
      return {};
    },
  };
}

const verifyTenant: TenantVerifier = sharedSecretVerifier({
  partitions: {
    shop: { secret: 'shop-secret', capabilities: ['config:read', 'config:secrets:read'] },
    reader: { secret: 'reader-secret', capabilities: ['config:read'] },
  },
});

async function start(store: ConfigStore, verifier: TenantVerifier = verifyTenant) {
  const controlPlane = new ControlPlane({
    store,
    verifyTenant: verifier,
    environment: 'production',
  });
  const routes: Route[] = [];
  controlPlane.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { controlPlane, base: `${addressOf(server)}/_config` };
}

const auth = (token: string, headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...headers,
});

async function registerKey(
  base: string,
  ring: TenantKeyring,
  token = 'shop-secret',
  app = 'shop',
): Promise<Response> {
  return fetch(`${base}/v1/keys`, {
    method: 'PUT',
    headers: { ...auth(token), 'x-config-app': app, 'content-type': 'application/json' },
    body: JSON.stringify({ active: ring.activeKid, keys: ring.publicKeys() }),
  });
}

const quiet = { info(): void {}, warn(): void {} };

describe('sealed secrets (asymmetric)', () => {
  it('seals to the app and the control plane can never open the value', async () => {
    const store = memoryConfig();
    const shop = await keyringFor();
    const [publicKey] = shop.publicKeys();
    await store.registerTenantKey?.({
      app: 'shop',
      kid: publicKey!.kid,
      publicKey: publicKey!,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });
    const admin = new ConfigAdmin({ store });

    await admin.setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', sealedTo: true },
      { actor: 'ann' },
    );

    const stored = (await store.read(testScope))!.entries['stripe.secret'];
    expect(stored.sealedTo).toEqual({ app: 'shop', kid: shop.activeKid });
    expect(typeof stored.value).toBe('string');
    expect(sealedToKid(stored.value as string)).toBe(shop.activeKid);
    expect(stored.secret).toBe(true);

    // Only the app's private key opens it; the control plane holds no private key at all.
    const aad = entryAad(testScope, 'stripe.secret');
    expect(JSON.parse(shop.open(stored.value as string, aad))).toBe('sk_live_123');
    expect(() => openWith([], stored.value as string, { aad })).toThrow(SealedValueError);

    // The console never reveals it, even with the reveal flag: there is nothing to reveal.
    const view = await admin.getEntry(testScope, 'stripe.secret', {
      canReadSecrets: true,
      reveal: { actor: 'ops' },
    });
    expect(view).toMatchObject({ masked: true, sealedTo: { app: 'shop' } });
    expect(view?.value).toBeUndefined();
    const reveals = await store.listAudit(testScope, { number: 1, size: 50 }, { action: 'reveal' });
    expect(reveals.rows).toHaveLength(0);
    expect(
      Object.keys(await admin.values(testScope, true, { reveal: { actor: 'ops' } })),
    ).not.toContain('stripe.secret');
  });

  it('opens for the right app and fails for another one', async () => {
    const store = memoryConfig();
    const shop = await keyringFor('shop');
    const other = await keyringFor('billing');
    const [publicKey] = shop.publicKeys();
    await store.registerTenantKey?.({
      app: 'shop',
      kid: publicKey!.kid,
      publicKey: publicKey!,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });
    const admin = new ConfigAdmin({ store });
    await admin.setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', sealedTo: true },
      { actor: 'ann' },
    );
    const sealed = (await store.read(testScope))!.entries['stripe.secret'].value as string;
    const aad = entryAad(testScope, 'stripe.secret');

    expect(JSON.parse(shop.open(sealed, aad))).toBe('sk_live_123');
    expect(() => other.open(sealed, aad)).toThrow(SealedValueError);
    // AAD binding: the same app cannot open it under another key/environment.
    expect(() => shop.open(sealed, entryAad(testScope, 'other.secret'))).toThrow(SealedValueError);
  });

  it('serves ciphertext to the target app, masks it without config:secrets:read', async () => {
    const store = memoryConfig();
    const shop = await keyringFor();
    const verifier: TenantVerifier = (request) =>
      request.token === 'shop-secret'
        ? { partition: 'shop', capabilities: ['config:read', 'config:secrets:read'] }
        : request.token === 'reader-secret'
          ? { partition: 'shop', capabilities: ['config:read'] }
          : null;
    const { base } = await start(store, verifier);
    expect((await registerKey(base, shop)).status).toBe(200);

    const admin = new ConfigAdmin({ store });
    await admin.setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', sealedTo: true },
      { actor: 'ann' },
    );

    const withSecrets = await fetch(`${base}/v1/config`, {
      headers: { ...auth('shop-secret'), 'x-config-app': 'shop' },
    });
    const sealed = (await withSecrets.json()).entries['stripe.secret'];
    expect(sealed.masked).toBe(false);
    expect(sealed.sealedTo).toEqual({ app: 'shop', kid: shop.activeKid });
    expect(sealed.value.startsWith('agora:pk1:')).toBe(true);

    const withoutSecrets = await fetch(`${base}/v1/config`, {
      headers: { ...auth('reader-secret'), 'x-config-app': 'shop' },
    });
    const masked = (await withoutSecrets.json()).entries['stripe.secret'];
    expect(masked).toMatchObject({ masked: true, sealedTo: { app: 'shop' } });
    expect(masked.value).toBeUndefined();
  });

  it('refuses a private key or a malformed key registration over HTTP', async () => {
    const shop = await keyringFor();
    const { base } = await start(memoryConfig());
    const privateJwk = { ...shop.publicKeys()[0]!, d: 'a-private-part' };
    const withPrivate = await fetch(`${base}/v1/keys`, {
      method: 'PUT',
      headers: {
        ...auth('shop-secret'),
        'x-config-app': 'shop',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ active: shop.activeKid, keys: [privateJwk] }),
    });
    expect(withPrivate.status).toBe(400);
    expect(JSON.stringify(await withPrivate.json())).toMatch(/PUBLIC/);

    const wrongActive = await fetch(`${base}/v1/keys`, {
      method: 'PUT',
      headers: {
        ...auth('shop-secret'),
        'x-config-app': 'shop',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ active: 'not-a-registered-kid', keys: shop.publicKeys() }),
    });
    expect(wrongActive.status).toBe(400);
  });

  it('boots a tenant from sealed values, keeps ciphertext in the snapshot, and reloads', async () => {
    const store = memoryConfig();
    const shop = await keyringFor();
    const { base } = await start(store);
    await registerKey(base, shop);
    const admin = new ConfigAdmin({ store });
    await admin.setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', sealedTo: true, reloadable: true },
      { actor: 'ann' },
    );

    const snapshotPath = join(tempDir(), 'snapshot.json');
    const client = createTenantClient({
      url: base,
      partition: 'shop',
      token: 'shop-secret',
      keys: shop,
      snapshotPath,
      stream: false,
      logger: quiet,
    });
    await client.load();

    expect(client.get('stripe.secret')).toBe('sk_live_123');
    expect(client.entries()['stripe.secret']?.sealedTo).toEqual({
      app: 'shop',
      kid: shop.activeKid,
    });
    expect(client.keyStatus()).toMatchObject({ registered: true, sealed: 1, unreadable: 0 });
    const snapshot = readFileSync(snapshotPath, 'utf8');
    expect(snapshot).not.toContain('sk_live_123');
    expect(snapshot).toContain('agora:pk1:');
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);

    await admin.setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_456', sealedTo: true, reloadable: true },
      { actor: 'ann' },
    );
    await client.refresh();
    expect(client.get('stripe.secret')).toBe('sk_live_456');

    // Another app's keyring opens neither version.
    const other = await keyringFor('billing');
    const sealed = (await store.read(testScope))!.entries['stripe.secret'].value as string;
    expect(() => other.open(sealed, entryAad(testScope, 'stripe.secret'))).toThrow(
      SealedValueError,
    );
  });

  it('leaves a sealed entry masked (never as ciphertext) when the app lacks the key', async () => {
    const store = memoryConfig();
    const shop = await keyringFor();
    const stranger = await keyringFor('shop');
    const { base } = await start(store);
    await registerKey(base, shop);
    await new ConfigAdmin({ store }).setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', sealedTo: true },
      { actor: 'ann' },
    );

    const client = createTenantClient({
      url: base,
      partition: 'shop',
      token: 'shop-secret',
      keys: stranger,
      stream: false,
      logger: quiet,
    });
    await client.load();
    expect(client.get('stripe.secret', 'fallback')).toBe('fallback');
    expect(client.entries()['stripe.secret']).toMatchObject({ masked: true });
    expect(client.entries()['stripe.secret']?.value).toBeUndefined();
    expect(client.keyStatus()).toMatchObject({ registered: true, sealed: 1, unreadable: 1 });
  });

  it('rotates the app key and re-seals the values to the new key', async () => {
    const store = memoryConfig();
    const shop = await keyringFor();
    const { base } = await start(store);
    await registerKey(base, shop);
    await new ConfigAdmin({ store }).setEntry(
      testScope,
      'stripe.secret',
      { value: 'sk_live_123', sealedTo: true },
      { actor: 'ann' },
    );

    const client = createTenantClient({
      url: base,
      partition: 'shop',
      token: 'shop-secret',
      keys: shop,
      stream: false,
      logger: quiet,
    });
    await client.load();
    const oldKid = shop.activeKid;
    const oldSealed = (await store.read(testScope))!.entries['stripe.secret'].value as string;

    const publicKey = await shop.rotate();
    expect(publicKey.kid).not.toBe(oldKid);
    expect(await client.registerKeys()).toBe(true);
    const report = await client.resealSealed();
    expect(report).toMatchObject({ dryRun: false, scanned: 1, resealed: 1, skipped: 0 });

    const current = (await store.read(testScope))!.entries['stripe.secret'];
    expect(current.sealedTo).toEqual({ app: 'shop', kid: publicKey.kid });
    expect(sealedToKid(current.value as string)).toBe(publicKey.kid);
    // The retired private key still opens the old ciphertext; the new key opens the new one.
    expect(JSON.parse(shop.open(oldSealed, entryAad(testScope, 'stripe.secret')))).toBe(
      'sk_live_123',
    );
    expect(
      JSON.parse(shop.open(current.value as string, entryAad(testScope, 'stripe.secret'))),
    ).toBe('sk_live_123');
    expect(() => openWith([], current.value as string)).toThrow(SealedValueError);

    // A second re-seal has nothing to do, and the doctor state is clean.
    expect(await client.resealSealed()).toMatchObject({ scanned: 1, resealed: 0, skipped: 1 });
    expect(client.keyStatus().staleKids).toEqual([]);
  });

  it('refuses to re-seal an entry that was never sealed, or a stale version', async () => {
    const store = memoryConfig();
    const shop = await keyringFor();
    const [publicKey] = shop.publicKeys();
    await store.registerTenantKey?.({
      app: 'shop',
      kid: publicKey!.kid,
      publicKey: publicKey!,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });
    await store.write(testScope, [{ key: 'db.host', value: 'localhost' }], {
      actor: 'ann',
      now: new Date().toISOString(),
    });
    const value = shop.seal('hunter2', entryAad(testScope, 'db.host'));
    await expect(
      resealTenantEntries(store, testScope, [{ key: 'db.host', value, kid: shop.activeKid }], {
        actor: 'shop',
        now: new Date().toISOString(),
        version: 1,
      }),
    ).rejects.toThrow(/not sealed/);
    await expect(
      resealTenantEntries(store, testScope, [], {
        actor: 'shop',
        now: new Date().toISOString(),
        version: 9,
      }),
    ).rejects.toThrow(/stale re-seal/);
  });
});
