import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { entryAad } from '../../src/crypto/secrets.js';
import { generateKeyPair, openWith } from '../../src/crypto-kit/index.js';
import { ConfigConsole } from '../../src/dashboard/console.js';
import {
  type ConfigConsoleConfig,
  resolveConsoleConfig,
} from '../../src/dashboard/define_config.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { seedConfig, testScope, testSecretCodec } from '../../src/testing/index.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function router(routes: Route[]) {
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => {} };
  };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    delete: add('DELETE'),
  };
}

async function spaDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-config-spa-'));
  dirs.push(dir);
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<html><head><title>x</title></head><body><div id="root"></div></body></html>',
  );
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

async function start(
  options: {
    console?: ConfigConsoleConfig;
    revealSecrets?: boolean;
    entries?: Parameters<typeof seedConfig>[2];
    apps?: string[];
  } = {},
) {
  const store = new MemoryStore({ secretCodec: testSecretCodec('console-test') });
  await seedConfig(store, testScope, options.entries ?? [['db.host', 'localhost']]);
  const admin = new ConfigAdmin({
    store,
    canRevealSecrets: options.revealSecrets ?? true,
    vault: async (reference) => (reference.path === 'prod/shop' ? 'from-vault' : undefined),
  });
  const config = resolveConsoleConfig(
    {
      authorize: (ctx) =>
        ctx.request.header('x-console') === 'ok'
          ? true
          : ctx.request.header('x-console') === 'no'
            ? { allowed: false, reason: 'forbidden' }
            : { allowed: false, reason: 'unauthenticated' },
      revealSecrets: options.revealSecrets ?? true,
      ...(options.apps ? { apps: options.apps } : {}),
      ...options.console,
    },
    { environment: 'production' },
  );
  const routes: Route[] = [];
  const console = new ConfigConsole({
    admin,
    config,
    spaDir: await spaDir(),
    environment: 'production',
    defaultApp: 'shop',
    inProduction: true,
    secrets: true,
    logger: { info: () => {}, warn: () => {} },
  });
  console.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  const base = `${addressOf(server)}/_config`;
  const auth = { 'x-console': 'ok' };
  return { store, admin, console, base, auth };
}

describe('config console API', () => {
  it('refuses an unauthenticated browser and API caller, and a forbidden one', async () => {
    const { base, auth } = await start();
    const api = await fetch(`${base}/api/meta`);
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'unauthenticated' });
    const forbidden = await fetch(`${base}/api/meta`, { headers: { 'x-console': 'no' } });
    expect(forbidden.status).toBe(403);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Sign in required');
    expect((await fetch(`${base}/api/meta`, { headers: auth })).status).toBe(200);
  });

  it('serves meta, the entries list, one entry and the SPA data block', async () => {
    const { base, auth } = await start();
    const meta = await (await fetch(`${base}/api/meta`, { headers: auth })).json();
    expect(meta).toMatchObject({
      apps: ['shop'],
      default: { app: 'shop', environment: 'production', label: 'main' },
      canRevealSecrets: true,
      secrets: true,
    });
    const list = await (
      await fetch(`${base}/api/entries?app=shop&sort=key`, { headers: auth })
    ).json();
    expect(list.data[0]).toMatchObject({ key: 'db.host', value: 'localhost' });
    expect(list.meta.total).toBe(1);

    const one = await fetch(`${base}/api/entries/db.host?app=shop`, { headers: auth });
    expect((await one.json()).value).toBe('localhost');
    expect((await fetch(`${base}/api/entries/nope?app=shop`, { headers: auth })).status).toBe(404);

    const html = await (await fetch(`${base}/`, { headers: auth })).text();
    expect(html).toContain('id="config-dashboard-config"');
    expect(html).toContain('"app":"shop"');

    const asset = await fetch(`${base}/assets/app.js`, { headers: auth });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log(1)');
    expect((await fetch(`${base}/assets/..%2Findex.html`, { headers: auth })).status).toBe(404);
  });

  it('refuses an unknown sort or filter field with 400', async () => {
    const { base, auth } = await start();
    const sort = await fetch(`${base}/api/entries?app=shop&sort=nope`, { headers: auth });
    expect(sort.status).toBe(400);
    const filter = await fetch(`${base}/api/entries?app=shop&filter[nope]=x`, { headers: auth });
    expect(filter.status).toBe(400);
    const badApp = await fetch(`${base}/api/entries?app=other`, {
      headers: auth,
    });
    // Without an `apps` allow-list any app is a valid (if empty) scope.
    expect(badApp.status).toBe(200);
  });

  it('sets, unsets, reveals and rolls back with the operator as the actor', async () => {
    const { base, auth, admin } = await start({
      entries: [{ key: 'p', value: 'hunter2', secret: true }, ['db.host', 'localhost']],
    });
    const set = await fetch(`${base}/api/entries/checkout.timeoutMs?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 3000, reloadable: true, message: 'tune' }),
    });
    expect(set.status).toBe(200);
    const setBody = await set.json();
    expect(setBody.entry).toMatchObject({ value: 3000, reloadable: true });
    expect(setBody.version).toBe(2);

    const audit = await admin.audit(testScope, { page: 1, size: 10 });
    expect(audit.data[0]).toMatchObject({
      actor: 'console',
      action: 'set',
      key: 'checkout.timeoutMs',
    });

    const masked = await (await fetch(`${base}/api/entries/p?app=shop`, { headers: auth })).json();
    expect(masked.masked).toBe(true);
    const revealed = await (
      await fetch(`${base}/api/entries/p/reveal?app=shop`, { method: 'POST', headers: auth })
    ).json();
    expect(revealed.value).toBe('hunter2');
    expect((await admin.audit(testScope, { page: 1, size: 10, action: 'reveal' })).meta.total).toBe(
      1,
    );

    const versions = await (await fetch(`${base}/api/versions?app=shop`, { headers: auth })).json();
    expect(versions.data[0].version).toBe(2);
    // One version: the shape the History page reads (`{ version, entries }`).
    const detail = await (await fetch(`${base}/api/versions/2?app=shop`, { headers: auth })).json();
    expect(detail.version).toMatchObject({ version: 2, createdBy: expect.any(String) });
    expect(detail.entries.length).toBeGreaterThan(0);
    // By cursor: no total, and the next page continues below the last version.
    const firstVersion = await (
      await fetch(`${base}/api/versions?app=shop&first=1`, { headers: auth })
    ).json();
    expect(firstVersion.meta).toMatchObject({ hasNext: true, hasPrev: false });
    expect(firstVersion.meta.total).toBeUndefined();
    const nextVersion = await (
      await fetch(`${base}/api/versions?app=shop&first=1&after=${firstVersion.meta.nextCursor}`, {
        headers: auth,
      })
    ).json();
    expect(nextVersion.data.map((v: { version: number }) => v.version)).toEqual([1]);
    const auditByCursor = await (
      await fetch(`${base}/api/audit?app=shop&first=1&filter[action]=reveal`, { headers: auth })
    ).json();
    expect(auditByCursor.data).toHaveLength(1);
    expect(auditByCursor.meta).toMatchObject({ hasNext: false, nextCursor: null });
    for (const query of ['after=forged', 'before=x&last=1']) {
      expect((await fetch(`${base}/api/audit?app=shop&${query}`, { headers: auth })).status).toBe(
        400,
      );
    }
    const diff = await (
      await fetch(`${base}/api/diff?app=shop&from=1&to=2`, { headers: auth })
    ).json();
    expect(diff.rows).toEqual([
      expect.objectContaining({ key: 'checkout.timeoutMs', kind: 'added' }),
    ]);

    const rollback = await fetch(`${base}/api/rollback?app=shop`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 1, message: 'back' }),
    });
    expect(await rollback.json()).toMatchObject({ version: 3, changed: true });

    const unset = await fetch(`${base}/api/entries/db.host?app=shop`, {
      method: 'DELETE',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'drop' }),
    });
    expect(await unset.json()).toMatchObject({ changed: true });
  });

  it('records the actor hook answer in the audit trail, else the default', async () => {
    const { base, auth, admin } = await start({
      entries: [{ key: 'p', value: 'hunter2', secret: true }],
      console: {
        actor: (ctx) => {
          const who = ctx.request.header('x-account');
          if (who === 'boom') throw new Error('session store down');
          return who ? { id: who, email: `${who}@hub.test` } : { id: null as never };
        },
      },
    });
    const put = (headers: Record<string, string>, value: number) =>
      fetch(`${base}/api/entries/checkout.timeoutMs?app=shop`, {
        method: 'PUT',
        headers: { ...auth, ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    expect((await put({ 'x-account': 'acc_1' }, 1)).status).toBe(200);
    expect((await put({}, 2)).status).toBe(200);
    expect((await put({ 'x-account': 'boom' }, 3)).status).toBe(200);
    await fetch(`${base}/api/entries/p/reveal?app=shop`, {
      method: 'POST',
      headers: { ...auth, 'x-account': 'acc_2' },
    });

    const sets = await admin.audit(testScope, { page: 1, size: 10, action: 'set' });
    // Newest first: the hook failed, said nobody, then named acc_1 (the seed is the last row).
    expect(sets.data.slice(0, 3).map((row) => row.actor)).toEqual(['console', 'console', 'acc_1']);
    const reveals = await admin.audit(testScope, { page: 1, size: 10, action: 'reveal' });
    expect(reveals.data[0]?.actor).toBe('acc_2');
  });

  it('does not reveal a secret when the console disables it', async () => {
    const { base, auth } = await start({
      revealSecrets: false,
      entries: [{ key: 'p', value: 'x', secret: true }],
    });
    const reveal = await fetch(`${base}/api/entries/p/reveal?app=shop`, {
      method: 'POST',
      headers: auth,
    });
    expect(reveal.status).toBe(403);
    const entry = await (await fetch(`${base}/api/entries/p?app=shop`, { headers: auth })).json();
    expect(entry.masked).toBe(true);
  });

  it('rejects an invalid entry body with 400 and validates the key', async () => {
    const { base, auth } = await start();
    const badValue = await fetch(`${base}/api/entries/a?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1, secret: 'yes' }),
    });
    expect(badValue.status).toBe(400);
    const badKey = await fetch(`${base}/api/entries/..%2Fbad?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    });
    expect(badKey.status).toBe(400);
    const badVault = await fetch(`${base}/api/entries/a?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ vault: 'https://x' }),
    });
    expect(badVault.status).toBe(400);
  });

  it('refuses a PUT that would silently unset the entry', async () => {
    const { base, auth } = await start();
    const response = await fetch(`${base}/api/entries/db.host?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: true }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/value or vault/);
  });

  it('seals an entry for the app and never offers a reveal', async () => {
    const { base, auth, store } = await start();
    const pair = generateKeyPair('x25519');
    await store.registerTenantKey?.({
      app: 'shop',
      kid: pair.publicKey.kid,
      publicKey: pair.publicKey,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });

    const put = await fetch(`${base}/api/entries/p?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'hunter2', sealedTo: true }),
    });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body.entry).toMatchObject({ masked: true, sealedTo: { app: 'shop' } });
    expect(body.entry.value).toBeUndefined();

    const reveal = await fetch(`${base}/api/entries/p/reveal?app=shop`, {
      method: 'POST',
      headers: auth,
    });
    const revealed = await reveal.json();
    expect(revealed).toMatchObject({ masked: true, sealedTo: { app: 'shop' } });
    expect(revealed.value).toBeUndefined();

    const stored = (await store.read(testScope))!.entries.p;
    expect(
      JSON.parse(
        openWith([pair.privateKey], stored.value as string, {
          aad: entryAad(testScope, 'p'),
        }),
      ),
    ).toBe('hunter2');

    const badFlag = await fetch(`${base}/api/entries/p?app=shop`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x', sealedTo: 'yes' }),
    });
    expect(badFlag.status).toBe(400);
  });

  it('limits the console to the configured apps', async () => {
    const { base, auth } = await start({ apps: ['shop'] });
    expect((await fetch(`${base}/api/entries?app=shop`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/entries?app=billing`, { headers: auth })).status).toBe(403);
  });

  it('narrows the console to the viewer grant, inside the static apps list', async () => {
    const { base, store } = await start({
      apps: ['shop', 'billing'],
      console: {
        authorize: (ctx) => {
          const who = ctx.request.header('x-viewer');
          if (who === 'shop-only') return { allowed: true, apps: ['shop', 'hr'] };
          if (who === 'all') return { allowed: true, apps: '*' };
          return { allowed: false, reason: 'unauthenticated' };
        },
      },
    });
    await seedConfig(store, { ...testScope, app: 'billing' }, [['db.host', 'billing-db']]);
    const shopOnly = { 'x-viewer': 'shop-only' };
    const meta = await (await fetch(`${base}/api/meta`, { headers: shopOnly })).json();
    // `hr` is granted but outside `console.apps`: the static list stays the upper bound.
    expect(meta.apps).toEqual(['shop']);
    expect(meta.default.app).toBe('shop');
    expect((await fetch(`${base}/api/entries?app=shop`, { headers: shopOnly })).status).toBe(200);
    const billing = await fetch(`${base}/api/entries?app=billing`, { headers: shopOnly });
    expect(billing.status).toBe(403);
    expect(await billing.json()).toEqual({ error: 'app "billing" is not granted to this viewer' });
    const write = await fetch(`${base}/api/entries/x?app=billing`, {
      method: 'PUT',
      headers: { ...shopOnly, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    });
    expect(write.status).toBe(403);
    expect((await fetch(`${base}/api/entries?app=hr`, { headers: shopOnly })).status).toBe(403);

    const all = await (await fetch(`${base}/api/meta`, { headers: { 'x-viewer': 'all' } })).json();
    expect(all.apps).toEqual(['shop', 'billing']);
  });

  it('lists granted apps the store does not hold yet when there is no static list', async () => {
    const { base } = await start({
      console: { authorize: () => ({ allowed: true, apps: ['billing'] }) },
    });
    const meta = await (await fetch(`${base}/api/meta`)).json();
    expect(meta.apps).toEqual(['billing']);
    expect(meta.default.app).toBe('billing');
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toContain('"app":"shop"');
  });
});
