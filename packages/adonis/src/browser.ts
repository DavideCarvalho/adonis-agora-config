import { type ConfigEntryView, type ConfigValue, isHiddenEntry } from '@adonis-agora/config-core';
import type { ConfigChangeSet } from './topology/tenant_client.js';

/** The default transmit channel for browser config changes. */
export const DEFAULT_BROWSER_CHANNEL = 'config/browser';

/** `browser` in `config/config.ts`: the keys a tenant may send to the browser. */
export interface BrowserConfig {
  /**
   * Keys the browser may read in addition to the entries marked `browser` on the control plane,
   * exact (`site.banner`) or by prefix (`site.*`). Everything else stays on the server. A secret, a
   * vault reference or a sealed entry never reaches the browser, even when a pattern matches it.
   */
  keys?: string[];
  /**
   * Live updates over `@adonisjs/transmit`: when a listed key changes and the change applies
   * without a restart, broadcasts `{ version }` on the channel (default `config/browser`). The
   * message carries no values: the page reloads them.
   */
  realtime?: boolean | { channel?: string };
  /**
   * A GET route answering `{ version, values }` with the browser keys, for pages that do not get
   * them as Inertia props (`route: '/_config/browser'`). Off when omitted.
   */
  route?: string;
  /**
   * The direct mode: pages read the values from the control plane itself, with a short-lived token
   * this app mints at `tokenRoute` (default `/_config/browser-token`). The control plane needs
   * `browser` in its own config/config.ts. `publicUrl` is the control plane's address as browsers
   * reach it, when it differs from `tenant.url`.
   */
  direct?: boolean | BrowserDirectConfig;
}

/** {@link BrowserConfig.direct}. */
export interface BrowserDirectConfig {
  /** Default `/_config/browser-token`. */
  tokenRoute?: string;
  /** Token lifetime. Default 600 seconds. */
  ttlSeconds?: number;
  /** The control plane as browsers reach it (`https://hub.example.com/_config`). Default `tenant.url`. */
  publicUrl?: string;
}

/** `browser` on a control plane: serve browsers of every tenant directly. */
export interface ControlPlaneBrowserConfig {
  /** Origins of the tenants' pages (`https://app.example.com`). */
  corsOrigins: string[];
  /** Signs the per-app token keys. Default: the app key (APP_KEY). */
  secret?: string;
}

/** What {@link browserValues} reads from a tenant client. */
export interface BrowserSource {
  values(): Record<string, ConfigValue>;
  entries(): Record<string, ConfigEntryView>;
}

function matches(pattern: string, key: string): boolean {
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
}

/** Whether a key is listed in `browser.keys`. */
export function isBrowserKey(patterns: readonly string[], key: string): boolean {
  return patterns.some((pattern) => matches(pattern, key));
}

/**
 * The values the browser may read: entries marked `browser` in the console (or with
 * `--browser`), plus the keys `browser.keys` lists, as the app uses them (boot or live value,
 * local env overrides included). Never a secret, vault or sealed entry.
 */
export function browserValues(
  source: BrowserSource,
  patterns: readonly string[],
): Record<string, ConfigValue> {
  const entries = source.entries();
  const out: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(source.values())) {
    const entry = entries[key];
    if (entry?.browser !== true && !isBrowserKey(patterns, key)) continue;
    if (entry && (entry.masked || isHiddenEntry(entry))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Whether a change moved what the browser reads: a listed key, or an entry marked `browser`
 * before or after the change. Only keys applied now count: a key that needs a restart keeps its
 * old value (and mark) in this process, so the browser would see nothing new.
 */
export function changesBrowser(
  change: ConfigChangeSet,
  patterns: readonly string[],
  wasBrowser: (key: string) => boolean = () => false,
): boolean {
  return change.reloadable.some((key) => isBrowserKey(patterns, key) || wasBrowser(key));
}

/** The channel `browser.realtime` broadcasts on, or undefined when realtime is off. */
export function browserChannel(config: BrowserConfig | undefined): string | undefined {
  const realtime = config?.realtime;
  if (!realtime) return undefined;
  return (typeof realtime === 'object' && realtime.channel) || DEFAULT_BROWSER_CHANNEL;
}

/** Refuses a `browser` block that cannot work. */
export function assertBrowserConfig(config: BrowserConfig): void {
  if (
    config.keys !== undefined &&
    (!Array.isArray(config.keys) || config.keys.some((key) => typeof key !== 'string' || !key))
  ) {
    throw new Error(
      'config: browser.keys must be a list of keys (`site.banner`) or prefixes (`site.*`)',
    );
  }
  if (config.keys?.includes('*')) {
    throw new Error(
      'config: browser.keys cannot be `*`: list the keys the browser may read, so a new key stays on the server until someone adds it',
    );
  }
  if (config.route !== undefined && !config.route.startsWith('/')) {
    throw new Error('config: browser.route must be a path starting with `/`');
  }
  const direct = typeof config.direct === 'object' ? config.direct : undefined;
  if (direct?.tokenRoute !== undefined && !direct.tokenRoute.startsWith('/')) {
    throw new Error('config: browser.direct.tokenRoute must be a path starting with `/`');
  }
  if (direct?.publicUrl !== undefined && !/^https?:\/\//.test(direct.publicUrl)) {
    throw new Error('config: browser.direct.publicUrl must be an absolute http(s) URL');
  }
}
