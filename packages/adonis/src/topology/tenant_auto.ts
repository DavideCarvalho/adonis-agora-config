import { CONFIG_RESOURCE } from '@adonis-agora/config-core';
import type { TenantSettings, TenantTopologyConfig } from '../define_config.js';
import type { TenantUrlSource } from './tenant_url.js';
import type { TenantTokenSource } from './token.js';

/**
 * What `tenantOf(resource)` on `@adonis-agora/authkit-client`'s `'authkit.client'` binding returns,
 * read structurally: this package never imports authkit-client.
 */
export interface AuthkitTenantLike {
  /** The control-plane URL discovered from the issuer, with `refresh()`. */
  url: (() => Promise<string>) & { refresh?(): Promise<string> };
  /** A service token for the resource (cached), with `reset()` to drop it after a 401. */
  token: (() => Promise<string>) & { reset?(): void };
  /** This app's partition (`service.partition`, else `service.name`). */
  partition: string;
}

/** The three fields a tenant needs, as `config/config.ts` gives them (each may be left out). */
export interface TenantConnectionFields {
  url?: TenantUrlSource | undefined;
  token?: TenantTokenSource | undefined;
  partition?: string | undefined;
  /**
   * Take the fields left out from `@adonis-agora/authkit-client` (its `service`), when it is booted
   * in this app. Default `true`; `false` turns the lookup off and every field must be given.
   */
  auto?: boolean | undefined;
}

/** Where one tenant field came from. */
export type TenantFieldSource = 'explicit' | 'authkit-client (auto)' | 'missing';

export const TENANT_FIELDS = ['url', 'token', 'partition'] as const;
export type TenantField = (typeof TENANT_FIELDS)[number];

/** The tenant fields after the merge (`{ ...auto, ...explicit }`), with each one's origin. */
export interface ResolvedTenantFields {
  url?: TenantUrlSource;
  token?: TenantTokenSource;
  partition?: string;
  sources: Record<TenantField, TenantFieldSource>;
  /** The fields neither the config nor authkit-client supplied. */
  missing: TenantField[];
  /** Why authkit-client could not supply them (its `tenantOf` threw: no `service`). */
  authkitError?: string;
}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/**
 * The `'authkit.client'` binding's `tenantOf`, when authkit-client is booted in this app and new
 * enough to have it; otherwise `undefined` (an older authkit-client counts as absent).
 */
export async function authkitTenantSourceOf(
  container: unknown,
): Promise<((resource: string) => AuthkitTenantLike) | undefined> {
  const c = container as ContainerLike | undefined;
  if (typeof c?.hasBinding !== 'function' || typeof c.make !== 'function') return undefined;
  if (!c.hasBinding('authkit.client')) return undefined;
  let client: unknown;
  try {
    client = await c.make('authkit.client');
  } catch {
    return undefined;
  }
  const tenantOf = (client as { tenantOf?: unknown } | null | undefined)?.tenantOf;
  if (typeof tenantOf !== 'function') return undefined;
  return (resource) => tenantOf.call(client, resource) as AuthkitTenantLike;
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Merges the tenant fields `config/config.ts` gives with the ones authkit-client discovers, field by
 * field (anything explicit wins). `tenantOf` is only called when a field is missing, so an app
 * with authkit-client for login only (no `service`) and an explicit tenant is unaffected.
 */
export async function resolveTenantFields(
  container: unknown,
  tenant: TenantConnectionFields | undefined,
  resource: string = CONFIG_RESOURCE,
): Promise<ResolvedTenantFields> {
  const explicit = tenant ?? {};
  const resolved: ResolvedTenantFields = {
    sources: { url: 'missing', token: 'missing', partition: 'missing' },
    missing: [],
  };
  const needsAuto = TENANT_FIELDS.some((field) => !given(explicit[field]));
  let auto: AuthkitTenantLike | undefined;
  if (needsAuto && explicit.auto !== false) {
    const tenantOf = await authkitTenantSourceOf(container);
    if (tenantOf) {
      try {
        auto = tenantOf(resource);
      } catch (error) {
        // `TenantOfConfigError` (no `service`): authkit-client counts as absent, and the boot
        // error carries its message.
        resolved.authkitError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  for (const field of TENANT_FIELDS) {
    const mine = explicit[field];
    if (given(mine)) {
      (resolved as unknown as Record<string, unknown>)[field] = mine;
      resolved.sources[field] = 'explicit';
    } else if (auto && given(auto[field])) {
      (resolved as unknown as Record<string, unknown>)[field] = auto[field];
      resolved.sources[field] = 'authkit-client (auto)';
    } else {
      resolved.missing.push(field);
    }
  }
  return resolved;
}

/** The boot error for a tenant whose url/token/partition nobody supplied. */
export class TenantFieldsError extends Error {
  readonly code = 'E_CONFIG_TENANT_FIELDS';
  constructor(
    readonly missing: TenantField[],
    authkitError?: string,
    /** Where each field came from (`missing` for the ones nothing supplied). */
    readonly sources: Record<TenantField, TenantFieldSource> = {
      url: missing.includes('url') ? 'missing' : 'explicit',
      token: missing.includes('token') ? 'missing' : 'explicit',
      partition: missing.includes('partition') ? 'missing' : 'explicit',
    },
  ) {
    const fields = missing.map((field) => `tenant.${field}`).join(', ');
    const cause = authkitError ? ` (authkit-client: ${authkitError})` : '';
    super(
      `[@adonis-agora/config] topology 'tenant' needs ${fields}${cause}. Configure @adonis-agora/authkit-client's \`service\` (config/authkit.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/config.ts.`,
    );
    this.name = 'TenantFieldsError';
  }
}

/** {@link TenantFieldsError} for what {@link resolveTenantFields} could not fill. */
export function tenantFieldsError(
  resolved: Pick<ResolvedTenantFields, 'missing' | 'authkitError' | 'sources'>,
): TenantFieldsError {
  return new TenantFieldsError(resolved.missing, resolved.authkitError, resolved.sources);
}

/** The doctor line: `tenant url: authkit-client (auto), token: explicit, partition: explicit`. */
export function describeTenantSources(sources: Record<TenantField, TenantFieldSource>): string {
  return `tenant url: ${sources.url}, token: ${sources.token}, partition: ${sources.partition}`;
}

/** A tenant config whose url/token/partition are all known (explicit or from authkit-client). */
export type ResolvedTenantTopologyConfig = Omit<TenantTopologyConfig, 'tenant'> & {
  tenant: TenantSettings & { url: TenantUrlSource; token: TenantTokenSource; partition: string };
};

/** The tenant config with the merged fields in place; throws the boot error when some are missing. */
export async function resolveTenantConfig(
  container: unknown,
  config: TenantTopologyConfig,
): Promise<{ config: ResolvedTenantTopologyConfig; fields: ResolvedTenantFields }> {
  const fields = await resolveTenantFields(container, config.tenant);
  if (fields.missing.length > 0) throw tenantFieldsError(fields);
  return {
    config: {
      ...config,
      tenant: {
        ...config.tenant,
        url: fields.url as TenantUrlSource,
        token: fields.token as TenantTokenSource,
        partition: fields.partition as string,
      },
    },
    fields,
  };
}
