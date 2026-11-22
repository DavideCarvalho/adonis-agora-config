import { type ConfigEntryView, type ConfigValue, isHiddenEntry } from '@adonis-agora/config-core';
import type { ConfigChangeSet } from './topology/tenant_client.js';

/** The default transmit channel for browser config changes. */
export const DEFAULT_BROWSER_CHANNEL = 'config/browser';

/** `browser` in `config/config.ts`: the keys a tenant may send to the browser. */
export interface BrowserConfig {
  /**
   * The keys the browser may read, exact (`site.banner`) or by prefix (`site.*`). Everything else
   * stays on the server. A secret, a vault reference or a sealed entry never reaches the browser,
   * even when a pattern matches it.
   */
  keys: string[];
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
 * The values the browser may read: the listed keys, as the app uses them (boot or live value,
 * local env overrides included), without any secret, vault or sealed entry.
 */
export function browserValues(
  source: BrowserSource,
  patterns: readonly string[],
): Record<string, ConfigValue> {
  if (patterns.length === 0) return {};
  const entries = source.entries();
  const out: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(source.values())) {
    if (!isBrowserKey(patterns, key)) continue;
    const entry = entries[key];
    if (entry && (entry.masked || isHiddenEntry(entry))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Whether a change moved a value the browser reads. Only keys applied now count: a key that
 * needs a restart keeps its old value in this process, so the browser would see nothing new.
 */
export function changesBrowser(change: ConfigChangeSet, patterns: readonly string[]): boolean {
  return change.reloadable.some((key) => isBrowserKey(patterns, key));
}

/** The channel `browser.realtime` broadcasts on, or undefined when realtime is off. */
export function browserChannel(config: BrowserConfig | undefined): string | undefined {
  const realtime = config?.realtime;
  if (!realtime) return undefined;
  return (typeof realtime === 'object' && realtime.channel) || DEFAULT_BROWSER_CHANNEL;
}

/** Refuses a `browser` block that cannot work. */
export function assertBrowserConfig(config: BrowserConfig): void {
  if (!Array.isArray(config.keys) || config.keys.some((key) => typeof key !== 'string' || !key)) {
    throw new Error(
      'config: browser.keys must be a list of keys (`site.banner`) or prefixes (`site.*`)',
    );
  }
  if (config.keys.includes('*')) {
    throw new Error(
      'config: browser.keys cannot be `*`: list the keys the browser may read, so a new key stays on the server until someone adds it',
    );
  }
  if (config.route !== undefined && !config.route.startsWith('/')) {
    throw new Error('config: browser.route must be a path starting with `/`');
  }
}
