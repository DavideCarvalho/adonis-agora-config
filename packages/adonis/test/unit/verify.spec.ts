import { describe, expect, it } from 'vitest';
import {
  checkVerifiedTenant,
  requestHeaders,
  resolveTenantVerifier,
  sharedSecretVerifier,
} from '../../src/topology/verify.js';

describe('checkVerifiedTenant', () => {
  it('accepts the shape every Agora verifier returns', () => {
    expect(checkVerifiedTenant(null)).toBeNull();
    expect(checkVerifiedTenant(undefined)).toBeNull();
    expect(
      checkVerifiedTenant({
        partition: 'shop',
        capabilities: ['config:read'],
        clientId: 'streaming',
        expiresAt: 5,
      }),
    ).toEqual({
      partition: 'shop',
      capabilities: ['config:read'],
      clientId: 'streaming',
      expiresAt: 5,
    });
  });

  it('throws on a malformed or legacy answer instead of accepting it', () => {
    expect(() => checkVerifiedTenant({})).toThrow(/must return/);
    expect(() => checkVerifiedTenant({ partition: 'shop' })).toThrow(/must return/);
    expect(() => checkVerifiedTenant({ partition: 'shop', capabilities: 'config:read' })).toThrow(
      /must return/,
    );
    expect(() => checkVerifiedTenant({ partition: 'shop', capabilities: [1] })).toThrow(
      /must return/,
    );
    expect(() => checkVerifiedTenant({ tenant: 'shop', capabilities: ['config:read'] })).toThrow(
      /rename it to `partition`/,
    );
  });
});

describe('resolveTenantVerifier', () => {
  const verifier = async ({ token }: { token?: string }) =>
    token === 'good' ? { partition: 'shop', capabilities: ['config:read'] } : null;

  it('accepts a plain function (the authkit verifier form)', async () => {
    const resolved = resolveTenantVerifier(verifier);
    expect(await resolved({ token: 'good' })).toMatchObject({ partition: 'shop' });
    expect(await resolved({ token: 'bad' })).toBeNull();
  });

  it('accepts a class instance and a class', async () => {
    class Checks {
      verify({ token }: { token?: string }) {
        return token === 'good' ? { partition: 'instance', capabilities: ['config:read'] } : null;
      }
    }
    const instance = resolveTenantVerifier(new Checks());
    expect(await instance({ token: 'good' })).toMatchObject({ partition: 'instance' });
    const constructed = resolveTenantVerifier(Checks);
    expect(await constructed({ token: 'good' })).toMatchObject({ partition: 'instance' });
  });

  it('accepts a zero-argument verifier', async () => {
    const zero = resolveTenantVerifier((async () => ({
      partition: 'zero',
      capabilities: ['config:read'],
    })) as never);
    expect(await zero({})).toMatchObject({ partition: 'zero' });
    const closed = resolveTenantVerifier((async () => null) as never);
    expect(await closed({})).toBeNull();
  });

  it('accepts a lazy import (default, named and tenantVerifier)', async () => {
    const fromDefault = resolveTenantVerifier(() =>
      Promise.resolve({ default: verifier as never }),
    );
    expect(await fromDefault({ token: 'good' })).toMatchObject({ partition: 'shop' });

    const fromVerify = resolveTenantVerifier(() => Promise.resolve({ verify: verifier as never }));
    expect(await fromVerify({ token: 'good' })).toMatchObject({ partition: 'shop' });

    const fromNamed = resolveTenantVerifier(() =>
      Promise.resolve({ tenantVerifier: verifier as never }),
    );
    expect(await fromNamed({ token: 'good' })).toMatchObject({ partition: 'shop' });
  });

  it('refuses an unusable verifier loudly', () => {
    expect(() => resolveTenantVerifier(undefined as never)).toThrow(/must be a function/);
    const broken = resolveTenantVerifier((async () => ({
      default: undefined,
      nothing: true,
    })) as never);
    return expect(broken({})).rejects.toThrow(/must return/);
  });
});

describe('sharedSecretVerifier', () => {
  const verify = sharedSecretVerifier({
    partitions: {
      shop: 'shop-secret',
      billing: {
        secret: 'billing-secret',
        environment: 'staging',
        label: 'staging',
        capabilities: ['config:read', 'config:secrets:read'],
      },
    },
  });

  it('derives the app, environment and capabilities from the secret', async () => {
    expect(await verify({ token: 'shop-secret', app: 'shop' })).toEqual({
      partition: 'shop',
      capabilities: ['config:read'],
    });
    // The authkit request vocabulary (`partition`) works too.
    expect(await verify({ token: 'shop-secret', partition: 'shop' })).toMatchObject({
      partition: 'shop',
    });
    expect(await verify({ token: 'billing-secret', app: 'billing' })).toEqual({
      partition: 'billing',
      capabilities: ['config:read', 'config:secrets:read'],
      environment: 'staging',
      label: 'staging',
    });
  });

  it('refuses a missing token, an unknown app, another app secret and an empty secret', async () => {
    expect(await verify({ app: 'shop' })).toBeNull();
    expect(await verify({ token: 'shop-secret' })).toBeNull();
    expect(await verify({ token: 'shop-secret', app: 'other' })).toBeNull();
    expect(await verify({ token: 'billing-secret', app: 'shop' })).toBeNull();
    expect(await verify({ token: '', app: 'shop' })).toBeNull();
  });
});

describe('requestHeaders', () => {
  it("calls headers() on the request, as Adonis' Request needs its `this`", () => {
    class FakeRequest {
      request = { headers: { Authorization: 'Bearer t', 'x-multi': ['a', 'b'] } };
      headers() {
        return this.request.headers;
      }
    }
    const ctx = { request: new FakeRequest() } as never;
    expect(requestHeaders(ctx)).toEqual({ authorization: 'Bearer t', 'x-multi': 'a' });
  });

  it('answers {} without a headers() method', () => {
    expect(requestHeaders({ request: {} } as never)).toEqual({});
  });
});
