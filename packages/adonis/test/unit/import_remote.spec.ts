import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { importRemoteConfig, RemoteConfigUnavailableError } from '../../src/bootstrap.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import type { Handler } from '../http_harness.js';
import { addressOf, serve } from '../http_harness.js';

const servers: Server[] = [];
const dirs: string[] = [];
const env = { ...process.env };

afterEach(async () => {
  process.env = { ...env };
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(entries: Array<[string, unknown]>) {
  const store = memoryConfig();
  await seedConfig(store, testScope, entries as never);
  const controlPlane = new ControlPlane({
    store,
    verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    environment: 'production',
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  controlPlane.register({
    get(pattern, handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
  });
  const server = await serve(routes);
  servers.push(server);
  return `${addressOf(server)}/_config`;
}

/** A server in front of `target` that answers 503 to its first `failures` requests. */
async function flaky(
  target: string,
  failures: number,
): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const upstream = new URL(target);
  const server = createServer(async (req, res) => {
    hits += 1;
    if (hits <= failures) {
      res.writeHead(503).end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name !== 'host' && typeof value === 'string') headers[name] = value;
    }
    const proxied = await fetch(`${upstream.origin}${req.url}`, { headers });
    res.writeHead(proxied.status, {
      'content-type': proxied.headers.get('content-type') ?? 'application/json',
    });
    res.end(Buffer.from(await proxied.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}${upstream.pathname}`, hits: () => hits };
}

/** An app root with a `.env` file. */
async function appRoot(dotenv: string): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-config-import-'));
  dirs.push(dir);
  await writeFile(join(dir, '.env'), dotenv);
  return pathToFileURL(`${dir}/`);
}

for (const name of [
  'DB_HOST',
  'DB_PORT',
  'LOCAL_ONLY',
  'MAIL_FROM',
  'CONFIG_URL',
  'CONFIG_TOKEN',
]) {
  delete process.env[name];
}

describe('importRemoteConfig', () => {
  it('process env > .env files > config server; only what is missing comes from the server', async () => {
    const url = await start([
      ['db.host', 'db.remote'],
      ['db.port', 5432],
      ['mail.from', 'remote@example.com'],
    ]);
    const root = await appRoot(
      `DB_HOST=from-dotenv\nLOCAL_ONLY=yes\nCONFIG_URL=${url}\nCONFIG_TOKEN=shop-secret\n`,
    );
    process.env.MAIL_FROM = 'process@example.com';

    const result = await importRemoteConfig(root, (local) => ({
      url: local.CONFIG_URL,
      token: local.CONFIG_TOKEN,
      partition: 'shop',
      snapshotPath: false,
    }));

    expect(result?.source).toBe('remote');
    expect(process.env.DB_HOST).toBe('from-dotenv');
    expect(process.env.LOCAL_ONLY).toBe('yes');
    expect(process.env.MAIL_FROM).toBe('process@example.com');
    expect(process.env.DB_PORT).toBe('5432');
    expect(result?.applied).toEqual(['DB_PORT']);
    expect(result?.shadowed.sort()).toEqual(['DB_HOST', 'MAIL_FROM']);
    await result?.client.stop();
  });

  it('without credentials nothing is fetched and the app keeps its local environment', async () => {
    const root = await appRoot('LOCAL_ONLY=yes\n');
    const result = await importRemoteConfig(root, (local) => ({
      issuer: local.AUTHKIT_ISSUER,
      clientId: local.SERVICE_CLIENT_ID,
      clientSecret: local.SERVICE_CLIENT_SECRET,
    }));
    expect(result).toBeNull();
    expect(process.env.LOCAL_ONLY).toBe('yes');
  });

  it('a callback returning nothing turns it off', async () => {
    const root = await appRoot('');
    expect(await importRemoteConfig(root, () => false)).toBeNull();
  });

  it('the server down and no snapshot: boots on the local environment', async () => {
    const root = await appRoot('');
    const result = await importRemoteConfig(root, {
      url: 'http://127.0.0.1:1/_config',
      token: 'shop-secret',
      partition: 'shop',
      snapshotPath: false,
      timeoutMs: 2000,
    });
    expect(result?.source).toBe('none');
    expect(result?.applied).toEqual([]);
    await result?.client.stop();
  });

  it('without a partition and a token that carries none, it gives up', async () => {
    const root = await appRoot('');
    const result = await importRemoteConfig(root, {
      url: 'http://127.0.0.1:1/_config',
      token: 'not-a-jwt',
    });
    expect(result).toBeNull();
  });

  it('retries with backoff until the server answers', async () => {
    const url = await start([['db.port', 5432]]);
    const proxy = await flaky(url, 2);
    const root = await appRoot('');
    const result = await importRemoteConfig(root, {
      url: proxy.url,
      token: 'shop-secret',
      partition: 'shop',
      snapshotPath: false,
      retry: { attempts: 5, initialMs: 10, maxMs: 20 },
    });
    expect(result?.source).toBe('remote');
    expect(process.env.DB_PORT).toBe('5432');
    expect(proxy.hits()).toBeGreaterThanOrEqual(3);
    await result?.client.stop();
  });

  it('failFast: no answer after every attempt and no snapshot fails the boot', async () => {
    const root = await appRoot('');
    await expect(
      importRemoteConfig(root, {
        url: 'http://127.0.0.1:1/_config',
        token: 'shop-secret',
        partition: 'shop',
        snapshotPath: false,
        timeoutMs: 500,
        retry: { attempts: 2, initialMs: 10 },
        failFast: true,
      }),
    ).rejects.toBeInstanceOf(RemoteConfigUnavailableError);
  });

  it('failFast still boots from a snapshot', async () => {
    const url = await start([['mail.from', 'a@example.com']]);
    const root = await appRoot('');
    const first = await importRemoteConfig(root, {
      url,
      token: 'shop-secret',
      partition: 'shop',
      snapshotPath: 'snapshot.json',
    });
    await first?.client.stop();
    delete process.env.MAIL_FROM;
    const offline = await importRemoteConfig(root, {
      url: 'http://127.0.0.1:1/_config',
      token: 'shop-secret',
      partition: 'shop',
      snapshotPath: 'snapshot.json',
      timeoutMs: 500,
      failFast: true,
    });
    expect(offline?.source).toBe('snapshot');
    expect(process.env.MAIL_FROM).toBe('a@example.com');
    await offline?.client.stop();
  });
});
