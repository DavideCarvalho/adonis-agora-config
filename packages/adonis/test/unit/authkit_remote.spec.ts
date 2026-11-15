import { createServer, type Server } from 'node:http';
import { authkitTenantToken, authkitTenantVerifier } from '@adonis-agora/authkit-client';
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlane } from '../../src/http/control_plane.js';
import type { ConfigStore } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];
const issuerServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    [...servers, ...issuerServers]
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** An in-memory OIDC issuer: discovery + JWKS, and a token endpoint for authkitTenantToken. */
async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let issued = 0;
  const server = createServer((req, res) => {
    const base = addressOf(server);
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/oauth/token`,
          jwks_uri: `${base}/.well-known/jwks.json`,
        }),
      );
      return;
    }
    if (req.url === '/.well-known/jwks.json') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url === '/oauth/token' && req.method === 'POST') {
      issued += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          access_token: `token-${issued}`,
          token_type: 'Bearer',
          expires_in: 300,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  issuerServers.push(server);
  const base = addressOf(server);

  const mint = (
    claims: Record<string, unknown> = {},
    options: { audience?: string; expired?: boolean } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      client_id: 'streaming',
      partition: 'shop',
      capabilities: ['config:read'],
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test-key' })
      .setIssuer(base)
      .setAudience(options.audience ?? 'urn:agora:config')
      .setSubject('streaming')
      .setIssuedAt(now)
      .setExpirationTime(options.expired ? now - 60 : now + 300)
      .sign(privateKey);
  };

  return {
    base,
    mint,
    issued: () => issued,
    jwks: createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`)),
  };
}

function router(routes: Route[]) {
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
  };
}

async function start(store: ConfigStore, verifyTenant: ReturnType<typeof authkitTenantVerifier>) {
  const controlPlane = new ControlPlane({ store, verifyTenant, environment: 'production' });
  const routes: Route[] = [];
  controlPlane.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return addressOf(server);
}

const verifierFor = (issuer: string, environment?: string) =>
  authkitTenantVerifier({
    issuer,
    resource: 'urn:agora:config',
    ...(environment ? { environment } : {}),
  });

describe('authkit service-tenant auth (real authkit-client helpers)', () => {
  it('accepts a token verified against the issuer JWKS, with the partition from the claim', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    await seedConfig(store, testScope, [['db.host', 'localhost']]);
    await seedConfig(store, { ...testScope, app: 'billing' }, [['db.host', 'billing']]);
    const base = await start(store, verifierFor(oidc.base));

    const response = await fetch(`${base}/_config/v1/config`, {
      headers: {
        authorization: `Bearer ${await oidc.mint()}`,
        // The claimed app is ignored: the token says shop.
        'x-config-app': 'billing',
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.app).toBe('shop');
    expect(body.entries['db.host'].value).toBe('localhost');
  });

  it('refuses another audience, an expired token and a token the environment does not match', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    const base = await start(store, verifierFor(oidc.base));
    const wrongAudience = await fetch(`${base}/_config/v1/config`, {
      headers: {
        authorization: `Bearer ${await oidc.mint({}, { audience: 'urn:agora:flags' })}`,
      },
    });
    expect(wrongAudience.status).toBe(401);
    const expired = await fetch(`${base}/_config/v1/config`, {
      headers: { authorization: `Bearer ${await oidc.mint({}, { expired: true })}` },
    });
    expect(expired.status).toBe(401);

    const stagingBase = await start(store, verifierFor(oidc.base, 'staging'));
    const noEnvironment = await fetch(`${stagingBase}/_config/v1/config`, {
      headers: { authorization: `Bearer ${await oidc.mint()}` },
    });
    expect(noEnvironment.status).toBe(401);
    const staging = await fetch(`${stagingBase}/_config/v1/config`, {
      headers: { authorization: `Bearer ${await oidc.mint({ environment: 'staging' })}` },
    });
    expect(staging.status).toBe(200);
    expect((await staging.json()).environment).toBe('staging');
  });

  it('gates secrets on the token capabilities', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    await seedConfig(store, testScope, [{ key: 'p', value: 'hunter2', secret: true }]);
    const base = await start(store, verifierFor(oidc.base));

    const reader = await (
      await fetch(`${base}/_config/v1/config`, {
        headers: { authorization: `Bearer ${await oidc.mint()}` },
      })
    ).json();
    expect(reader.entries.p).toMatchObject({ masked: true });

    const privileged = await (
      await fetch(`${base}/_config/v1/config`, {
        headers: {
          authorization: `Bearer ${await oidc.mint({
            capabilities: ['config:read', 'config:secrets:read'],
          })}`,
        },
      })
    ).json();
    expect(privileged.entries.p).toMatchObject({ value: 'hunter2', masked: false });
  });

  it('refuses a token with no capabilities', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    const base = await start(store, verifierFor(oidc.base));
    const response = await fetch(`${base}/_config/v1/config`, {
      headers: { authorization: `Bearer ${await oidc.mint({ capabilities: [] })}` },
    });
    expect(response.status).toBe(403);
  });

  it('mints a token with authkitTenantToken, caches it and resets on demand', async () => {
    const oidc = await issuer();
    const token = authkitTenantToken({
      issuer: oidc.base,
      clientId: 'streaming',
      clientSecret: 'secret',
      resource: 'urn:agora:config',
    });
    expect(await token()).toBe('token-1');
    expect(await token.token()).toBe('token-1');
    expect(oidc.issued()).toBe(1);
    token.reset();
    expect(await token()).toBe('token-2');
    expect(oidc.issued()).toBe(2);
  });

  it('verifies a token minted by the issuer against the same JWKS', async () => {
    const oidc = await issuer();
    const token = await oidc.mint();
    const { payload } = await jwtVerify(token, oidc.jwks, {
      issuer: oidc.base,
      audience: 'urn:agora:config',
      typ: 'at+jwt',
    });
    expect(payload.partition).toBe('shop');
  });
});
