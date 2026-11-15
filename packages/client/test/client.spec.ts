import { createServer, type Server } from 'node:http';
import { authkitTenantToken } from '@adonis-agora/authkit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigClient, fetchConfig } from '../src/index.js';

const servers: Server[] = [];

function addressOf(server: Server): string {
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('server is not listening');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const entry = (value: unknown) => ({
  value,
  secret: false,
  reloadable: false,
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'ann',
  masked: false,
});

const document = {
  app: 'shop',
  environment: 'production',
  label: 'main',
  version: 3,
  fingerprint: 'abc',
  entries: {
    'db.host': entry('localhost'),
    'db.port': entry(5432),
    'checkout.timeoutMs': entry(3000),
  },
  createdAt: new Date(0).toISOString(),
  createdBy: 'ann',
};

async function controlPlane(token = 'good') {
  let fetches = 0;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url?.startsWith('/_config/v1/whoami')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          resource: 'urn:agora:config',
          partition: 'shop',
          environment: 'production',
          label: 'main',
          capabilities: ['config:read'],
        }),
      );
      return;
    }
    if (req.url?.startsWith('/_config/v1/config')) {
      fetches += 1;
      if (req.headers['if-none-match'] === '"shop:production:main:3"') {
        res.writeHead(304, { etag: '"shop:production:main:3"' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(document));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  return { url: `${addressOf(server)}/_config`, fetches: () => fetches };
}

/** A `fetch` that behaves like the browser's: called with any `this` but the global, it throws. */
const strictFetch = function (
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (this !== globalThis) throw new TypeError('Illegal invocation');
  return fetch(input, init);
} as unknown as typeof fetch;

describe('ConfigClient', () => {
  it('calls fetch bound to the global object (no Illegal invocation)', async () => {
    const { url } = await controlPlane();
    const client = await fetchConfig({
      url,
      partition: 'shop',
      token: 'good',
      fetch: strictFetch,
    });
    expect(client.get('db.host')).toBe('localhost');
  });

  it('fetches a scope and exposes values, nested and status', async () => {
    const { url } = await controlPlane();
    const client = await fetchConfig({
      url,
      partition: 'shop',
      environment: 'production',
      token: 'good',
    });
    expect(client.get('db.host')).toBe('localhost');
    expect(client.get('missing', 'fallback')).toBe('fallback');
    expect(client.has('db.port')).toBe(true);
    expect(client.values()).toEqual({
      'db.host': 'localhost',
      'db.port': 5432,
      'checkout.timeoutMs': 3000,
    });
    expect(client.nested()).toEqual({
      db: { host: 'localhost', port: 5432 },
      checkout: { timeoutMs: 3000 },
    });
    expect(client.status()).toMatchObject({
      app: 'shop',
      environment: 'production',
      label: 'main',
      version: 3,
      fingerprint: 'abc',
      source: 'remote',
      stale: false,
    });
  });

  it('does a conditional GET and reports whether anything changed', async () => {
    const { url, fetches } = await controlPlane();
    const client = createConfigClient({ url, partition: 'shop', token: 'good' });
    expect(await client.refresh()).toBe(true);
    expect(await client.refresh()).toBe(false);
    expect(fetches()).toBe(2);
    expect(client.status().lastError).toBeNull();
  });

  it('invalidates the token on 401 and reports the error', async () => {
    const { url } = await controlPlane('other');
    const invalidate = vi.fn();
    const client = createConfigClient({
      url,
      partition: 'shop',
      token: { get: async () => 'stale', invalidate },
    });
    expect(await client.refresh()).toBe(false);
    expect(invalidate).toHaveBeenCalled();
    expect(client.status()).toMatchObject({
      source: 'none',
      lastError: expect.stringContaining('401'),
    });
    await expect(client.load()).rejects.toThrow(/401/);
  });

  it('fetches until a server answers, and whoami says what the token is', async () => {
    const { url } = await controlPlane();
    const client = createConfigClient({ url, partition: 'shop', token: 'good' });
    expect(await client.whoami()).toMatchObject({
      partition: 'shop',
      capabilities: ['config:read'],
    });
  });

  it('uses authkitTenantToken and resets it after a 401', async () => {
    let issued = 0;
    const issuer = createServer((req, res) => {
      const base = addressOf(issuer);
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/oauth/token`,
            jwks_uri: `${base}/jwks.json`,
          }),
        );
        return;
      }
      if (req.url === '/oauth/token') {
        issued += 1;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: `token-${issued}`, expires_in: 300 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', () => resolve()));
    servers.push(issuer);

    // The control plane refuses the first token and accepts the next one.
    let seen = 0;
    const plane = createServer((_req, res) => {
      seen += 1;
      if (seen === 1) {
        res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(document));
    });
    await new Promise<void>((resolve) => plane.listen(0, '127.0.0.1', () => resolve()));
    servers.push(plane);

    const token = authkitTenantToken({
      issuer: addressOf(issuer),
      clientId: 'shop',
      clientSecret: 'secret',
      resource: 'urn:agora:config',
    });
    const reset = vi.spyOn(token, 'reset');
    const client = createConfigClient({
      url: `${addressOf(plane)}/_config`,
      partition: 'shop',
      token,
    });

    // The 401 resets the token; the retry with the fresh one succeeds in the same refresh.
    expect(await client.refresh()).toBe(true);
    expect(reset).toHaveBeenCalled();
    expect(issued).toBe(2);
    expect(client.status()).toMatchObject({ version: 3, lastError: null });
  });

  it('reports a persistent 401 after resetting the token once', async () => {
    let issued = 0;
    const issuer = createServer((req, res) => {
      const base = addressOf(issuer);
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/oauth/token`,
            jwks_uri: `${base}/jwks.json`,
          }),
        );
        return;
      }
      if (req.url === '/oauth/token') {
        issued += 1;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: `token-${issued}`, expires_in: 300 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', () => resolve()));
    servers.push(issuer);

    const plane = createServer((_req, res) => {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => plane.listen(0, '127.0.0.1', () => resolve()));
    servers.push(plane);

    const token = authkitTenantToken({
      issuer: addressOf(issuer),
      clientId: 'shop',
      clientSecret: 'secret',
      resource: 'urn:agora:config',
    });
    const reset = vi.spyOn(token, 'reset');
    const client = createConfigClient({
      url: `${addressOf(plane)}/_config`,
      partition: 'shop',
      token,
    });
    expect(await client.refresh()).toBe(false);
    expect(reset).toHaveBeenCalled();
    expect(client.status().lastError).toContain('401');
    expect(issued).toBe(2);
  });

  it('refuses a missing token without a URL', () => {
    expect(() => createConfigClient({ url: '', partition: 'shop', token: 'x' })).toThrow(/url/);
  });
});
