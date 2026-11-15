import { createServer, type Server } from 'node:http';
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlane } from '../../src/http/control_plane.js';
import type { ConfigStore } from '../../src/store/store.js';
import { memoryConfig, seedConfig, testScope } from '../../src/testing/index.js';
import { tokens } from '../../src/topology/token.js';
import {
  resolveTenantVerifier,
  type TenantAuthRequest,
  type TenantVerifier,
} from '../../src/topology/verify.js';
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

/** An in-memory OIDC issuer: discovery + JWKS, and a token endpoint for the client-credentials test. */
async function issuer(options: { audience?: string } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let issued = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/.well-known/openid-configuration') {
      const base = addressOf(server);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: base,
          jwks_uri: `${base}/.well-known/jwks.json`,
          token_endpoint: `${base}/oauth/token`,
        }),
      );
      return;
    }
    if (url.pathname === '/.well-known/jwks.json') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
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
    tokenOptions: { audience?: string; expired?: boolean } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      partition: 'shop',
      scope: 'config:read',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test-key' })
      .setIssuer(base)
      .setAudience(tokenOptions.audience ?? options.audience ?? 'urn:agora:config')
      .setSubject('service-tenant')
      .setIssuedAt(now)
      .setExpirationTime(tokenOptions.expired ? now - 60 : now + 300)
      .sign(privateKey);
  };

  return { base, mint, issued: () => issued };
}

/** The remote verifier the authkit-client helper encapsulates: JWKS + `partition`/`scope` claims. */
function remoteVerifier(options: { issuer: string; audience: string }): TenantVerifier {
  const jwks = createRemoteJWKSet(new URL(`${options.issuer}/.well-known/jwks.json`));
  return async ({ token }: TenantAuthRequest) => {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        typ: 'at+jwt',
      });
      if (typeof payload.partition !== 'string') return null;
      return {
        partition: payload.partition,
        capabilities:
          typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
        ...(typeof payload.environment === 'string' ? { environment: payload.environment } : {}),
        ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp * 1000 } : {}),
      };
    } catch {
      return null;
    }
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

async function start(store: ConfigStore, verifyTenant: TenantVerifier) {
  const controlPlane = new ControlPlane({ store, verifyTenant, environment: 'production' });
  const routes: Route[] = [];
  controlPlane.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return addressOf(server);
}

describe('authkit-style remote tenant auth (in-memory issuer)', () => {
  it('accepts a token verified against the issuer JWKS, with the partition from the claim', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    await seedConfig(store, testScope, [['db.host', 'localhost']]);
    await seedConfig(store, { ...testScope, app: 'billing' }, [['db.host', 'billing']]);
    // The lazy-import form of `verifyTenant`, exactly as a control plane would configure it.
    const verifyTenant = await resolveTenantVerifier(() =>
      Promise.resolve({
        default: remoteVerifier({ issuer: oidc.base, audience: 'urn:agora:config' }),
      }),
    );
    const base = await start(store, verifyTenant);

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

  it('refuses another audience and an expired token', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    const base = await start(
      store,
      remoteVerifier({ issuer: oidc.base, audience: 'urn:agora:config' }),
    );
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
  });

  it('gates secrets on the token scope', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    await seedConfig(store, testScope, [{ key: 'p', value: 'hunter2', secret: true }]);
    const base = await start(
      store,
      remoteVerifier({ issuer: oidc.base, audience: 'urn:agora:config' }),
    );

    const reader = await (
      await fetch(`${base}/_config/v1/config`, {
        headers: { authorization: `Bearer ${await oidc.mint()}` },
      })
    ).json();
    expect(reader.entries.p).toMatchObject({ masked: true });

    const privileged = await (
      await fetch(`${base}/_config/v1/config`, {
        headers: {
          authorization: `Bearer ${await oidc.mint({ scope: 'config:read config:secrets:read' })}`,
        },
      })
    ).json();
    expect(privileged.entries.p).toMatchObject({ value: 'hunter2', masked: false });
  });

  it('refuses a token with no capabilities', async () => {
    const oidc = await issuer();
    const store = memoryConfig();
    const base = await start(
      store,
      remoteVerifier({ issuer: oidc.base, audience: 'urn:agora:config' }),
    );
    const response = await fetch(`${base}/_config/v1/config`, {
      headers: { authorization: `Bearer ${await oidc.mint({ scope: '' })}` },
    });
    expect(response.status).toBe(403);
  });
});

describe('tokens.clientCredentials', () => {
  it('discovers the token endpoint and caches the token', async () => {
    const oidc = await issuer();
    const source = tokens.clientCredentials({
      issuer: oidc.base,
      clientId: 'shop',
      clientSecret: 'secret',
      fetch: fetch,
    });
    expect(await source.get()).toBe('token-1');
    expect(await source.get()).toBe('token-1');
    expect(oidc.issued()).toBe(1);
    source.invalidate?.();
    expect(await source.get()).toBe('token-2');
  });

  it('fails clearly when discovery or the token endpoint fails', async () => {
    const source = tokens.clientCredentials({
      issuer: 'http://127.0.0.1:1',
      clientId: 'shop',
      clientSecret: 'secret',
    });
    await expect(source.get()).rejects.toThrow(/discovery/);
  });
});
