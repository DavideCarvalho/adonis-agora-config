import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  assertConfigKey,
  type ConfigEntryInput,
  type ConfigValue,
  DEFAULT_LABEL,
  toConfigValue,
} from '@adonis-agora/config-core';
import { InvalidColumnFilterError } from '@adonis-agora/filter';
import type { HttpContext } from '@adonisjs/core/http';
import type { ConfigAdmin } from '../admin.js';
import { booleanFilter, parseListQuery } from '../http/list.js';
import { resolveAccessDeniedPage } from './access_denied_page.js';
import { type ConsoleActor, consoleActor } from './actor.js';
import { type ConsoleAuthorizeDecision, resolveConsoleAuthorize } from './console_authorize.js';
import { resolveSignOut, resolveViewer } from './console_shell.js';
import {
  type AgoraConsoleRegistry,
  listVisibleConsoles,
  otherConsoles,
  searchConsoles,
} from './console_switcher.js';
import type { ResolvedConsoleConfig } from './define_config.js';
import { contentTypeFor, renderIndexHtml } from './spa.js';

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  post(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  put(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  delete(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
}

export interface ConfigConsoleOptions {
  admin: ConfigAdmin;
  config: ResolvedConsoleConfig;
  /** The built SPA (`dist/assets/spa`), passed by the provider so this file stays path-free. */
  spaDir: string;
  /** The environment used as the picker's default. */
  environment: string;
  /** The app used as the picker's default (standalone). */
  defaultApp?: string;
  /** `app.inProduction`, for the default gate (open outside production, deny inside). */
  inProduction: boolean;
  /** Whether this control plane has an encryption codec (secrets can be written and revealed). */
  secrets: boolean;
  topology: 'standalone' | 'control-plane';
  registry?: AgoraConsoleRegistry;
  logger: { warn(message: string): void; info?(message: string): void };
}

/** This console's id in the `'agora.consoles'` registry. */
export const CONSOLE_ID = 'config';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bearerOf(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  return header && /^bearer\s+/i.test(header)
    ? header.replace(/^bearer\s+/i, '').trim()
    : undefined;
}

/** A console-local decision from the request's bearer token, body-less API calls only. */
function tokenAuthorize(token: string | undefined) {
  return (ctx: HttpContext): ConsoleAuthorizeDecision => {
    if (token === undefined || token === '')
      return { allowed: false, status: 403, reason: 'forbidden' };
    const presented = bearerOf(ctx);
    return presented === token
      ? { allowed: true }
      : { allowed: false, status: 401, reason: 'unauthenticated' };
  };
}

/**
 * The config console: the SPA plus its JSON API, under `console.path` (default `/_config`).
 *
 * Every read and write goes through {@link ConfigAdmin}, so the console gets the same versioning,
 * masking, reveal audit and actor as the commands and the MCP tools. The gate is the resolved
 * `console.authorize`; a browser denial gets the shared access-denied page, an API denial gets
 * `{ error }` with 401/403.
 */
export class ConfigConsole {
  readonly #authorize: (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision>;
  #warned = false;

  constructor(private readonly options: ConfigConsoleOptions) {
    this.#authorize = options.config.authorize
      ? resolveConsoleAuthorize(options.config.authorize)
      : async (_ctx) => {
          if (!this.options.inProduction) return { allowed: true };
          if (!this.#warned) {
            this.#warned = true;
            this.options.logger.warn(
              '[@adonis-agora/config] the console has no `authorize`: it is open outside production and denies every request in production',
            );
          }
          return { allowed: false, status: 403, reason: 'forbidden' };
        };
  }

  get path(): string {
    return this.options.config.path;
  }

  get api(): string {
    return this.options.config.api;
  }

  get admin(): ConfigAdmin {
    return this.options.admin;
  }

  get config(): ResolvedConsoleConfig {
    return this.options.config;
  }

  register(router: RouterLike): void {
    const root = this.options.config.path === '' ? '' : this.options.config.path;
    const api = this.options.config.api;

    router.get(root === '' ? '/' : root, (ctx) => this.spa(ctx));
    if (root !== '') router.get(`${root}/`, (ctx) => this.spa(ctx));
    router.get(`${root}/assets/:file`, (ctx) => this.asset(ctx));

    router.get(`${api}/meta`, (ctx) => this.#guarded(ctx, 'api', () => this.meta(ctx)));
    router.get(`${api}/entries`, (ctx) => this.#guarded(ctx, 'api', () => this.listEntries(ctx)));
    router.get(`${api}/entries/:key`, (ctx) => this.#guarded(ctx, 'api', () => this.getEntry(ctx)));
    router.put(`${api}/entries/:key`, (ctx) => this.#guarded(ctx, 'api', () => this.setEntry(ctx)));
    router.delete(`${api}/entries/:key`, (ctx) =>
      this.#guarded(ctx, 'api', () => this.unsetEntry(ctx)),
    );
    router.post(`${api}/entries/:key/reveal`, (ctx) =>
      this.#guarded(ctx, 'api', () => this.reveal(ctx)),
    );
    router.get(`${api}/versions`, (ctx) => this.#guarded(ctx, 'api', () => this.listVersions(ctx)));
    router.get(`${api}/versions/:version`, (ctx) =>
      this.#guarded(ctx, 'api', () => this.getVersion(ctx)),
    );
    router.get(`${api}/diff`, (ctx) => this.#guarded(ctx, 'api', () => this.diff(ctx)));
    router.post(`${api}/rollback`, (ctx) => this.#guarded(ctx, 'api', () => this.rollback(ctx)));
    router.get(`${api}/audit`, (ctx) => this.#guarded(ctx, 'api', () => this.audit(ctx)));
    router.get(`${api}/consoles`, (ctx) => this.#guarded(ctx, 'api', () => this.consoles(ctx)));
    router.get(`${api}/consoles/search`, (ctx) =>
      this.#guarded(ctx, 'api', () => this.search(ctx)),
    );
  }

  async #guard(ctx: HttpContext, kind: 'api' | 'page'): Promise<boolean> {
    const decision = await this.#authorize(ctx);
    if (decision.allowed) return true;
    if (decision.status === 302) {
      ctx.response.redirect(decision.redirectTo);
      return false;
    }
    if (kind === 'api') {
      ctx.response.status(decision.status).json({ error: decision.reason });
      return false;
    }
    const html = await resolveAccessDeniedPage(
      {
        status: decision.status,
        reason: decision.reason,
        basePath: this.options.config.path,
        ...(this.options.config.loginHref ? { loginHref: this.options.config.loginHref } : {}),
      },
      this.options.config.accessDenied,
      ctx,
      () => false,
    );
    if (html !== null) {
      ctx.response
        .status(decision.status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(html);
    }
    return false;
  }

  async #guarded(
    ctx: HttpContext,
    kind: 'api' | 'page',
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!(await this.#guard(ctx, kind))) return;
    try {
      return await handler();
    } catch (error) {
      return this.#fail(ctx, error);
    }
  }

  #fail(ctx: HttpContext, error: unknown) {
    if (error instanceof HttpError) {
      return ctx.response.status(error.status).json({ error: error.message });
    }
    if (error instanceof InvalidColumnFilterError) {
      return ctx.response.status(400).json({ error: error.message });
    }
    if (error instanceof Error && error.message.startsWith('config:')) {
      return ctx.response.status(400).json({ error: error.message });
    }
    this.options.logger.warn(
      `[@adonis-agora/config] console request failed: ${(error as Error).message}`,
    );
    return ctx.response.status(500).json({ error: (error as Error).message });
  }

  #body(ctx: HttpContext): Record<string, unknown> {
    const body = ctx.request.body() as unknown;
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  }

  #scope(ctx: HttpContext) {
    const query = ctx.request.qs() as Record<string, unknown>;
    const body = this.#body(ctx);
    const value = (name: string) => {
      const fromQuery = query[name];
      if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
      const fromBody = body[name];
      if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
      return undefined;
    };
    const app = value('app');
    if (!app) throw new HttpError(400, 'app is required');
    const environment = value('environment') ?? this.options.environment;
    const label = value('label') ?? DEFAULT_LABEL;
    if (this.options.config.apps && !this.options.config.apps.includes(app)) {
      throw new HttpError(403, `app "${app}" is not served by this console`);
    }
    return { app, environment, label };
  }

  async #actor(ctx: HttpContext): Promise<ConsoleActor> {
    return consoleActor(ctx);
  }

  /**
   * The console's ordinary reads NEVER decrypt a secret: the entry arrives masked, and the operator
   * asks for it explicitly (`POST /entries/:key/reveal`), which is audited. `revealSecrets` decides
   * whether that button works at all.
   */
  async #canReadSecrets(): Promise<boolean> {
    return false;
  }

  async #shell(ctx: HttpContext) {
    const registry = this.options.registry;
    const viewer = await resolveViewer(ctx, this.options.config.viewer);
    const signOut = resolveSignOut(ctx, this.options.config.signOut, registry);
    const switcher = registry
      ? { endpoint: `${this.api}/consoles`, others: otherConsoles(registry, CONSOLE_ID) }
      : undefined;
    return {
      ...(viewer ? { viewer } : {}),
      ...(signOut ? { signOut } : {}),
      ...(switcher && switcher.others > 0 ? { switcher } : {}),
      ...(registry ? { search: { endpoint: `${this.api}/consoles/search` } } : {}),
    };
  }

  async spa(ctx: HttpContext) {
    if (!(await this.#guard(ctx, 'page'))) return;
    let html: string;
    try {
      html = await readFile(join(this.options.spaDir, 'index.html'), 'utf8');
    } catch {
      return ctx.response
        .status(503)
        .send('@adonis-agora/config-dashboard is not built: run `pnpm build` in the package.');
    }
    const shell = await this.#shell(ctx);
    const rendered = renderIndexHtml(
      html,
      this.options.config.path,
      this.api,
      {
        ...(this.options.defaultApp ? { app: this.options.defaultApp } : {}),
        environment: this.options.environment,
        label: DEFAULT_LABEL,
      },
      shell,
    );
    ctx.response
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store');
    return ctx.response.send(rendered);
  }

  async asset(ctx: HttpContext) {
    if (!(await this.#guard(ctx, 'page'))) return;
    const file = String((ctx.params as Record<string, string>).file ?? '');
    if (file === '' || file !== basename(file)) {
      return ctx.response.status(404).send('not found');
    }
    try {
      const bytes = await readFile(join(this.options.spaDir, 'assets', file));
      ctx.response
        .header('content-type', contentTypeFor(file))
        .header('cache-control', 'public, max-age=31536000, immutable');
      return ctx.response.send(bytes);
    } catch {
      return ctx.response.status(404).send('not found');
    }
  }

  async meta(ctx: HttpContext) {
    const actor = await this.#actor(ctx);
    const scopes = await this.options.admin.scopes();
    const apps = this.options.config.apps ?? scopes.apps;
    const defaultApp =
      this.options.defaultApp && apps.includes(this.options.defaultApp)
        ? this.options.defaultApp
        : apps[0];
    return ctx.response.header('cache-control', 'no-store').json({
      apps,
      environments: [...new Set([...scopes.environments, this.options.environment])],
      labels: [...new Set([...scopes.labels, DEFAULT_LABEL])],
      default: {
        app: defaultApp ?? 'app',
        environment: this.options.environment,
        label: DEFAULT_LABEL,
      },
      secrets: this.options.secrets,
      canRevealSecrets: this.options.config.revealSecrets,
      topology: this.options.topology,
      actor: actor.id,
    });
  }

  async listEntries(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['key', 'updatedAt', 'updatedBy'],
      defaultSort: { field: 'key', direction: 'asc' },
      filterable: ['key', 'secret', 'reloadable', 'updatedBy'],
      defaultSize: 50,
      maxSize: 200,
    });
    const secret = booleanFilter(list.filters.secret);
    const reloadable = booleanFilter(list.filters.reloadable);
    const updatedBy = list.filters.updatedBy;
    return ctx.response.json(
      await this.options.admin.listEntries(scope, await this.#canReadSecrets(), {
        page: list.page,
        size: list.size,
        filters: {
          ...(list.search !== undefined ? { search: list.search } : {}),
          ...(secret !== undefined ? { secret } : {}),
          ...(reloadable !== undefined ? { reloadable } : {}),
          ...(typeof updatedBy === 'string' ? { updatedBy } : {}),
        },
        sort: list.sort as { field: 'key' | 'updatedAt' | 'updatedBy'; direction: 'asc' | 'desc' },
      }),
    );
  }

  async getEntry(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    if (!key) throw new HttpError(400, 'key is required');
    const entry = await this.options.admin.getEntry(scope, key, {
      canReadSecrets: await this.#canReadSecrets(),
    });
    if (!entry) throw new HttpError(404, `no entry "${key}"`);
    return ctx.response.header('cache-control', 'no-store').json(entry);
  }

  async setEntry(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    assertConfigKey(key);
    const body = this.#body(ctx);
    if (body.value === undefined && body.vault === undefined) {
      throw new HttpError(400, 'value or vault is required (a PUT is an upsert, not an unset)');
    }
    const input: Omit<ConfigEntryInput, 'key'> = {};
    if (body.value !== undefined) input.value = toConfigValue(body.value) as ConfigValue;
    if (body.vault !== undefined) {
      if (typeof body.vault !== 'string' || !body.vault.startsWith('vault://')) {
        throw new HttpError(400, 'vault must be a vault:// reference');
      }
      input.vault = body.vault;
    }
    if (body.secret !== undefined) {
      if (typeof body.secret !== 'boolean') throw new HttpError(400, 'secret must be a boolean');
      input.secret = body.secret;
    }
    if (body.reloadable !== undefined) {
      if (typeof body.reloadable !== 'boolean') {
        throw new HttpError(400, 'reloadable must be a boolean');
      }
      input.reloadable = body.reloadable;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw new HttpError(400, 'description must be a string or null');
      }
      input.description = body.description as string | null;
    }
    const actor = await this.#actor(ctx);
    const result = await this.options.admin.setEntry(scope, key, input, {
      actor: actor.id,
      ...(typeof body.message === 'string' && body.message !== '' ? { message: body.message } : {}),
    });
    const entry = await this.options.admin.getEntry(scope, key, {
      canReadSecrets: await this.#canReadSecrets(),
    });
    return ctx.response
      .status(200)
      .json({ entry, version: result.version, changed: result.changed });
  }

  async unsetEntry(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    assertConfigKey(key);
    const actor = await this.#actor(ctx);
    const body = this.#body(ctx);
    const result = await this.options.admin.unsetEntry(scope, key, {
      actor: actor.id,
      ...(typeof body.message === 'string' && body.message !== '' ? { message: body.message } : {}),
    });
    return ctx.response.json(result);
  }

  async reveal(ctx: HttpContext) {
    if (!this.options.config.revealSecrets) {
      throw new HttpError(403, 'revealing secrets is disabled on this console');
    }
    const scope = this.#scope(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    const actor = await this.#actor(ctx);
    const entry = await this.options.admin.getEntry(scope, key, {
      canReadSecrets: true,
      reveal: { actor: actor.id },
    });
    if (!entry) throw new HttpError(404, `no entry "${key}"`);
    return ctx.response.header('cache-control', 'no-store').json(entry);
  }

  async listVersions(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['version', 'createdAt'],
      defaultSort: { field: 'version', direction: 'desc' },
      filterable: [],
      defaultSize: 20,
      maxSize: 100,
    });
    return ctx.response.json(
      await this.options.admin.listVersions(scope, {
        page: list.page,
        size: list.size,
        direction: list.sort.direction,
      }),
    );
  }

  async getVersion(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const version = Number((ctx.params as Record<string, string>).version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'invalid version');
    const found = await this.options.admin.version(scope, version, await this.#canReadSecrets());
    if (!found) throw new HttpError(404, `no version ${version}`);
    return ctx.response.json(found);
  }

  async diff(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const query = ctx.request.qs() as Record<string, unknown>;
    const from = Number(query.from);
    const to = Number(query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new HttpError(400, 'from and to must be version numbers');
    }
    return ctx.response.json({
      from,
      to,
      rows: await this.options.admin.diff(scope, from, to, await this.#canReadSecrets()),
    });
  }

  async rollback(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const body = this.#body(ctx);
    const to = Number(body.to);
    if (!Number.isInteger(to) || to < 1) throw new HttpError(400, 'to must be a version number');
    const actor = await this.#actor(ctx);
    const result = await this.options.admin.rollback(scope, to, {
      actor: actor.id,
      ...(typeof body.message === 'string' && body.message !== '' ? { message: body.message } : {}),
    });
    return ctx.response.json(result);
  }

  async audit(ctx: HttpContext) {
    const scope = this.#scope(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['at', 'version'],
      defaultSort: { field: 'at', direction: 'desc' },
      filterable: ['key', 'action'],
      defaultSize: 50,
      maxSize: 200,
    });
    const action = list.filters.action;
    const key = list.filters.key;
    return ctx.response.json(
      await this.options.admin.audit(scope, {
        page: list.page,
        size: list.size,
        ...(typeof action === 'string' ? { action } : {}),
        ...(typeof key === 'string' ? { key } : {}),
      }),
    );
  }

  async consoles(ctx: HttpContext) {
    return ctx.response.json(await listVisibleConsoles(this.options.registry, CONSOLE_ID, ctx));
  }

  async search(ctx: HttpContext) {
    const q = (ctx.request.qs() as { q?: string }).q ?? '';
    return ctx.response.json(await searchConsoles(this.options.registry, CONSOLE_ID, ctx, q));
  }
}

// A token-gated console still answers the same way; the helper is exported for apps that want it.
export const consoleAuthorizeByToken = tokenAuthorize;
