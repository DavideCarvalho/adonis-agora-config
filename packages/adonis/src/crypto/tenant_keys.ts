import type { ConfigScope, ConfigSealedTo, ConfigValue } from '@adonis-agora/config-core';
import type { OkpJwk } from '../crypto-kit/index.js';
import { sealedToKid, sealTo } from '../crypto-kit/index.js';
import type { ConfigStore, TenantPublicKey } from '../store/store.js';
import { entryAad } from './secrets.js';

/** The kit's key id shape; validated here because a public key comes in over HTTP. */
const KID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Validates a public key an app sent over HTTP: an X25519 OKP JWK with a `kid` and **no** private
 * part. Anything else is refused, so a tenant can never plant a key it cannot prove it holds.
 */
export function normalizePublicKey(value: unknown): OkpJwk {
  if (!value || typeof value !== 'object') {
    throw new TypeError('config: a tenant key must be an object');
  }
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519') {
    throw new TypeError('config: a tenant key must be an X25519 OKP JWK');
  }
  if (typeof jwk.x !== 'string' || jwk.x.length === 0) {
    throw new TypeError('config: a tenant key needs its public part (`x`)');
  }
  if (typeof jwk.kid !== 'string' || !KID.test(jwk.kid)) {
    throw new TypeError('config: a tenant key needs a `kid` matching [A-Za-z0-9._-]{1,128}');
  }
  if (jwk.d !== undefined) {
    throw new TypeError('config: a tenant registers PUBLIC keys only (no `d`)');
  }
  return { kty: 'OKP', crv: 'X25519', x: jwk.x, kid: jwk.kid, use: 'enc', alg: 'ECDH-ES' };
}

/** The key new `sealTo` writes use; the newest registration is the fallback. */
export function activeTenantKey(keys: readonly TenantPublicKey[]): TenantPublicKey | undefined {
  return keys.find((key) => key.active) ?? keys[0];
}

const PAYLOAD_LIMIT = 32;

/**
 * Registers the keys of one app from a `{ active, keys }` payload (the tenant API and the CLI).
 * The app is the verified token's partition, never the body. Returns the stored (public) keys.
 */
export async function registerTenantKeys(
  store: ConfigStore,
  app: string,
  payload: unknown,
  meta: { actor: string; now: string },
): Promise<TenantPublicKey[]> {
  if (!store.listTenantKeys || !store.registerTenantKey) {
    throw new Error('config: this store cannot keep tenant keys');
  }
  const body = (payload ?? {}) as { active?: unknown; keys?: unknown };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new TypeError('config: `keys` must be a non-empty array of public X25519 JWKs');
  }
  if (body.keys.length > PAYLOAD_LIMIT) {
    throw new TypeError(`config: at most ${PAYLOAD_LIMIT} keys per registration`);
  }
  const keys = body.keys.map(normalizePublicKey);
  const kids = new Set(keys.map((key) => key.kid));
  if (kids.size !== keys.length) {
    throw new TypeError('config: the same kid appears twice in one registration');
  }
  const active =
    body.active === undefined
      ? keys[0]!.kid
      : typeof body.active === 'string' && kids.has(body.active)
        ? body.active
        : undefined;
  if (active === undefined) {
    throw new TypeError('config: `active` must be the kid of one of the registered keys');
  }
  for (const key of keys) {
    await store.registerTenantKey({
      app,
      kid: key.kid,
      publicKey: key,
      active: key.kid === active,
      createdAt: meta.now,
      createdBy: meta.actor,
    });
  }
  return store.listTenantKeys(app);
}

/**
 * The control plane's side of `sealTo`: looks up the app's active public key and seals the JSON
 * value for it (AAD = app/environment/key). After this call the plaintext is gone from the server.
 */
export async function sealForApp(
  store: ConfigStore,
  scope: ConfigScope,
  key: string,
  value: ConfigValue,
  options: { kid?: string } = {},
): Promise<{ value: string; sealedTo: ConfigSealedTo }> {
  if (!store.listTenantKeys) {
    throw new Error('config: this store cannot keep tenant public keys');
  }
  const keys = await store.listTenantKeys(scope.app);
  const target = options.kid
    ? keys.find((candidate) => candidate.kid === options.kid)
    : activeTenantKey(keys);
  if (!target) {
    throw new Error(
      options.kid
        ? `config: no X25519 public key "${options.kid}" is registered for "${scope.app}"`
        : `config: no X25519 public key is registered for "${scope.app}" — run \`node ace config:tenant:key\` in that app first`,
    );
  }
  const sealed = sealTo(target.publicKey, JSON.stringify(value), { aad: entryAad(scope, key) });
  return { value: sealed, sealedTo: { app: scope.app, kid: target.kid } };
}

export interface TenantResealUpdate {
  key: string;
  /** The new `agora:pk1:…` value, sealed by the app to one of its registered keys. */
  value: string;
  kid: string;
}

/**
 * Applies re-sealed values: only entries that were already sealed to the app, only ciphertext the
 * app produced for a key it registered, and only for the version it read. The control plane writes
 * the ciphertext without ever opening it.
 */
export async function resealTenantEntries(
  store: ConfigStore,
  scope: ConfigScope,
  updates: readonly TenantResealUpdate[],
  context: { actor: string; now: string; version: number },
): Promise<{ version: number; changed: boolean; keys: string[] }> {
  const document = await store.read(scope);
  if (!document || document.version !== context.version) {
    throw new Error(
      `config: stale re-seal (expected v${document?.version ?? 0}, got v${context.version}); refresh and retry`,
    );
  }
  const registered = new Set(
    ((await store.listTenantKeys?.(scope.app)) ?? []).map((key) => key.kid),
  );
  const changes = updates.map((update) => {
    const entry = document.entries[update.key];
    if (!entry) throw new Error(`config: no entry "${update.key}" to re-seal`);
    if (entry.sealedTo === undefined) {
      throw new Error(`config: entry "${update.key}" is not sealed to an app`);
    }
    if (sealedToKid(update.value) !== update.kid) {
      throw new Error(
        `config: the value for "${update.key}" is not an agora:pk1 value for key "${update.kid}"`,
      );
    }
    if (!registered.has(update.kid)) {
      throw new Error(`config: key "${update.kid}" is not registered for "${scope.app}"`);
    }
    return {
      key: update.key,
      value: update.value,
      sealedTo: { app: scope.app, kid: update.kid } satisfies ConfigSealedTo,
    };
  });
  const result = await store.write(scope, changes, {
    actor: context.actor,
    now: context.now,
    message: 're-sealed to the app key',
  });
  return {
    version: result.document.version,
    changed: result.changed,
    keys: changes.map((change) => change.key),
  };
}
