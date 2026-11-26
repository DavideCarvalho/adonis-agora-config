import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigAdmin } from '../../src/admin.js';
import { ConfigConsole } from '../../src/dashboard/console.js';
import { resolveConsoleConfig } from '../../src/dashboard/define_config.js';
import {
  configConsoleCommandHandler,
  consoleCommandKeys,
  FederatedConfigApps,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import type { SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testSecretCodec } from '../../src/testing/index.js';
import { addressOf, type Handler, serve } from '../http_harness.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * Two apps sharing a database and a Redis: "Entre Textos" runs config standalone (its own store,
 * its own key, its own audit), the Hub's console shows it through `federatedApps`. Everything the
 * Hub reads comes from Entre Textos' tables; everything it changes, Entre Textos does itself.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const SECRET = 'sk_live_do-not-leak-4242';
const ET = { app: 'entre-textos', environment: 'production', label: 'main' };
const PREFIX = 'entretextos';
const CHANNEL_SECRET = 'federation-secret-0123456789';
const APP_KEY = 'entre-textos-app-key-0123456789';

async function sqlite(): Promise<SqlDatabase> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-config-fed-'));
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  closers.push(async () => {
    await database.manager.closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  return database.connection() as unknown as SqlDatabase;
}

async function spaDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-config-fed-spa-'));
  closers.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html><head></head><body></body></html>');
  return dir;
}

function router(routes: Array<{ method: string; pattern: string; handler: Handler }>) {
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
  };
  return { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };
}

interface Setup {
  /** Entre Textos' consoleCommands. */
  owner?: { actions?: boolean; reveal?: boolean; instances?: number; listening?: boolean };
  /** What the Hub's authorize grants (`x-viewer` header picks the viewer). */
  grant?: { apps?: string[]; capabilities?: string[]; access?: 'read' | 'write' };
  /** The Hub's federatedApps entry. */
  entry?: { actions?: boolean };
}

async function setup(options: Setup = {}) {
  const db = await sqlite();
  const bus = new RedisBus();

  // Entre Textos: standalone, its own key, its own store.
  const etStore = new LucidStore(db, { secretCodec: testSecretCodec('et-secrets-key') });
  await etStore.setup();
  const etAdmin = new ConfigAdmin({ store: etStore });
  await etAdmin.setEntry(ET, 'db.host', { value: 'db.internal' }, { actor: 'deploy' });
  await etAdmin.setEntry(ET, 'stripe.key', { value: SECRET, secret: true }, { actor: 'deploy' });
  await etAdmin.setEntry(
    ET,
    'vault.thing',
    { vault: 'vault://aws/prod/et#key' },
    { actor: 'deploy' },
  );
  const runs: string[] = [];
  const owner = options.owner ?? {};
  if (owner.listening !== false) {
    for (let i = 0; i < (owner.instances ?? 2); i++) {
      const channel = new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        secret: CHANNEL_SECRET,
      });
      const handler = configConsoleCommandHandler({
        admin: etAdmin,
        prefix: PREFIX,
        actions: owner.actions ?? true,
        reveal: owner.reveal ?? true,
        partitions: [ET.app],
        keys: consoleCommandKeys(APP_KEY, PREFIX),
      });
      await channel.answer(async (command) => {
        runs.push(`${i}:${command.verb}`);
        return handler(command);
      });
      closers.push(() => channel.close());
    }
  }

  // The Hub: its own (control-plane) store, and Entre Textos federated.
  const hubStore = new MemoryStore({ secretCodec: testSecretCodec('hub-key') });
  const hubAdmin = new ConfigAdmin({ store: hubStore });
  await hubAdmin.setEntry(
    { app: 'eduliberta', environment: 'production', label: 'main' },
    'feature.x',
    { value: true },
    { actor: 'hub' },
  );
  const federated = new FederatedConfigApps(
    {
      et: {
        label: 'Entre Textos',
        partition: ET.app,
        store: { connection: 'et' },
        controlPlane: { prefix: PREFIX, secret: CHANNEL_SECRET },
        timeoutMs: 500,
        ...(options.entry ?? {}),
      },
    },
    { db: async () => db, redis: async () => bus.connection() },
  );
  closers.push(() => federated.close());
  const grant = options.grant ?? { capabilities: ['config:*'] };
  const config = resolveConsoleConfig(
    {
      appLabel: 'Hub',
      authorize: (ctx) => {
        const viewer = ctx.request.header('x-viewer');
        if (!viewer) return { allowed: false, reason: 'unauthenticated' };
        (ctx as unknown as { auth: unknown }).auth = { user: { id: viewer } };
        return { allowed: true, ...grant };
      },
    },
    { environment: 'production' },
  );
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  new ConfigConsole({
    admin: hubAdmin,
    config,
    spaDir: await spaDir(),
    environment: 'production',
    inProduction: true,
    secrets: true,
    topology: 'control-plane',
    logger: { info: () => {}, warn: () => {} },
    federated,
  }).register(router(routes));
  const server: Server = await serve(routes);
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `${addressOf(server)}/_config/api`;
  const headers = { 'x-viewer': 'ana@hub', 'content-type': 'application/json' };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, bus, etStore, etAdmin, hubAdmin, call, runs };
}

describe('federated config console', () => {
  it('lists the federated app next to the control-plane scopes, with its mode', async () => {
    const { call } = await setup();
    const apps = await call('/apps');
    expect(apps.body).toEqual({
      local: { label: 'Hub' },
      apps: [{ id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
      selected: null,
    });
    const meta = await call('/meta');
    expect(meta.body.apps).toEqual(['eduliberta', 'et']);
    expect(meta.body.federated).toEqual(apps.body.apps);
    const scopes = await call('/scopes?app=et');
    expect(scopes.body).toMatchObject({ environments: ['production'], labels: ['main'] });
  });

  it("reads the app's entries, versions and audit from its own tables, never a secret", async () => {
    const { call, bus, runs } = await setup();
    const list = await call('/entries?app=et');
    expect(list.status).toBe(200);
    const rows = Object.fromEntries(list.body.data.map((row: any) => [row.key, row]));
    expect(rows['db.host']).toMatchObject({ value: 'db.internal', masked: false });
    expect(rows['stripe.key']).toMatchObject({ secret: true, masked: true });
    expect(rows['stripe.key']).not.toHaveProperty('value');
    expect(rows['vault.thing']).not.toHaveProperty('vault');
    expect(JSON.stringify(list.body)).not.toContain(SECRET);

    const versions = await call('/versions?app=et');
    expect(versions.body.data.map((v: any) => v.version)).toEqual([3, 2, 1]);
    const version = await call('/versions/2?app=et');
    expect(version.body.version).toMatchObject({ version: 2 });
    expect(typeof version.body.version.createdBy).toBe('string');
    expect(Array.isArray(version.body.entries)).toBe(true);
    expect(JSON.stringify(version.body)).not.toContain(SECRET);
    const diff = await call('/diff?app=et&from=1&to=2');
    expect(JSON.stringify(diff.body)).not.toContain(SECRET);
    const audit = await call('/audit?app=et');
    expect(audit.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.body)).not.toContain(SECRET);
    // Reads never asked the app anything.
    expect(runs).toEqual([]);
    expect(bus.published).toEqual([]);
  });

  it('the store it reads with cannot write and drops secrets at the row', async () => {
    const { db } = await setup();
    const reader = new LucidStore(db, { secrets: 'redact', autoCreateSchema: false });
    const document = await reader.read(ET);
    expect(document?.entries['stripe.key']).toMatchObject({ secret: true });
    expect(document?.entries['stripe.key']).not.toHaveProperty('value');
    await expect(
      reader.write(ET, [{ key: 'x', value: 'y', secret: true }], { actor: 'a', now: 'n' }),
    ).rejects.toThrow(/only reads/);
  });

  it('writes through the app: its version, its audit, the Hub viewer as actor, sealed on the wire', async () => {
    const { call, bus, etAdmin, runs } = await setup();
    const put = await call('/entries/stripe.webhook?app=et', {
      method: 'PUT',
      body: JSON.stringify({ value: 'whsec_also-secret', secret: true, message: 'rotate' }),
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ version: 4, changed: true, entry: { masked: true } });
    // One instance ran it (the claim), plus the write key it was sealed to.
    expect(runs.filter((r) => r.endsWith(':setEntry'))).toHaveLength(1);
    expect(bus.wire).not.toContain('whsec_also-secret');

    const audit = await etAdmin.audit(ET, { page: 1, size: 10, key: 'stripe.webhook' });
    expect(audit.data[0]).toMatchObject({ actor: 'ana@hub', action: 'set', message: 'rotate' });
    const stored = await etAdmin.getEntry(ET, 'stripe.webhook', { canReadSecrets: true });
    expect(stored?.value).toBe('whsec_also-secret');

    const unset = await call('/entries/db.host?app=et', { method: 'DELETE', body: '{}' });
    expect(unset.body).toMatchObject({ version: 5, changed: true });
    const rollback = await call('/rollback?app=et', {
      method: 'POST',
      body: JSON.stringify({ to: 3 }),
    });
    expect(rollback.body).toMatchObject({ version: 6, changed: true });
    expect((await etAdmin.getEntry(ET, 'db.host', { canReadSecrets: false }))?.value).toBe(
      'db.internal',
    );
  });

  it('reveals only with config:secrets:read, audited by the app, sealed on the wire', async () => {
    const granted = await setup();
    const revealed = await granted.call('/entries/stripe.key/reveal?app=et', {
      method: 'POST',
      body: '{}',
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ value: SECRET, masked: false });
    expect(granted.bus.wire).not.toContain(SECRET);
    const audit = await granted.etAdmin.audit(ET, { page: 1, size: 10, action: 'reveal' });
    expect(audit.data[0]).toMatchObject({ actor: 'ana@hub', key: 'stripe.key' });

    const noCapability = await setup({ grant: { capabilities: ['config:read'] } });
    const refused = await noCapability.call('/entries/stripe.key/reveal?app=et', {
      method: 'POST',
      body: '{}',
    });
    expect(refused.status).toBe(403);
    expect(noCapability.runs).toEqual([]);

    const ownerSaysNo = await setup({ owner: { reveal: false } });
    const off = await ownerSaysNo.call('/entries/stripe.key/reveal?app=et', {
      method: 'POST',
      body: '{}',
    });
    expect(off.status).toBe(403);
    expect(off.body.error).toMatch(/consoleCommands.reveal/);
  });

  it('refuses changes the app or this console turned off', async () => {
    const ownerOff = await setup({ owner: { actions: false } });
    const put = await ownerOff.call('/entries/a.b?app=et', {
      method: 'PUT',
      body: JSON.stringify({ value: 1 }),
    });
    expect(put.status).toBe(403);
    const rollback = await ownerOff.call('/rollback?app=et', {
      method: 'POST',
      body: JSON.stringify({ to: 1 }),
    });
    expect(rollback.status).toBe(403);

    const hubOff = await setup({ entry: { actions: false } });
    expect((await hubOff.call('/apps')).body.apps[0].actions).toBe('none');
    const refused = await hubOff.call('/entries/a.b?app=et', {
      method: 'PUT',
      body: JSON.stringify({ value: 1 }),
    });
    expect(refused.status).toBe(403);
    expect(hubOff.runs).toEqual([]);
  });

  it('answers 503 at once when no instance listens, and hides apps outside the grant', async () => {
    const silent = await setup({ owner: { listening: false } });
    const put = await silent.call('/entries/a.b?app=et', {
      method: 'PUT',
      body: JSON.stringify({ value: 1 }),
    });
    expect(put.status).toBe(503);
    expect(put.body.error).toMatch(/Entre Textos/);
    // Reads still work: they never needed the app.
    expect((await silent.call('/entries?app=et')).status).toBe(200);

    const narrow = await setup({ grant: { apps: ['eduliberta'] } });
    expect((await narrow.call('/apps')).body.apps).toEqual([]);
    expect((await narrow.call('/meta')).body.apps).toEqual(['eduliberta']);
    expect((await narrow.call('/entries?app=et')).status).toBe(403);
  });

  it("the viewer's capabilities restrict this console's own app too, and the UI learns them", async () => {
    const local = '?app=eduliberta';
    for (const grant of [{ capabilities: ['config:console:read'] }, { access: 'read' as const }]) {
      const { call } = await setup({ grant });
      const put = await call(`/entries/feature.y${local}`, {
        method: 'PUT',
        body: JSON.stringify({ value: 1 }),
      });
      expect(put).toMatchObject({ status: 403, body: { error: 'the viewer lacks config:write' } });
      expect(
        (await call(`/entries/feature.x${local}`, { method: 'DELETE', body: '{}' })).status,
      ).toBe(403);
      expect(
        (await call(`/rollback${local}`, { method: 'POST', body: JSON.stringify({ to: 1 }) }))
          .status,
      ).toBe(403);
      const meta = await call('/meta');
      expect(meta.body.viewer).toMatchObject({ canWrite: false });
      if (grant.access === 'read') {
        // access: 'read' keeps reads, secrets included.
        expect(meta.body.canRevealSecrets).toBe(true);
      } else {
        expect(meta.body.canRevealSecrets).toBe(false);
        const reveal = await call(`/entries/feature.x/reveal${local}`, {
          method: 'POST',
          body: '{}',
        });
        expect(reveal).toMatchObject({
          status: 403,
          body: { error: 'the viewer lacks config:secrets:read' },
        });
      }
    }
    // `config:console:*` allows everything; an authorize that says nothing keeps full access.
    for (const grant of [{ capabilities: ['config:console:*'] }, {}]) {
      const { call } = await setup({ grant });
      const put = await call(`/entries/feature.y${local}`, {
        method: 'PUT',
        body: JSON.stringify({ value: 1 }),
      });
      expect(put.status).toBe(200);
      const meta = await call('/meta');
      if ('capabilities' in grant) expect(meta.body.viewer).toMatchObject({ canWrite: true });
      else expect(meta.body.viewer).toBeUndefined();
    }
  });
});
