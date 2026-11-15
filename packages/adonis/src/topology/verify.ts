import { timingSafeEqual } from 'node:crypto';
import { CONFIG_SCOPES } from '@adonis-agora/config-core';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * What a control plane trusts about a request: always derived from the verified token, never from
 * the request body or the URL. Same vocabulary as `@adonis-agora/durable` and
 * `@adonis-agora/flags`, so one authkit service tenant can serve every control plane.
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
  /** Epoch ms after which streams opened with this token must close. */
  expiresAt?: number;
}

/**
 * What a verifier receives. `app`/`environment`/`label` are what the caller CLAIMS (headers); they
 * are trusted only because the verifier compares them with the token. `headers` are all lowercased.
 */
export interface TenantAuthRequest {
  /** The bearer token (or the shared secret). */
  token?: string | undefined;
  /** The claimed partition (`x-config-app`). */
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

/** The three accepted forms: a function, a class instance, or a lazy `() => import(...)`. */
export type TenantVerifierInput =
  | TenantVerifier
  | TenantVerifierObject
  | (new () => TenantVerifierObject)
  | (() => Promise<TenantVerifierModule> | TenantVerifierModule);

/** What a lazily imported verifier module may export. */
export interface TenantVerifierModule {
  default?: TenantVerifier | TenantVerifierObject | (new () => TenantVerifierObject);
  verify?: TenantVerifier;
  tenantVerifier?: TenantVerifier;
}

/** A verifier whose shape a verifier factory (e.g. authkit-client) may return. */
type AnyVerifierResult = {
  partition?: unknown;
  tenant?: unknown;
  environment?: unknown;
  label?: unknown;
  capabilities?: unknown;
  scope?: unknown;
  expiresAt?: unknown;
} | null;

/** Normalizes `partition`/`tenant`, `capabilities`/`scope` — durable, flags and the spec agree on meaning. */
export function normalizeVerifiedTenant(value: AnyVerifierResult): VerifiedTenant | null {
  if (!value || typeof value !== 'object') return null;
  const partition = value.partition ?? value.tenant;
  if (typeof partition !== 'string' || partition.length === 0) return null;
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter(
        (capability): capability is string => typeof capability === 'string',
      )
    : typeof value.scope === 'string'
      ? value.scope.split(/\s+/).filter(Boolean)
      : [CONFIG_SCOPES.read];
  return {
    partition,
    ...(typeof value.environment === 'string' && value.environment !== ''
      ? { environment: value.environment }
      : {}),
    ...(typeof value.label === 'string' && value.label !== '' ? { label: value.label } : {}),
    capabilities,
    ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
  };
}

async function fromModule(
  module: TenantVerifierModule | TenantVerifierObject | TenantVerifier,
): Promise<TenantVerifier> {
  if (typeof module === 'function') return resolveTenantVerifier(module as TenantVerifierInput);
  if (
    module &&
    typeof module === 'object' &&
    'verify' in module &&
    typeof module.verify === 'function'
  ) {
    const instance = module as TenantVerifierObject;
    return (request) => instance.verify(request);
  }
  const exported =
    (module as TenantVerifierModule).default ?? (module as TenantVerifierModule).verify;
  if (exported !== undefined) return resolveTenantVerifier(exported as TenantVerifierInput);
  const named = (module as TenantVerifierModule).tenantVerifier;
  if (named !== undefined) return resolveTenantVerifier(named);
  throw new Error('@adonis-agora/config: the lazily imported verifier exports no verifier');
}

/**
 * Resolves the three accepted `verifyTenant` forms: a function, a class instance (or class), or a
 * lazy `() => import('./verifier.js')`. Lazy imports keep authkit (and any other OIDC library) out of
 * the module graph of an app that does not use it.
 */
export async function resolveTenantVerifier(input: TenantVerifierInput): Promise<TenantVerifier> {
  if (typeof input === 'function') {
    // A class: it has a prototype with `verify`.
    const prototype = (input as { prototype?: { verify?: unknown } }).prototype;
    if (prototype && typeof prototype.verify === 'function') {
      const instance = new (input as new () => TenantVerifierObject)();
      return (request) => instance.verify(request);
    }
    // A lazy import factory takes no arguments — but so may a verifier. Call it once and tell the
    // two apart by what comes back: a module has `default`/`verify`/`tenantVerifier`, a verifier
    // answers with a verified tenant or null.
    if (input.length === 0) {
      const produced = await (input as () => Promise<unknown>)();
      if (
        produced !== null &&
        typeof produced === 'object' &&
        ('default' in produced || 'verify' in produced || 'tenantVerifier' in produced)
      ) {
        return fromModule(produced as TenantVerifierModule);
      }
      return (request) => (input as TenantVerifier)(request);
    }
    return (request) => (input as TenantVerifier)(request);
  }
  if (input && typeof input === 'object' && typeof input.verify === 'function') {
    const instance = input;
    return (request) => instance.verify(request);
  }
  throw new Error(
    '@adonis-agora/config: `verifyTenant` must be a function, a class instance, or `() => import(...)`',
  );
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
    const app = request.app;
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

export const verifiers = {
  /** One secret per app (`x-config-app` names it). */
  sharedSecret: sharedSecretVerifier,
};

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
