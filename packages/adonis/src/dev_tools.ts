import { assertConfigKey, DEFAULT_LABEL, toConfigValue } from '@adonis-agora/config-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { ConfigAdmin } from './admin.js';

/*
 * The dev-tools registration contract, version 1, declared STRUCTURALLY: the hub is bound at
 * `'agora.devTools'` by `@adonis-agora/agent/mcp_provider` when the app has it, and this package
 * never imports the agent (it stays an optional, undeclared peer).
 */

export const DEV_TOOLS_BINDING = 'agora.devTools';

export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
}

export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

export type DevToolsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      redirectTo?: string;
      error?: unknown;
    };

export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

export interface DevToolCall {
  ctx: HttpContext;
  caller: { id: string; via: 'token' | 'session' | 'open' };
  limits: { maxRows: number; maxBytes: number };
}

export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

class DevToolError extends Error {}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new DevToolError(`${key} is required`);
  return value;
}

function paging(input: Record<string, unknown>, call: DevToolCall) {
  const rawLimit = input.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.trunc(rawLimit)
      : DEFAULT_LIMIT;
  const cap = Math.min(MAX_LIMIT, call.limits.maxRows > 0 ? call.limits.maxRows : MAX_LIMIT);
  const rawPage = input.page;
  const page = typeof rawPage === 'number' && Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1;
  return { page: Math.max(1, page), size: Math.min(Math.max(limit, 1), cap) };
}

const APP: DevToolInputProperty = {
  type: 'string',
  description: 'Application (partition).',
};
const ENVIRONMENT: DevToolInputProperty = {
  type: 'string',
  description: "Environment, e.g. 'production'. Default: the server's own.",
};
const LABEL: DevToolInputProperty = {
  type: 'string',
  description: "Label/profile. Default 'main'.",
};
const KEY: DevToolInputProperty = { type: 'string', description: 'Entry key (dot path).' };
const PAGE: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  description: 'Page number, 1-based. Pass `next` back here.',
};
const LIMIT: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Rows per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
};
const MESSAGE: DevToolInputProperty = {
  type: 'string',
  description: 'Why: recorded with the change in the audit trail.',
};

/**
 * The config console's developer tools, over the same {@link ConfigAdmin} the console and the
 * commands use. Reads are listed by default; writes only when the app opts into actions on the dev
 * endpoint. A write records the caller as `mcp:<caller id>`.
 */
export function configDevTools(
  admin: ConfigAdmin,
  options: {
    actorFor: (call: DevToolCall) => string;
    /** Whether the caller may see and change `app` (the console's `apps` and the viewer grant). */
    appAllowed?: (ctx: HttpContext, app: string) => boolean | Promise<boolean>;
  },
): DevTool[] {
  const allowed = async (call: DevToolCall, app: string) =>
    options.appAllowed ? await options.appAllowed(call.ctx, app) : true;
  const appOf = async (input: Record<string, unknown>, call: DevToolCall) => {
    const app = required(input, 'app');
    if (!(await allowed(call, app))) {
      throw new DevToolError(`app "${app}" is not granted to this caller`);
    }
    return app;
  };
  const scopeOf = async (input: Record<string, unknown>, call: DevToolCall) => ({
    app: await appOf(input, call),
    environment: str(input, 'environment') ?? 'production',
    label: str(input, 'label') ?? DEFAULT_LABEL,
    canRead: admin.canRevealSecrets,
    call,
  });

  return [
    {
      name: 'config_list_scopes',
      kind: 'read',
      description:
        'Every app, environment and label that holds configuration on this server. Use the values as the app/environment/label arguments of the other tools.',
      input: { type: 'object', properties: {} },
      run: async (_input, call) => {
        const scopes = await admin.scopes();
        const apps: string[] = [];
        for (const app of scopes.apps) if (await allowed(call, app)) apps.push(app);
        return { ...scopes, apps };
      },
    },
    {
      name: 'config_list_entries',
      kind: 'read',
      description:
        'List the configuration entries of one scope: key, value (masked for secrets), whether it is a secret, whether it is reloadable (applies without a restart) and who last wrote it. Filters: `search`, `secret`, `reloadable`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          search: {
            type: 'string',
            description: 'Only keys or descriptions containing this text.',
          },
          secret: { type: 'boolean', description: 'Only secret entries.' },
          reloadable: { type: 'boolean', description: 'Only reloadable entries.' },
          browser: { type: 'boolean', description: "Only entries the app's pages may read." },
          page: PAGE,
          limit: LIMIT,
        },
        required: ['app'],
      },
      run: async (input, call) => {
        const { app, environment, label, canRead } = await scopeOf(input, call);
        const at = paging(input, call);
        const page = await admin.listEntries({ app, environment, label }, canRead, {
          page: at.page,
          size: at.size,
          filters: {
            ...(str(input, 'search') !== undefined ? { search: str(input, 'search')! } : {}),
            ...(typeof input.secret === 'boolean' ? { secret: input.secret } : {}),
            ...(typeof input.reloadable === 'boolean' ? { reloadable: input.reloadable } : {}),
            ...(typeof input.browser === 'boolean' ? { browser: input.browser } : {}),
          },
        });
        return {
          scope: { app, environment, label },
          items: page.data,
          next: at.page * at.size < page.meta.total ? at.page + 1 : null,
          total: page.meta.total,
        };
      },
    },
    {
      name: 'config_get_entry',
      kind: 'read',
      description:
        'One entry, with its value (a secret is masked unless this console may reveal it; a reveal is audited), flags, vault reference and last writer.',
      input: {
        type: 'object',
        properties: { app: APP, environment: ENVIRONMENT, label: LABEL, key: KEY },
        required: ['app', 'key'],
      },
      run: async (input, call) => {
        const { app, environment, label, canRead } = await scopeOf(input, call);
        const key = required(input, 'key');
        assertConfigKey(key);
        const entry = await admin.getEntry({ app, environment, label }, key, {
          canReadSecrets: canRead,
          ...(canRead ? { reveal: { actor: options.actorFor(call) } } : {}),
        });
        if (!entry) throw new DevToolError(`no entry "${key}" in ${app}/${environment}/${label}`);
        return entry;
      },
    },
    {
      name: 'config_list_versions',
      kind: 'read',
      description:
        'The immutable versions of a scope, newest first: who wrote each, when, how many entries and secrets, its fingerprint and the message. Returns { items, next }.',
      input: {
        type: 'object',
        properties: { app: APP, environment: ENVIRONMENT, label: LABEL, page: PAGE, limit: LIMIT },
        required: ['app'],
      },
      run: async (input, call) => {
        const { app, environment, label } = await scopeOf(input, call);
        const at = paging(input, call);
        const page = await admin.listVersions(
          { app, environment, label },
          { page: at.page, size: at.size },
        );
        return {
          scope: { app, environment, label },
          items: page.data,
          next: at.page * at.size < page.meta.total ? at.page + 1 : null,
          total: page.meta.total,
        };
      },
    },
    {
      name: 'config_get_version',
      kind: 'read',
      description: 'One version exactly as it was: its metadata and every entry (secrets masked).',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          version: { type: 'integer', minimum: 1, description: 'Version number.' },
        },
        required: ['app', 'version'],
      },
      run: async (input, call) => {
        const { app, environment, label, canRead } = await scopeOf(input, call);
        const version = Number(input.version);
        if (!Number.isInteger(version) || version < 1) throw new DevToolError('invalid version');
        const found = await admin.version({ app, environment, label }, version, canRead);
        if (!found) throw new DevToolError(`no version ${version}`);
        return found;
      },
    },
    {
      name: 'config_diff_versions',
      kind: 'read',
      description:
        'The added, removed and changed keys between two versions, with before/after values (secret values masked unless this console may reveal them).',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          from: { type: 'integer', minimum: 1 },
          to: { type: 'integer', minimum: 1 },
        },
        required: ['app', 'from', 'to'],
      },
      run: async (input, call) => {
        const { app, environment, label, canRead } = await scopeOf(input, call);
        const from = Number(input.from);
        const to = Number(input.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          throw new DevToolError('from and to must be version numbers');
        }
        return {
          from,
          to,
          rows: await admin.diff({ app, environment, label }, from, to, canRead),
        };
      },
    },
    {
      name: 'config_list_audit',
      kind: 'read',
      description:
        'The audit trail of a scope, newest first: who (actor), what (set/unset/rollback/reveal), which key and version, and why. Filters: `key`, `action`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          key: KEY,
          action: {
            type: 'string',
            enum: ['set', 'unset', 'rollback', 'reveal'],
          },
          page: PAGE,
          limit: LIMIT,
        },
        required: ['app'],
      },
      run: async (input, call) => {
        const { app, environment, label } = await scopeOf(input, call);
        const at = paging(input, call);
        const page = await admin.audit(
          { app, environment, label },
          {
            page: at.page,
            size: at.size,
            ...(str(input, 'key') !== undefined ? { key: str(input, 'key')! } : {}),
            ...(str(input, 'action') !== undefined ? { action: str(input, 'action')! } : {}),
          },
        );
        return {
          scope: { app, environment, label },
          items: page.data,
          next: at.page * at.size < page.meta.total ? at.page + 1 : null,
          total: page.meta.total,
        };
      },
    },

    // ── Actions (only served when the app opts into actions) ────────────────
    {
      name: 'config_set_entry',
      kind: 'action',
      description:
        'Create or update one entry. `value` is a JSON object/array/primitive, or plain text with `string: true`. A `vault` reference replaces the value. `sealed: true` seals the value to the app key (the server cannot read it). Returns { version, changed }. A reloadable key applies on running tenants; the rest need a restart.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          key: KEY,
          value: { type: 'string', description: 'The value, as JSON (or text).' },
          vault: { type: 'string', description: 'A vault:// reference instead of a value.' },
          secret: {
            type: 'boolean',
            description: 'Encrypt at rest; read needs config:secrets:read.',
          },
          sealed: {
            type: 'boolean',
            description:
              "Seal the value to this app's X25519 public key: the server cannot read it, only the app can.",
          },
          reloadable: { type: 'boolean', description: 'Apply on a running tenant.' },
          browser: {
            type: 'boolean',
            description: "Let the app's pages read it (config.browser()). Refused on a secret.",
          },
          description: { type: 'string' },
          string: {
            type: 'boolean',
            description: 'Keep `value` as text, even if it parses as JSON.',
          },
          message: MESSAGE,
        },
        required: ['app', 'key'],
      },
      run: async (input, call) => {
        const scope = {
          app: await appOf(input, call),
          environment: str(input, 'environment') ?? 'production',
          label: str(input, 'label') ?? DEFAULT_LABEL,
        };
        const key = required(input, 'key');
        assertConfigKey(key);
        const text = str(input, 'value');
        const vault = str(input, 'vault');
        if (text === undefined && vault === undefined) {
          throw new DevToolError('pass value or vault');
        }
        let value: unknown = text;
        if (text !== undefined && input.string !== true) {
          try {
            value = JSON.parse(text);
          } catch {
            value = text;
          }
        }
        const result = await admin.setEntry(
          scope,
          key,
          {
            ...(value !== undefined ? { value: toConfigValue(value) } : {}),
            ...(vault !== undefined ? { vault } : {}),
            ...(input.sealed === true ? { sealedTo: true, secret: true } : {}),
            ...(typeof input.secret === 'boolean' ? { secret: input.secret } : {}),
            ...(typeof input.reloadable === 'boolean' ? { reloadable: input.reloadable } : {}),
            ...(typeof input.browser === 'boolean' ? { browser: input.browser } : {}),
            ...(str(input, 'description') !== undefined
              ? { description: str(input, 'description')! }
              : {}),
          },
          {
            actor: options.actorFor(call),
            ...(str(input, 'message') !== undefined ? { message: str(input, 'message')! } : {}),
          },
        );
        return { scope, key, ...result };
      },
    },
    {
      name: 'config_unset_entry',
      kind: 'action',
      destructive: true,
      description: 'Remove one entry, producing a new version. Returns { version, changed }.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          key: KEY,
          message: MESSAGE,
        },
        required: ['app', 'key'],
      },
      run: async (input, call) => {
        const scope = {
          app: await appOf(input, call),
          environment: str(input, 'environment') ?? 'production',
          label: str(input, 'label') ?? DEFAULT_LABEL,
        };
        const key = required(input, 'key');
        assertConfigKey(key);
        return {
          scope,
          key,
          ...(await admin.unsetEntry(scope, key, {
            actor: options.actorFor(call),
            ...(str(input, 'message') !== undefined ? { message: str(input, 'message')! } : {}),
          })),
        };
      },
    },
    {
      name: 'config_rollback',
      kind: 'action',
      destructive: true,
      description:
        'Copy a past version into a new version. History stays append-only. Returns { version, changed }.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          environment: ENVIRONMENT,
          label: LABEL,
          to: { type: 'integer', minimum: 1, description: 'The version to restore.' },
          message: MESSAGE,
        },
        required: ['app', 'to'],
      },
      run: async (input, call) => {
        const scope = {
          app: await appOf(input, call),
          environment: str(input, 'environment') ?? 'production',
          label: str(input, 'label') ?? DEFAULT_LABEL,
        };
        const to = Number(input.to);
        if (!Number.isInteger(to) || to < 1) throw new DevToolError('to must be a version number');
        return {
          scope,
          to,
          ...(await admin.rollback(scope, to, {
            actor: options.actorFor(call),
            ...(str(input, 'message') !== undefined ? { message: str(input, 'message')! } : {}),
          })),
        };
      },
    },
  ];
}

/** Registers the config tools into the app's dev-tools hub, when one is bound. */
export async function registerConfigDevTools(
  container: { hasBinding(binding: string): boolean; make(binding: string): Promise<unknown> },
  options: {
    admin: ConfigAdmin;
    authorize: (ctx: HttpContext) => Promise<DevToolsDecision>;
    actorFor?: (call: DevToolCall) => string;
    appAllowed?: (ctx: HttpContext, app: string) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return false;
  const hub = (await container.make(DEV_TOOLS_BINDING)) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'config',
    title: 'Centralized configuration',
    authorize: options.authorize,
    tools: configDevTools(options.admin, {
      actorFor: options.actorFor ?? ((call) => `mcp:${call.caller.id}`),
      ...(options.appAllowed ? { appAllowed: options.appAllowed } : {}),
    }),
  });
  return true;
}
