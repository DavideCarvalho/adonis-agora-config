/**
 * Token sources for a tenant. The implementation lives in `@adonis-agora/config-client` (remote-safe,
 * usable by scripts and Sail); this module keeps the Adonis-facing names stable.
 *
 * With authkit, prefer `authkitTenantToken()` from `@adonis-agora/authkit-client` — `tokens.authkit`
 * calls it when present and falls back to the same client-credentials flow through discovery, so it
 * works before that helper ships.
 */
export {
  type AuthkitTokenOptions,
  authkitToken,
  authkitTokenSource,
  type ClientCredentialsOptions,
  clientCredentials,
  resolveTokenSource,
  type TenantToken,
  type TenantTokenSource,
  tokens,
} from '@adonis-agora/config-client';

/** The scopes the config server knows. */
export const TENANT_SCOPES = {
  read: 'config:read',
  secretsRead: 'config:secrets:read',
} as const;
