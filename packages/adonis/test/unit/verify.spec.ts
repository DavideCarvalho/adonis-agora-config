import { describe, expect, it } from 'vitest';
import {
  normalizeVerifiedTenant,
  resolveTenantVerifier,
  sharedSecretVerifier,
  verifiers,
} from '../../src/topology/verify.js';

describe('normalizeVerifiedTenant', () => {
  it('accepts partition or tenant, capabilities or scope', () => {
    expect(normalizeVerifiedTenant(null)).toBeNull();
    expect(normalizeVerifiedTenant({})).toBeNull();
    expect(normalizeVerifiedTenant({ partition: 'shop', capabilities: ['config:read'] })).toEqual({
      partition: 'shop',
      capabilities: ['config:read'],
    });
    expect(
      normalizeVerifiedTenant({ tenant: 'shop', scope: 'config:read config:secrets:read' }),
    ).toEqual({ partition: 'shop', capabilities: ['config:read', 'config:secrets:read'] });
    expect(normalizeVerifiedTenant({ tenant: 'shop' })?.capabilities).toEqual(['config:read']);
    expect(
      normalizeVerifiedTenant({ partition: 'shop', environment: 'staging', expiresAt: 5 }),
    ).toMatchObject({ environment: 'staging', expiresAt: 5 });
  });
});

describe('resolveTenantVerifier', () => {
  const verifier = async ({ token }: { token?: string }) =>
    token === 'good' ? { partition: 'shop', capabilities: ['config:read'] } : null;

  it('accepts a plain function', async () => {
    const resolved = await resolveTenantVerifier(verifier);
    expect(await resolved({ token: 'good' })).toMatchObject({ partition: 'shop' });
    expect(await resolved({ token: 'bad' })).toBeNull();
  });

  it('accepts a class instance and a class', async () => {
    class Checks {
      verify({ token }: { token?: string }) {
        return token === 'good' ? { partition: 'instance', capabilities: ['config:read'] } : null;
      }
    }
    const instance = await resolveTenantVerifier(new Checks());
    expect(await instance({ token: 'good' })).toMatchObject({ partition: 'instance' });
    const constructed = await resolveTenantVerifier(Checks);
    expect(await constructed({ token: 'good' })).toMatchObject({ partition: 'instance' });
  });

  it('accepts a zero-argument verifier as well as a lazy import', async () => {
    const zero = await resolveTenantVerifier((async () => ({
      partition: 'zero',
      capabilities: ['config:read'],
    })) as never);
    expect(await zero({})).toMatchObject({ partition: 'zero' });
    const closed = await resolveTenantVerifier((async () => null) as never);
    expect(await closed({})).toBeNull();
  });

  it('accepts a lazy import (default, named and tenantVerifier)', async () => {
    const fromDefault = await resolveTenantVerifier(() =>
      Promise.resolve({ default: verifier as never }),
    );
    expect(await fromDefault({ token: 'good' })).toMatchObject({ partition: 'shop' });

    const fromVerify = await resolveTenantVerifier(() =>
      Promise.resolve({ verify: verifier as never }),
    );
    expect(await fromVerify({ token: 'good' })).toMatchObject({ partition: 'shop' });

    const fromNamed = await resolveTenantVerifier(() =>
      Promise.resolve({ tenantVerifier: verifier as never }),
    );
    expect(await fromNamed({ token: 'good' })).toMatchObject({ partition: 'shop' });
  });

  it('refuses an unusable verifier loudly', async () => {
    await expect(resolveTenantVerifier(undefined as never)).rejects.toThrow(/must be a function/);
    await expect(
      resolveTenantVerifier((() => Promise.resolve({ default: undefined })) as never),
    ).rejects.toThrow(/exports no verifier/);
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

  it('is available under the ecosystem name `verifiers.sharedSecret`', () => {
    expect(verifiers.sharedSecret).toBe(sharedSecretVerifier);
  });
});
