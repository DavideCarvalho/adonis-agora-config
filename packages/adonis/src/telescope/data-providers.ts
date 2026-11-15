import { knownTenants } from '../http/control_plane.js';
import type { DataProvider, ExtensionContext, TelescopeEntryLike } from './telescope-sdk.js';

/**
 * The config dashboard's data providers. Two sources:
 *  - ENTRY-backed: the `agora:config:*` milestones the generic telescope diagnostics watcher
 *    recorded (`type: 'diagnostic'`, `tag: 'lib:config'`), so they are the rolling history.
 *  - LIVE: the running `agora.config` runtime (entry/secret counts, crypto status) and the
 *    control plane's known tenants (this process).
 *
 * No config-specific watcher is needed and no entry type is contributed: entries stay `diagnostic`.
 */

const CAP = 5_000;

/** The Telescope diagnostic entry content for a config event. */
interface ConfigEntryContent {
  event?: string;
  payload?: Record<string, unknown>;
}

interface ConfigRuntimeLike {
  topology: string;
  app: string;
  store?: {
    listScopes(): Promise<Array<{ app: string; environment: string; label: string }>>;
    read(scope: {
      app: string;
      environment: string;
      label: string;
    }): Promise<{ entries: Record<string, ConfigEntryLike> } | null>;
    cryptoStatus?(): Promise<{
      active: number;
      retired: number;
      legacy: number;
      unreadable: number;
    }>;
  };
}

interface ConfigEntryLike {
  secret?: boolean;
  reloadable?: boolean;
  sealedTo?: { app: string; kid: string };
}

const contentOf = (entry: TelescopeEntryLike): ConfigEntryContent =>
  (entry.content ?? {}) as ConfigEntryContent;

const payloadOf = (entry: TelescopeEntryLike): Record<string, unknown> =>
  contentOf(entry).payload ?? {};

const eventOf = (entry: TelescopeEntryLike): string => contentOf(entry).event ?? '';

async function fetchEntries(ctx: ExtensionContext, limit = CAP): Promise<TelescopeEntryLike[]> {
  return ctx.store.list({ type: 'diagnostic', tag: 'lib:config', limit });
}

const timeOf = (entry: TelescopeEntryLike): number =>
  entry.createdAt ? +new Date(entry.createdAt) : 0;

/** `2026-11-15 13:42:18` in the server's local time, the format the other dashboards use. */
function at(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** `entry.set` → `set`, `entry.reveal` → `reveal`; anything else stays as it is. */
function actionOf(event: string): string {
  if (event.startsWith('entry.')) return event.slice('entry.'.length);
  return event;
}

/** The changes (writes and unsets) plus rollbacks; reveals and crypto events are not "changes". */
const CHANGE_EVENTS = new Set(['entry.set', 'entry.unset', 'rollback']);

function matches(entry: TelescopeEntryLike, query: Record<string, unknown> | undefined): boolean {
  const payload = payloadOf(entry);
  const event = eventOf(entry);
  const app = query?.app === undefined ? undefined : String(query.app);
  const key = query?.key === undefined ? undefined : String(query.key);
  const actor = query?.actor === undefined ? undefined : String(query.actor);
  const action = query?.action === undefined ? undefined : String(query.action);
  const windowMs = query?.windowMs === undefined ? undefined : Number(query.windowMs);
  if (app !== undefined && payload.app !== app) return false;
  if (key !== undefined && payload.key !== key) return false;
  if (actor !== undefined && payload.actor !== actor) return false;
  if (action !== undefined && actionOf(event) !== action && event !== action) return false;
  if (windowMs !== undefined && windowMs > 0 && timeOf(entry) < Date.now() - windowMs) return false;
  return true;
}

function paging(query: Record<string, unknown> | undefined, fallbackSize = 25) {
  const page = Math.max(1, Math.trunc(Number(query?.page ?? 1)) || 1);
  const size = Math.min(
    200,
    Math.max(1, Math.trunc(Number(query?.size ?? fallbackSize)) || fallbackSize),
  );
  return { page, size };
}

/** Recent writes/unsets/rollbacks, newest first. Paged table (`{ rows, total, page, size }`). */
export function configChangesProvider(): DataProvider {
  return {
    name: 'config.changes',
    async resolve(query, ctx) {
      const entries = (await fetchEntries(ctx))
        .filter((entry) => CHANGE_EVENTS.has(eventOf(entry)) && matches(entry, query))
        .sort((a, b) => timeOf(b) - timeOf(a));
      const { page, size } = paging(query);
      const start = (page - 1) * size;
      const rows = entries.slice(start, start + size).map((entry) => {
        const payload = payloadOf(entry);
        const event = eventOf(entry);
        return {
          at: at(timeOf(entry)),
          app: String(payload.app ?? ''),
          environment: String(payload.environment ?? ''),
          label: String(payload.label ?? ''),
          action: actionOf(event),
          key: String(payload.key ?? (event === 'rollback' ? '' : '')),
          actor: String(payload.actor ?? ''),
          version: Number(payload.version ?? 0),
          flags: [
            payload.secret === true ? 'secret' : '',
            payload.sealedTo ? `sealed:${(payload.sealedTo as { app?: string }).app ?? ''}` : '',
            payload.reloadable === true ? 'reloadable' : '',
          ]
            .filter(Boolean)
            .join(' '),
          message: String(payload.message ?? ''),
        };
      });
      return { rows, total: entries.length, page, size };
    },
  };
}

/** Secret reads, newest first (a reveal is audited and shown here too). */
export function configRevealsProvider(): DataProvider {
  return {
    name: 'config.reveals',
    async resolve(query, ctx) {
      const entries = (await fetchEntries(ctx))
        .filter((entry) => eventOf(entry) === 'entry.reveal' && matches(entry, query))
        .sort((a, b) => timeOf(b) - timeOf(a));
      const { page, size } = paging(query);
      const start = (page - 1) * size;
      const rows = entries.slice(start, start + size).map((entry) => {
        const payload = payloadOf(entry);
        return {
          at: at(timeOf(entry)),
          app: String(payload.app ?? ''),
          environment: String(payload.environment ?? ''),
          label: String(payload.label ?? ''),
          key: String(payload.key ?? ''),
          actor: String(payload.actor ?? ''),
          version: Number(payload.version ?? 0),
        };
      });
      return { rows, total: entries.length, page, size };
    },
  };
}

/** Changes over the recorded window, bucketed by time and split by action (`rows`). */
export function configChangesOverTimeProvider(): DataProvider {
  return {
    name: 'config.changesOverTime',
    async resolve(query, ctx) {
      const entries = (await fetchEntries(ctx))
        .filter((entry) => CHANGE_EVENTS.has(eventOf(entry)) && matches(entry, query))
        .sort((a, b) => timeOf(a) - timeOf(b));
      const n = Math.min(72, Math.max(6, Math.trunc(Number(query?.buckets ?? 24)) || 24));
      const now = Date.now();
      const first = entries.length > 0 ? timeOf(entries[0]!) : now;
      const span = Math.max(now - first, 1);
      const bucketSize = span / n;
      const rows = Array.from({ length: n }, (_, index) => ({
        label: new Date(first + index * bucketSize).toISOString().slice(11, 16),
        set: 0,
        unset: 0,
        rollback: 0,
        reveal: 0,
      }));
      for (const entry of entries) {
        const row = rows[Math.min(n - 1, Math.floor((timeOf(entry) - first) / bucketSize))];
        if (!row) continue;
        const action = actionOf(eventOf(entry)) as 'set' | 'unset' | 'rollback' | 'reveal';
        if (action in row) row[action] += 1;
      }
      return { rows };
    },
  };
}

const ACTION_COLORS: Record<string, string> = {
  set: '#38bdf8',
  unset: '#f87171',
  rollback: '#fbbf24',
  reveal: '#a78bfa',
};

/** Donut segments: how many writes, unsets, rollbacks and reveals. */
export function configActionsProvider(): DataProvider {
  return {
    name: 'config.actions',
    async resolve(query, ctx) {
      const counts = new Map<string, number>();
      for (const entry of await fetchEntries(ctx)) {
        if (!matches(entry, query)) continue;
        const event = eventOf(entry);
        if (!CHANGE_EVENTS.has(event) && event !== 'entry.reveal') continue;
        const action = actionOf(event);
        counts.set(action, (counts.get(action) ?? 0) + 1);
      }
      const segments = ['set', 'unset', 'rollback', 'reveal'].map((label) => ({
        label,
        value: counts.get(label) ?? 0,
        color: ACTION_COLORS[label],
      }));
      return { segments };
    },
  };
}

/** Tenants that reached this control plane since boot (in-process, newest last). */
export function configTenantsProvider(): DataProvider {
  return {
    name: 'config.tenants',
    async resolve(query) {
      const app = query?.app === undefined ? undefined : String(query.app);
      const rows = knownTenants()
        .filter((tenant) => app === undefined || tenant.partition === app)
        .map((tenant) => ({
          app: tenant.partition,
          environment: tenant.environment,
          label: tenant.label,
          capabilities: tenant.capabilities.join(' '),
          lastSeenAt: tenant.lastSeenAt,
          version: tenant.lastVersion ?? 0,
        }));
      return { rows };
    },
  };
}

/** Resolve the live config runtime from the host container (absent on a bare process). */
async function runtimeOf(ctx: ExtensionContext): Promise<ConfigRuntimeLike | undefined> {
  try {
    return await ctx.container.make<ConfigRuntimeLike>('agora.config');
  } catch {
    return undefined;
  }
}

/**
 * One number, selected by `query.metric`:
 * `entries` | `secrets` | `sealed` | `apps` | `scopes` | `tenants` | `unreadable` | `retired` |
 * `changes` | `reveals`. The live counts come from the running store; `changes`/`reveals` come from
 * the recorded diagnostics in `query.windowMs` (default 24h).
 */
export function configStatsProvider(): DataProvider {
  return {
    name: 'config.stats',
    async resolve(query, ctx) {
      const metric = String(query?.metric ?? 'entries');
      if (metric === 'changes' || metric === 'reveals') {
        const windowMs = Number(query?.windowMs ?? 24 * 60 * 60 * 1000);
        const event = metric === 'changes' ? CHANGE_EVENTS : new Set(['entry.reveal']);
        const count = (await fetchEntries(ctx)).filter(
          (entry) =>
            event.has(eventOf(entry)) && (windowMs <= 0 || timeOf(entry) >= Date.now() - windowMs),
        ).length;
        return { value: count };
      }
      if (metric === 'tenants') return { value: knownTenants().length };

      const runtime = await runtimeOf(ctx);
      const store = runtime?.store;
      if (!store) return { value: 0 };
      if (metric === 'unreadable' || metric === 'retired' || metric === 'active') {
        if (!store.cryptoStatus) return { value: 0 };
        const status = await store.cryptoStatus();
        return { value: status[metric] };
      }
      const scopes = await store.listScopes();
      if (metric === 'scopes') return { value: scopes.length };
      if (metric === 'apps') return { value: new Set(scopes.map((scope) => scope.app)).size };

      let entries = 0;
      let secrets = 0;
      let sealed = 0;
      for (const scope of scopes.slice(0, 200)) {
        const document = await store.read(scope);
        for (const entry of Object.values(document?.entries ?? {})) {
          entries += 1;
          if (entry.secret) secrets += 1;
          if (entry.sealedTo !== undefined) sealed += 1;
        }
      }
      if (metric === 'secrets') return { value: secrets };
      if (metric === 'sealed') return { value: sealed };
      return { value: entries };
    },
  };
}
