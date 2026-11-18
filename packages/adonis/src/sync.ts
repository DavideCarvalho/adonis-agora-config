import {
  type ConfigScope,
  type ConfigValue,
  envNameOf,
  envValueOf,
} from '@adonis-agora/config-core';
import type { ConfigAdmin } from './admin.js';

/**
 * Pushing an app's configuration to where its processes read their environment (a PaaS's
 * variables, a Kubernetes Secret, a `.env` on a host): the control plane stays the source of truth
 * and the console, while the app keeps reading plain env variables. The External Secrets pattern:
 * when the control plane is down, the app still boots on the last values the platform holds.
 *
 * A {@link ConfigSyncTarget} knows the platform; this module knows when and what to push.
 */

/** One variable to write. */
export interface SyncedVariable {
  value: string;
  /** Written as a secret (masked by the platform, never listed back). */
  secret: boolean;
}

/** What changed for one app: the variables to write and the names to delete. */
export interface ConfigSyncChange {
  app: string;
  environment: string;
  label: string;
  /** The config version this change brings the platform to. */
  version: number;
  /** Env variable name (`RESEND_API_KEY`) → value. */
  set: Record<string, SyncedVariable>;
  /** Env variable names the config no longer has. */
  remove: string[];
  /** `full`: every variable of the version (`config:sync`); `delta`: what changed since the last one. */
  mode: 'full' | 'delta';
}

/** Where an app's variables go. */
export interface ConfigSyncTarget {
  /** For logs and the command's output (`upuai:entre-textos`). */
  readonly name: string;
  apply(change: ConfigSyncChange): Promise<void>;
}

/** Which app (and environment, label) goes to which target. */
export interface ConfigSyncRule {
  app: string;
  /** Default: the control plane's environment. */
  environment?: string;
  /** Default `main`. */
  label?: string;
  target: ConfigSyncTarget;
  /**
   * Env variable names never pushed nor deleted, whatever the config holds: what the app needs to
   * reach the control plane (its service client, `CONFIG_URL`) and anything the platform owns.
   */
  keep?: readonly string[];
}

export interface ConfigSyncOptions {
  rules: readonly ConfigSyncRule[];
  /** The control plane's environment, the default of a rule. */
  environment: string;
  /** Writes in this window are pushed as one change. Default 2000 ms. */
  debounceMs?: number;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface ConfigSyncResult {
  rule: ConfigSyncRule;
  change: ConfigSyncChange | null;
  error?: string;
}

const scopeKey = (scope: ConfigScope) =>
  `${scope.app}\u0000${scope.environment}\u0000${scope.label}`;

/** The sync of a control plane: debounced pushes on every new version, and full pushes on demand. */
export class ConfigSync {
  readonly #admin: ConfigAdmin;
  readonly #options: ConfigSyncOptions;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The last version pushed per scope, so a burst of writes becomes one delta. */
  readonly #pushed = new Map<string, number>();
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(admin: ConfigAdmin, options: ConfigSyncOptions) {
    this.#admin = admin;
    this.#options = options;
  }

  #scopeOf(rule: ConfigSyncRule): ConfigScope {
    return {
      app: rule.app,
      environment: rule.environment ?? this.#options.environment,
      label: rule.label ?? 'main',
    };
  }

  /** The rules a scope is pushed by. */
  rulesFor(scope: ConfigScope): ConfigSyncRule[] {
    return this.#options.rules.filter((rule) => scopeKey(this.#scopeOf(rule)) === scopeKey(scope));
  }

  /** A new version was written: push what changed, once the burst settles. Never throws. */
  notify(scope: ConfigScope, version: number): void {
    if (this.rulesFor(scope).length === 0) return;
    const key = scopeKey(scope);
    const pending = this.#timers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#serial(key, () => this.#push(scope, version, 'delta'));
    }, this.#options.debounceMs ?? 2000);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  /** Every variable of the current version to every matching target (`config:sync`). */
  async syncAll(filter: { app?: string } = {}): Promise<ConfigSyncResult[]> {
    const results: ConfigSyncResult[] = [];
    for (const rule of this.#options.rules) {
      if (filter.app !== undefined && rule.app !== filter.app) continue;
      const scope = this.#scopeOf(rule);
      try {
        const change = await this.#serial(scopeKey(scope), () =>
          this.#pushRule(rule, scope, null, 'full'),
        );
        results.push({ rule, change });
      } catch (error) {
        results.push({ rule, change: null, error: messageOf(error) });
      }
    }
    return results;
  }

  /** Waits for the pushes in flight (tests, shutdown). */
  async flush(): Promise<void> {
    for (const [key, timer] of this.#timers) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
    await Promise.allSettled([...this.#running.values()]);
  }

  async #serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#running.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#running.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#running.get(key) === next) this.#running.delete(key);
    }
  }

  async #push(scope: ConfigScope, version: number, mode: 'delta'): Promise<void> {
    const since = this.#pushed.get(scopeKey(scope)) ?? version - 1;
    for (const rule of this.rulesFor(scope)) {
      try {
        await this.#pushRule(rule, scope, since, mode);
      } catch (error) {
        this.#options.logger?.warn(
          `[@adonis-agora/config] sync to ${rule.target.name} failed: ${messageOf(error)}`,
        );
      }
    }
  }

  /**
   * Builds and applies the change for one rule: the current values (secrets revealed, audited as
   * `config:sync`), minus `keep`; removed names from the version `since` (none for a full push).
   */
  async #pushRule(
    rule: ConfigSyncRule,
    scope: ConfigScope,
    since: number | null,
    mode: 'full' | 'delta',
  ): Promise<ConfigSyncChange | null> {
    const document = await this.#admin.store.read(scope);
    if (!document) return null;
    const keep = new Set(rule.keep ?? []);
    const values = await this.#admin.values(scope, true, {
      reveal: { actor: `config:sync:${rule.target.name}` },
    });
    const set: Record<string, SyncedVariable> = {};
    for (const [key, value] of Object.entries(values)) {
      const name = envNameOf(key);
      if (keep.has(name)) continue;
      set[name] = {
        value: envValueOf(value as ConfigValue),
        secret:
          document.entries[key]?.secret === true || document.entries[key]?.vault !== undefined,
      };
    }
    const remove: string[] = [];
    if (since !== null && since > 0 && since < document.version) {
      const previous = await this.#admin.store.readVersion(scope, since);
      for (const key of Object.keys(previous?.entries ?? {})) {
        const name = envNameOf(key);
        if (!(name in set) && !keep.has(name) && !(key in document.entries)) remove.push(name);
      }
    }
    const change: ConfigSyncChange = {
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
      version: document.version,
      set,
      remove: remove.sort(),
      mode,
    };
    await rule.target.apply(change);
    this.#pushed.set(scopeKey(scope), document.version);
    this.#options.logger?.info(
      `[@adonis-agora/config] synced ${scope.app} v${document.version} to ${rule.target.name}: ${Object.keys(set).length} set, ${remove.length} removed`,
    );
    return change;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
