import { authkitTenantVerifier } from '@adonis-agora/authkit-client';
import { describe, expect, it } from 'vitest';
import { defineConfig, resolveStandaloneApp, stores } from '../../src/define_config.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';

describe('defineConfig', () => {
  it('accepts a control plane with the authkit verifier or a shared secret', () => {
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant: authkitTenantVerifier({
          issuer: 'https://auth.example.com',
          resource: 'urn:agora:config',
        }),
      }),
    ).not.toThrow();
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant: sharedSecretVerifier({ partitions: { shop: 's' } }),
      }),
    ).not.toThrow();
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant: { verify: async () => null },
      }),
    ).not.toThrow();
  });

  it('refuses a control plane without verifyTenant', () => {
    expect(() => defineConfig({ topology: 'control-plane' } as never)).toThrow(
      /needs `verifyTenant`/,
    );
  });

  it('refuses verifyTenant outside a control plane', () => {
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://config.example.com/_config', partition: 'shop', token: 's' },
        verifyTenant: async () => null,
      } as never),
    ).toThrow(/only applies to topology/);
    expect(() =>
      defineConfig({
        topology: 'standalone',
        app: 'shop',
        verifyTenant: async () => null,
      } as never),
    ).toThrow(/only applies to topology/);
  });

  it('refuses a tenant without a URL, partition or token', () => {
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: '', partition: 'shop', token: 's' } }),
    ).toThrow(/tenant.url/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://c.test', partition: '', token: 's' },
      }),
    ).toThrow(/tenant.partition/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://c.test', partition: 'shop' },
      } as never),
    ).toThrow(/tenant.token/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'relative', partition: 'shop', token: 's' },
      }),
    ).toThrow(/absolute/);
  });

  it('accepts a standalone app and a memory store', () => {
    expect(() =>
      defineConfig({ topology: 'standalone', app: 'shop', store: stores.memory() }),
    ).not.toThrow();
    // `app` is optional: the provider falls back to APP_NAME when set.
    expect(defineConfig({ topology: 'standalone' } as never)).toMatchObject({
      topology: 'standalone',
    });
    expect(resolveStandaloneApp(undefined, 'Entre Textos')).toBe('Entre Textos');
    expect(resolveStandaloneApp('shop', 'Entre Textos')).toBe('shop');
    expect(resolveStandaloneApp(undefined, undefined)).toBeUndefined();
  });
});
