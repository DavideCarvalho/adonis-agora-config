import { timingSafeEqual } from 'node:crypto';
import { CONFIG_SCOPES } from '@adonis-agora/config-core';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * What a control plane trusts about a request: derived from the verified token, never from the
 * request. The shape every Agora control plane uses — `authkitTenantVerifier` from
 * `@adonis-agora/authkit-client` returns it.
 */
export interface VerifiedTenant {
  /** The application (the partition). This is the ONLY source of the app a token may read. */
  partition: string;
  /** The environment the token may read. Default: the control plane's own environment. */
  environment?: string;
  /** The label (profile) the token may read. Default `main`. */
  label?: string;
  /** `config:read`, optionally `config:secrets:read`. Never empty. */
  capabilities: string[];
  /** The service-tenant client behind the token, when it says. */
  clientId?: string;
  /** Epoch ms after which streams opened with this token must close. */
  expiresAt?: number;
}

/** What a verifier receives. Only `token` is trusted, once verified. */
export interface TenantAuthRequest {
  /** The bearer token (or the shared secret). */
  token?: string | undefined;
  /** The partition the caller claims (`x-config-app`). Advisory only. */
  partition?: string | undefined;
  /** Same as `partition` (the wire name other libs use). Advisory only. */
  tenant?: string | undefined;
  /** The app the caller claims; the name this package uses for `partition`. */
  app?: string | undefined;
  environment?: string | undefined;
  label?: string | undefined;
  headers?: Readonly<Record<string, string | undefined>> | undefined;
}

/** The top-level `verifyTenant` contract. */
export type TenantVerifier = (
  request: TenantAuthRequest,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/** A class instance implementing `verify`. */
export interface TenantVerifierObject {
  verify(request: TenantAuthRequest): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

/** A lazily imported verifier module: a verifier, a class, or an object with `verify`. */
export interface TenantVerifierModule {
  default?: TenantVerifier | TenantVerifierObject | (new () => TenantVerifierObject);
  verify?: TenantVerifier | TenantVerifierObject;
  tenantVerifier?: TenantVerifier | TenantVerifierObject;
}

/** The accepted forms: a function, a class instance, a class, or a lazy `() => import(...)`. */
export type TenantVerifierInput =
  | TenantVerifier
  | TenantVerifierObject
  | (new () => TenantVerifierObject)
  | (() => Promise<TenantVerifierModule> | TenantVerifierModule);

function hasVerify(value: unknown): value is TenantVerifierObject {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { verify?: unknown }).verify === 'function'
  );
}

function isVerifierClass(value: unknown): value is new () => TenantVerifierObject {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { verify?: unknown } }).prototype?.verify === 'function'
  );
}

/**
 * Validates a verifier's answer. `null` refuses; `{ partition, capabilities }` accepts; anything
 * else throws, so a malformed answer is never taken for an accepted tenant. Capabilities are NOT
 * defaulted: a verifier must say what the token may do.
 */
export function checkVerifiedTenant(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const value = result as Partial<VerifiedTenant> & { tenant?: unknown; scope?: unknown };
  if (
    typeof value === 'object' &&
    typeof value.partition === 'string' &&
    value.partition.length > 0 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === 'string') &&
    (value.environment === undefined || typeof value.environment === 'string') &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.clientId === undefined || typeof value.clientId === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'number')
  ) {
    return value as VerifiedTenant;
  }
  throw new TypeError(
    `[@adonis-agora/config] verifyTenant must return { partition: string, environment?: string, capabilities: string[] } or null${
      value && typeof result === 'object' && 'tenant' in value
        ? ' (it returned `tenant`; rename it to `partition`)'
        : ''
    }`,
  );
}

/**
 * Turns any `verifyTenant` form into the function the control plane calls: a function, an object
 * with `verify` (a class instance), a class, or a lazy import of one. Authkit's
 * `authkitTenantVerifier()` is the function form and needs no wrapper.
 */
export function resolveTenantVerifier(
  input: TenantVerifierInput,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  if (isVerifierClass(input)) {
    let instance: TenantVerifierObject | undefined;
    return async (request) => {
      instance ??= new input();
      return checkVerifiedTenant(await instance.verify(request));
    };
  }
  if (hasVerify(input)) {
    return async (request) => checkVerifiedTenant(await input.verify(request));
  }
  if (typeof input !== 'function') {
    throw new TypeError(
      '[@adonis-agora/config] `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
    );
  }
  // A verifier function — or a lazy import factory. Call it with the request; if what comes back is
  // a module, remember the verifier inside it. Authkit's verifier is the plain-function case.
  const fn = input as (request: TenantAuthRequest) => unknown;
  let lazy: Promise<(request: TenantAuthRequest) => Promise<VerifiedTenant | null>> | undefined;
  return async (request) => {
    if (lazy) return (await lazy)(request);
    const result = await fn(request);
    const exported =
      result && typeof result === 'object' && 'default' in (result as Record<string, unknown>)
        ? (result as TenantVerifierModule).default
        : undefined;
    const named =
      exported ??
      (result && typeof result === 'object'
        ? ((result as TenantVerifierModule).tenantVerifier ??
          (result as TenantVerifierModule).verify)
        : undefined);
    if (named !== undefined) {
      lazy = Promise.resolve(resolveTenantVerifier(named as TenantVerifierInput));
      return (await lazy)(request);
    }
    return checkVerifiedTenant(result);
  };
}

/** Constant-time comparison that does not leak the length through an early return. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still compare, so timing does not reveal where the difference is.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface SharedSecretTenant {
  secret: string;
  environment?: string;
  label?: string;
  /** Default `['config:read']`. Add `config:secrets:read` only where secrets are needed. */
  capabilities?: string[];
}

/**
 * One shared secret per app, compared in constant time. The caller names its app with
 * `x-config-app`; the secret proves it. Without authkit this is the whole auth story.
 */
export function sharedSecretVerifier(options: {
  partitions: Record<string, string | SharedSecretTenant>;
}): TenantVerifier {
  return (request) => {
    const app = request.app ?? request.partition ?? request.tenant;
    if (!request.token || !app) return null;
    const entry = options.partitions[app];
    if (entry === undefined) return null;
    const config = typeof entry === 'string' ? { secret: entry } : entry;
    if (!sameSecret(request.token, config.secret)) return null;
    return {
      partition: app,
      capabilities: config.capabilities ?? [CONFIG_SCOPES.read],
      ...(config.environment ? { environment: config.environment } : {}),
      ...(config.label ? { label: config.label } : {}),
    };
  };
}

/** The bearer token of a request (`authorization: Bearer`), or `x-api-key` for shared secrets. */
export function bearerToken(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  return ctx.request.header('x-api-key') ?? undefined;
}

/** The headers a verifier may need, lowercased. */
export function requestHeaders(ctx: HttpContext): Record<string, string | undefined> {
  const headers = (ctx.request as unknown as { headers?: () => Record<string, string | string[]> })
    .headers;
  if (typeof headers !== 'function') return {};
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers())) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}
