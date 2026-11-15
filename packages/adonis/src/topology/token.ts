import { CONFIG_SCOPES } from '@adonis-agora/config-core';

export {
  resolveTenantToken,
  type TenantToken,
  type TenantTokenSource,
} from '@adonis-agora/config-client';

/** The resource (RFC 8707) every config control plane answers for: the `aud` of tenant tokens. */
export { CONFIG_RESOURCE } from '@adonis-agora/config-core';

/** What each control-plane endpoint requires in the token's `capabilities`. */
export const TENANT_SCOPES = {
  read: CONFIG_SCOPES.read,
  secretsRead: CONFIG_SCOPES.secretsRead,
} as const;
