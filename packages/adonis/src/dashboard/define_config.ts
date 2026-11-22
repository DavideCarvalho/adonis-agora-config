import type { HttpContext } from '@adonisjs/core/http';
import type { FederatedConfigAppConfig } from '../federation/console.js';
import type { AccessDeniedOption } from './access_denied_page.js';
import type { ConsoleActor } from './actor.js';
import type { ConsoleAuthorize } from './console_authorize.js';
import type { SignOutOption, ViewerHook } from './console_shell.js';

/** The console's configuration, under `controlPlane.console` (or `console` on a standalone app). */
export interface ConfigConsoleConfig {
  /** Mount the console. Default `true` on a control plane or standalone app. */
  enabled?: boolean;
  /** UI and API mount path. Default `/_config` (the same prefix as the tenant API, which owns /v1). */
  path?: string;
  /**
   * Who may open the console. The same contract as every Agora console: a function, an authorizer
   * class, or a lazy import. Omitted: open outside production, every request denied in production.
   */
  authorize?: ConsoleAuthorize;
  /** Who is signed in, for the sidebar footer. Default: a structural read of `ctx.auth`/`ctx.authkit`. */
  viewer?: ViewerHook;
  /**
   * Who the audit trail records for a change or a reveal made in the console. Default: the authkit
   * identity (`ctx.authkit`), else `ctx.auth.user`, else `console`. Set it when people sign in some
   * other way, such as the authkit console session on a Hub:
   * `actor: (ctx) => ({ id: realAccountId(ctx) })`. An answer without an `id` falls back to the
   * default.
   */
  actor?: ConsoleActorHook;
  /** How the footer signs out (a path, `{ action }`, `{ href }`, or `false`). */
  signOut?: SignOutOption;
  /** The refusal page, when `authorize` says no. */
  accessDenied?: AccessDeniedOption<HttpContext>;
  /** Where the refusal's "Sign in" points. */
  loginHref?: string;
  /**
   * Whether an operator may reveal a secret value (the reveal is audited). Default `true`: the
   * console is already gated. `false` keeps secrets masked even here.
   */
  revealSecrets?: boolean;
  /**
   * Only these apps, when set. The pickers list them and a request for another app is refused.
   * Default: every app the store holds.
   */
  apps?: string[];
  /**
   * Other apps this console shows next to its own scopes (the federated console): apps that run
   * `@adonis-agora/config` standalone, with their own store and keys. The console reads each one's
   * versions and audit straight from its tables (secret values never leave them), and sends writes
   * and reveals to the app itself over Redis; that app sets `consoleCommands` in its
   * config/config.ts. The key is what the App picker selects (`?app=`); `authorize`'s `apps` grant
   * decides who sees which.
   */
  federatedApps?: Record<string, FederatedConfigAppConfig>;
  /** This console's own name in the App picker, and the `via` the other apps log. */
  appLabel?: string;
}

/** The `actor` option: who is acting in this request. */
export type ConsoleActorHook = (
  ctx: HttpContext,
) =>
  | Partial<ConsoleActor>
  | string
  | null
  | undefined
  | Promise<Partial<ConsoleActor> | string | null | undefined>;

export interface ResolvedConsoleConfig {
  enabled: boolean;
  path: string;
  api: string;
  /** Whether an operator may reveal a secret (the reveal is audited). */
  revealSecrets: boolean;
  authorize?: ConsoleAuthorize;
  viewer?: ViewerHook;
  actor?: ConsoleActorHook;
  signOut?: SignOutOption;
  accessDenied?: AccessDeniedOption<HttpContext>;
  loginHref?: string;
  apps?: string[];
  federatedApps?: Record<string, FederatedConfigAppConfig>;
  appLabel?: string;
}

/** Normalizes the mount path: a same-origin absolute path, no trailing slash (root is `''`). */
export function consolePath(path: string | undefined): string {
  const value = (path ?? '/_config').trim();
  if (value === '' || value === '/') return '';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new Error(
      `[@adonis-agora/config] console.path must start with a single "/" (got ${JSON.stringify(path)})`,
    );
  }
  return value.replace(/\/$/, '');
}

/** Fills the defaults. */
export function resolveConsoleConfig(
  config: ConfigConsoleConfig | false | undefined,
  options: { environment: string },
): ResolvedConsoleConfig {
  void options;
  const provided = config === false ? { enabled: false } : (config ?? {});
  const path = consolePath(provided.path);
  return {
    enabled: provided.enabled ?? true,
    path,
    api: `${path}/api`,
    revealSecrets: provided.revealSecrets ?? true,
    ...(provided.authorize ? { authorize: provided.authorize } : {}),
    ...(provided.viewer ? { viewer: provided.viewer } : {}),
    ...(provided.actor ? { actor: provided.actor } : {}),
    ...(provided.signOut !== undefined ? { signOut: provided.signOut } : {}),
    ...(provided.accessDenied ? { accessDenied: provided.accessDenied } : {}),
    ...(provided.loginHref ? { loginHref: provided.loginHref } : {}),
    ...(provided.apps ? { apps: provided.apps } : {}),
    ...(provided.federatedApps && Object.keys(provided.federatedApps).length > 0
      ? { federatedApps: provided.federatedApps }
      : {}),
    ...(provided.appLabel ? { appLabel: provided.appLabel } : {}),
  };
}
