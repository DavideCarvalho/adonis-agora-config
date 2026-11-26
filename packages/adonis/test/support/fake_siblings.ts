import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  AuthkitClientLike,
  CryptoOperationsLike,
  CryptoRuntimeLike,
  CryptoServiceLike,
} from '../../src/federation/console_auth.js';

type Principal = { partition: string; capabilities: string[]; actor: string };

/** Crypto's rule: segment by segment, a trailing `*` covers the rest, `name-*` is a name prefix. */
function allows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  return granted.some((capability) => {
    const have = capability.split(':');
    for (let i = 0; i < have.length; i += 1) {
      const segment = have[i]!;
      if (segment === '*' && i === have.length - 1) return true;
      const target = want[i];
      if (target === undefined) return false;
      if (segment === '*') continue;
      if (segment.endsWith('*') ? !target.startsWith(segment.slice(0, -1)) : segment !== target) {
        return false;
      }
    }
    return have.length === want.length;
  });
}

/**
 * A stand-in for an @adonis-agora/crypto server: keys per partition, capabilities checked like the
 * real service (`crypto:encrypt:<key>`, `crypto:decrypt:<key>`, `crypto:keys:manage:<key>`, and
 * `crypto:seal:<key>` for a tenant sealing with another partition's key).
 */
export class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>();
  readonly audit: Array<{ op: string; partition: string; key: string; actor: string }> = [];
  /** Answer cross-partition seals like a server that predates them. */
  old = false;

  #need(principal: Principal, capability: string) {
    if (!allows(principal.capabilities, capability)) {
      throw Object.assign(new Error(`crypto: the token lacks ${capability}`), {
        code: 'forbidden',
      });
    }
  }

  #key(partition: string, key: string): Buffer {
    const material = this.keys.get(`${partition}/${key}`);
    if (!material) {
      throw Object.assign(new Error(`crypto: no key named "${key}"`), { code: 'not_found' });
    }
    return material;
  }

  readonly service: CryptoServiceLike = {
    encrypt: async (principal, { key, plaintext, aad }) => {
      this.#need(principal, `crypto:encrypt:${key}`);
      this.audit.push({
        op: 'encrypt',
        partition: principal.partition,
        key,
        actor: principal.actor,
      });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key(principal.partition, key), iv);
      cipher.setAAD(Buffer.from(aad ?? ''));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
      };
    },
    decrypt: async (principal, { key, ciphertext, aad }) => {
      this.#need(principal, `crypto:decrypt:${key}`);
      const material = this.#key(principal.partition, key);
      this.audit.push({
        op: 'decrypt',
        partition: principal.partition,
        key,
        actor: principal.actor,
      });
      const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', material, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad ?? ''));
      decipher.setAuthTag(raw.subarray(12, 28));
      return {
        plaintext: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(),
      };
    },
    createKey: async (principal, { name }) => {
      this.#need(principal, `crypto:keys:manage:${name}`);
      if (this.keys.has(`${principal.partition}/${name}`)) throw new Error('crypto: conflict');
      this.keys.set(`${principal.partition}/${name}`, randomBytes(32));
      this.audit.push({
        op: 'create',
        partition: principal.partition,
        key: name,
        actor: principal.actor,
      });
      return { name };
    },
    store: {
      getKey: async (partition, name) => (this.keys.has(`${partition}/${name}`) ? { name } : null),
    },
  };

  /** What `runtime.operations` does for a client of `partition` holding `capabilities`. */
  operations(partition: string, capabilities: string[]): CryptoOperationsLike {
    const principal = { partition, capabilities, actor: `client:${partition}` };
    return {
      encrypt: async ({ partition: target, ...input }) => {
        if (target !== undefined && target !== partition) {
          if (this.old) throw new Error('crypto: unknown field "partition"');
          this.#need(principal, `crypto:seal:${input.key}`);
          return this.service.encrypt(
            {
              partition: target,
              capabilities: [`crypto:encrypt:${input.key}`],
              actor: principal.actor,
            },
            input,
          );
        }
        return this.service.encrypt(principal, input);
      },
      // §2e.A: a tenant opens its own `console-*` keys without any grant (never cross-partition).
      decrypt: (input) =>
        this.service.decrypt(
          input.key.startsWith('console-')
            ? {
                ...principal,
                capabilities: [...principal.capabilities, `crypto:decrypt:${input.key}`],
              }
            : principal,
          input,
        ),
      createKey: (input) => this.service.createKey(principal, input),
    };
  }

  /** `'agora.crypto'` where crypto is embedded in the app (standalone or control plane). */
  embedded(partition: string): CryptoRuntimeLike {
    return {
      topology: 'standalone',
      partition,
      service: this.service,
      operations: this.operations(partition, ['crypto:*']),
    };
  }

  /** `'agora.crypto'` on a tenant of this server, with its client's grant. */
  tenant(
    partition: string,
    capabilities: string[],
    options: { hasKey?: boolean } = {},
  ): CryptoRuntimeLike {
    const operations = this.operations(partition, capabilities);
    if (options.hasKey) {
      // Newer servers (§13f): own-partition check, never audited.
      operations.hasKey = async ({ key }) => this.keys.has(`${partition}/${key}`);
    }
    return { topology: 'tenant', partition, operations };
  }
}

/**
 * A stand-in for authkit: app-call tokens are `call:<from>:<to>`, granted per pair, and each app's
 * `authkit.client` hands out tokens for its `apps` and verifies the ones addressed to it.
 */
export class FakeAuthkit {
  readonly grants = new Map<string, string[]>();
  /** authkit's key directory: `<app>/<purpose>` → public JWK. */
  readonly directory = new Map<string, Record<string, unknown>>();
  issued = 0;

  grant(from: string, to: string, capabilities: string[]) {
    this.grants.set(`${from}->${to}`, capabilities);
  }

  /** When set, minting an app-call token fails with this message (and `mintCode`, when set). */
  mintError: string | undefined;
  mintCode: string | undefined;

  client(self: string, options: { calls?: boolean; verifies?: boolean } = {}): AuthkitClientLike {
    return {
      publishAppKey: async ({ purpose, jwk }) => {
        this.directory.set(`${self}/${purpose}`, jwk);
      },
      appKey: async ({ app, purpose }) =>
        (this.directory.get(`${app}/${purpose}`) as never) ?? null,
      appCallTokens: () =>
        options.calls === false
          ? undefined
          : {
              token: async (app: string) => {
                if (this.mintError) {
                  throw Object.assign(new Error(this.mintError), {
                    ...(this.mintCode ? { code: this.mintCode } : {}),
                  });
                }
                this.issued += 1;
                return `call:${self}:${app}`;
              },
              reset: () => {},
            },
      appCallerVerifier: () =>
        options.verifies === false
          ? null
          : {
              verifyToken: async (token: string) => {
                const [kind, from, to] = token.split(':');
                if (kind !== 'call' || to !== self || !from) return null;
                const capabilities = this.grants.get(`${from}->${to}`);
                if (!capabilities) return null;
                return {
                  app: from,
                  capabilities,
                  clientId: `${from}-client`,
                  expiresAt: Date.now() + 60_000,
                };
              },
            },
    };
  }
}
