import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  assertConfigKey,
  CONFIG_SCOPES,
  type ConfigEntryInput,
  type ConfigScope,
  type ConfigValue,
  DEFAULT_LABEL,
  toConfigValue,
} from '@adonis-agora/config-core';
import { InvalidColumnFilterError, parseCursorParams } from '@adonis-agora/filter';
import type { HttpContext } from '@adonisjs/core/http';
import type { ConfigAdmin, EntryRow } from '../admin.js';
import {
  type CommandMeta,
  configConsoleAllows,
  FederatedAppError,
  type FederatedConfigApp,
  type FederatedConfigApps,
  viewerConsoleCapabilities,
} from '../federation/console.js';
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
  /** Other apps this console shows (`console.federatedApps`): read from their stores, changed through them. */
  federated?: FederatedConfigApps;
}

/** What a request works on: this console's admin, or another app's (read-only) and its channel. */
interface Target {
  scope: ConfigScope;
  admin: ConfigAdmin;
  federated?: FederatedConfigApp;
}

/** This console's id in the `'agora.consoles'` registry. */
export const CONSOLE_ID = 'config';

/**
 * The cursor half of a list request (`first`, `after`), or `undefined` when it pages by `page`/`size`.
 * Forward only: `before`/`last` are a 400.
 */
function readCursor(
  query: Record<string, unknown>,
  maxSize: number,
  defaultSize: number,
): { size: number; after?: string } | undefined {
  const sent = (name: string) => query[name] !== undefined && query[name] !== '';
  if (!['first', 'after', 'last', 'before'].some(sent)) return undefined;
  const params = parseCursorParams(query, { defaultSize, maxSize });
  if (params.before !== undefined || params.backward) {
    throw new HttpError(400, 'this list pages forward only: use after and first');
  }
  return { size: params.size, ...(params.after !== undefined ? { after: params.after } : {}) };
}

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
 *
 * Which apps a request may see is the static `console.apps` (when set) narrowed by the viewer's
 * grant: the `apps` an authorizer answered with (`'*'` or omitted: no narrowing).
 */
export class ConfigConsole {
  readonly #authorize: (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision>;
  /** The authorizer's `apps` grant for each request it allowed. */
  readonly #grants = new WeakMap<HttpContext, string[]>();
  /** The authorizer's `capabilities` for each request it allowed, when it said. */
  readonly #capabilities = new WeakMap<HttpContext, string[]>();
  /** The authorizer's `access` for each request it allowed, when it said. */
  readonly #access = new WeakMap<HttpContext, 'read' | 'write'>();
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

    // ONE route for the SPA. AdonisJS drops the trailing slash when it computes a route pattern, so
    // `/<path>` and `/<path>/` are the same route: registering both dies at boot with "Duplicate
    // route found". The single route also answers the trailing-slash URL.
    router.get(root === '' ? '/' : root, (ctx) => this.spa(ctx));
    router.get(`${root}/assets/:file`, (ctx) => this.asset(ctx));

    router.get(`${api}/meta`, (ctx) => this.#guarded(ctx, 'api', () => this.meta(ctx)));
    router.get(`${api}/apps`, (ctx) => this.#guarded(ctx, 'api', () => this.apps(ctx)));
    router.get(`${api}/scopes`, (ctx) => this.#guarded(ctx, 'api', () => this.scopes(ctx)));
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
    if (decision.allowed) {
      if (Array.isArray(decision.apps)) this.#grants.set(ctx, decision.apps);
      if (Array.isArray(decision.capabilities)) {
        this.#capabilities.set(ctx, decision.capabilities);
      }
      if (decision.access !== undefined) this.#access.set(ctx, decision.access);
      return true;
    }
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
    if (error instanceof FederatedAppError) {
      if (error.detail !== undefined) {
        this.options.logger.warn(
          `[@adonis-agora/config] federated console: ${error.message}: ${error.detail}`,
        );
      }
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
    if (!this.#granted(ctx, app)) {
      throw new HttpError(403, `app "${app}" is not granted to this viewer`);
    }
    return { app, environment, label };
  }

  /** Whether `app` names another app of this console (`console.federatedApps`). */
  #isFederated(app: string): boolean {
    return this.options.federated?.has(app) ?? false;
  }

  /**
   * The app a request is about: a key of `console.federatedApps` (that app's store, read-only, and
   * its command channel; the viewer's `apps` grant must name it), else a scope of this console.
   */
  async #target(ctx: HttpContext): Promise<Target> {
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
    if (app && this.options.federated && this.#isFederated(app)) {
      if (!this.#granted(ctx, app)) {
        throw new HttpError(403, `app "${app}" is not granted to this viewer`);
      }
      const federated = await this.options.federated.get(app);
      return {
        scope: {
          app: federated.partition,
          environment: value('environment') ?? federated.environment ?? this.options.environment,
          label: value('label') ?? DEFAULT_LABEL,
        },
        admin: federated.admin,
        federated,
      };
    }
    return { scope: this.#scope(ctx), admin: this.options.admin };
  }

  /** What a command to another app carries: the viewer (the actor) and what it was granted. */
  async #commandMeta(ctx: HttpContext): Promise<CommandMeta> {
    const actor = await this.#actor(ctx);
    // Always sent: the viewer's grant from `authorize`, or (when it does not narrow) every config
    // console capability. The owning app refuses a command without them.
    const capabilities = this.#viewerCapabilities(ctx);
    return {
      actor: actor.id,
      capabilities,
      ...(this.options.config.appLabel !== undefined ? { via: this.options.config.appLabel } : {}),
    };
  }

  /**
   * What the viewer may do, on this console's own apps and on federated ones alike: its
   * `authorize` capabilities narrowed to config's console set (`access: 'read'` drops writes), or
   * everything when `authorize` said nothing.
   */
  #viewerCapabilities(ctx: HttpContext): string[] {
    return viewerConsoleCapabilities(this.#capabilities.get(ctx), this.#access.get(ctx));
  }

  /** Whether `authorize` narrowed this viewer (capabilities or `access`). */
  #narrowed(ctx: HttpContext): boolean {
    return this.#capabilities.has(ctx) || this.#access.has(ctx);
  }

  /** Refuses a viewer that lacks `capability` (`403`, the wording every Agora console uses). */
  #demand(ctx: HttpContext, capability: string): void {
    if (!configConsoleAllows(this.#viewerCapabilities(ctx), capability)) {
      throw new HttpError(403, `the viewer lacks ${capability}`);
    }
  }

  /** Whether the viewer's grant covers `app` (no grant, or `'*'`: every app). */
  #granted(ctx: HttpContext, app: string): boolean {
    const grant = this.#grants.get(ctx);
    return grant === undefined || grant.includes(app);
  }

  /** Whether this request may see `app`: inside `console.apps` and the viewer's grant. */
  #visible(ctx: HttpContext, app: string): boolean {
    const allowed = this.options.config.apps;
    return (allowed === undefined || allowed.includes(app)) && this.#granted(ctx, app);
  }

  /** The `actor` hook's answer when it names someone, else the structural default. */
  async #actor(ctx: HttpContext): Promise<ConsoleActor> {
    const hook = this.options.config.actor;
    if (hook) {
      try {
        const answer = await hook(ctx);
        const actor = typeof answer === 'string' ? { id: answer } : answer;
        const id = typeof actor?.id === 'string' ? actor.id.trim() : '';
        if (id !== '') {
          const email =
            typeof actor?.email === 'string' && actor.email !== '' ? actor.email : undefined;
          return { id, ...(email ? { email } : {}) };
        }
      } catch {
        // A failing hook records the default actor rather than failing the write.
      }
    }
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
        ...(this.options.defaultApp && this.#visible(ctx, this.options.defaultApp)
          ? { app: this.options.defaultApp }
          : {}),
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
    const grant = this.#grants.get(ctx);
    // A granted app the store does not hold yet is listed too, so the viewer can write its first entry.
    const candidates =
      this.options.config.apps ?? [...new Set([...scopes.apps, ...(grant ?? [])])].sort();
    const federated = (this.options.federated?.ids ?? []).filter((app) => this.#granted(ctx, app));
    // Another app's key names that app here, so a local scope of the same name is not listed.
    const apps = [
      ...candidates.filter((app) => this.#visible(ctx, app) && !this.#isFederated(app)),
      ...federated,
    ];
    const defaultApp =
      this.options.defaultApp && apps.includes(this.options.defaultApp)
        ? this.options.defaultApp
        : apps[0];
    return ctx.response.header('cache-control', 'no-store').json({
      apps,
      environments: [...new Set([...scopes.environments, this.options.environment])],
      labels: [...new Set([...scopes.labels, DEFAULT_LABEL])],
      default: {
        app: defaultApp ?? (grant === undefined ? 'app' : ''),
        environment: this.options.environment,
        label: DEFAULT_LABEL,
      },
      secrets: this.options.secrets,
      canRevealSecrets:
        this.options.config.revealSecrets &&
        configConsoleAllows(this.#viewerCapabilities(ctx), CONFIG_SCOPES.secretsRead),
      // What the viewer may do, when `authorize` narrowed it: the UI disables the rest.
      ...(this.#narrowed(ctx)
        ? {
            viewer: {
              capabilities: this.#viewerCapabilities(ctx),
              canWrite: configConsoleAllows(this.#viewerCapabilities(ctx), CONFIG_SCOPES.write),
            },
          }
        : {}),
      topology: this.options.topology,
      actor: actor.id,
      ...(federated.length > 0
        ? { federated: federated.map((id) => this.options.federated!.describe(id)) }
        : {}),
    });
  }

  /**
   * The App picker of the federated console, the shape every Agora console answers: this
   * console's own scopes are `local`, the other apps are listed with how they are reached.
   */
  async apps(ctx: HttpContext) {
    const federated = (this.options.federated?.ids ?? []).filter((app) => this.#granted(ctx, app));
    const picked = (ctx.request.qs() as { app?: unknown }).app;
    return ctx.response.header('cache-control', 'no-store').json({
      local: { label: this.options.config.appLabel ?? 'This app' },
      apps: federated.map((id) => this.options.federated!.describe(id)),
      selected: typeof picked === 'string' && federated.includes(picked) ? picked : null,
    });
  }

  /** The environments and labels the picked app holds (another app: its own store's). */
  async scopes(ctx: HttpContext) {
    const app = (ctx.request.qs() as { app?: unknown }).app;
    if (typeof app === 'string' && this.#isFederated(app)) {
      const target = await this.#target(ctx);
      const own = (await target.admin.store.listScopes()).filter(
        (scope) => scope.app === target.scope.app,
      );
      const environment = target.federated?.environment ?? this.options.environment;
      return ctx.response.header('cache-control', 'no-store').json({
        environments: [...new Set([...own.map((s) => s.environment), environment])].sort(),
        labels: [...new Set([...own.map((s) => s.label), DEFAULT_LABEL])].sort(),
        default: { environment, label: DEFAULT_LABEL },
      });
    }
    const scopes = await this.options.admin.scopes();
    return ctx.response.header('cache-control', 'no-store').json({
      environments: [...new Set([...scopes.environments, this.options.environment])],
      labels: [...new Set([...scopes.labels, DEFAULT_LABEL])],
      default: { environment: this.options.environment, label: DEFAULT_LABEL },
    });
  }

  async listEntries(ctx: HttpContext) {
    const { scope, admin } = await this.#target(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['key', 'updatedAt', 'updatedBy'],
      defaultSort: { field: 'key', direction: 'asc' },
      filterable: ['key', 'secret', 'reloadable', 'browser', 'updatedBy'],
      defaultSize: 50,
      maxSize: 200,
    });
    const secret = booleanFilter(list.filters.secret);
    const reloadable = booleanFilter(list.filters.reloadable);
    const browser = booleanFilter(list.filters.browser);
    const updatedBy = list.filters.updatedBy;
    return ctx.response.json(
      await admin.listEntries(scope, await this.#canReadSecrets(), {
        page: list.page,
        size: list.size,
        filters: {
          ...(list.search !== undefined ? { search: list.search } : {}),
          ...(secret !== undefined ? { secret } : {}),
          ...(reloadable !== undefined ? { reloadable } : {}),
          ...(browser !== undefined ? { browser } : {}),
          ...(typeof updatedBy === 'string' ? { updatedBy } : {}),
        },
        sort: list.sort as { field: 'key' | 'updatedAt' | 'updatedBy'; direction: 'asc' | 'desc' },
      }),
    );
  }

  async getEntry(ctx: HttpContext) {
    const { scope, admin } = await this.#target(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    if (!key) throw new HttpError(400, 'key is required');
    const entry = await admin.getEntry(scope, key, {
      canReadSecrets: await this.#canReadSecrets(),
    });
    if (!entry) throw new HttpError(404, `no entry "${key}"`);
    return ctx.response.header('cache-control', 'no-store').json(entry);
  }

  async setEntry(ctx: HttpContext) {
    this.#demand(ctx, CONFIG_SCOPES.write);
    const { scope, admin, federated } = await this.#target(ctx);
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
    if (body.sealedTo !== undefined) {
      if (typeof body.sealedTo !== 'boolean') {
        throw new HttpError(400, 'sealedTo must be a boolean');
      }
      input.sealedTo = body.sealedTo;
    }
    if (body.reloadable !== undefined) {
      if (typeof body.reloadable !== 'boolean') {
        throw new HttpError(400, 'reloadable must be a boolean');
      }
      input.reloadable = body.reloadable;
    }
    if (body.browser !== undefined) {
      if (typeof body.browser !== 'boolean') throw new HttpError(400, 'browser must be a boolean');
      input.browser = body.browser;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw new HttpError(400, 'description must be a string or null');
      }
      input.description = body.description as string | null;
    }
    const message =
      typeof body.message === 'string' && body.message !== '' ? body.message : undefined;
    const result = federated
      ? await federated.setEntry(
          scope,
          key,
          { ...input, ...(message !== undefined ? { message } : {}) },
          await this.#commandMeta(ctx),
        )
      : await admin.setEntry(scope, key, input, {
          actor: (await this.#actor(ctx)).id,
          ...(message !== undefined ? { message } : {}),
        });
    const entry = await admin.getEntry(scope, key, {
      canReadSecrets: await this.#canReadSecrets(),
    });
    return ctx.response
      .status(200)
      .json({ entry, version: result.version, changed: result.changed });
  }

  async unsetEntry(ctx: HttpContext) {
    this.#demand(ctx, CONFIG_SCOPES.write);
    const { scope, admin, federated } = await this.#target(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    assertConfigKey(key);
    const body = this.#body(ctx);
    const message =
      typeof body.message === 'string' && body.message !== '' ? body.message : undefined;
    const result = federated
      ? await federated.unsetEntry(scope, key, message, await this.#commandMeta(ctx))
      : await admin.unsetEntry(scope, key, {
          actor: (await this.#actor(ctx)).id,
          ...(message !== undefined ? { message } : {}),
        });
    return ctx.response.json(result);
  }

  async reveal(ctx: HttpContext) {
    if (!this.options.config.revealSecrets) {
      throw new HttpError(403, 'revealing secrets is disabled on this console');
    }
    this.#demand(ctx, CONFIG_SCOPES.secretsRead);
    const { scope, admin, federated } = await this.#target(ctx);
    const key = String((ctx.params as Record<string, string>).key ?? '');
    let entry: EntryRow | null;
    if (federated) {
      // Another app's secret: only for a viewer `authorize` granted `config:secrets:read`; the app
      // checks it again, reads the value itself and records the reveal with this viewer as actor.
      const meta = await this.#commandMeta(ctx);
      entry = await federated.reveal(scope, key, meta);
    } else {
      const actor = await this.#actor(ctx);
      entry = await admin.getEntry(scope, key, {
        canReadSecrets: true,
        reveal: { actor: actor.id },
      });
    }
    if (!entry) throw new HttpError(404, `no entry "${key}"`);
    return ctx.response.header('cache-control', 'no-store').json(entry);
  }

  async listVersions(ctx: HttpContext) {
    const { scope, admin } = await this.#target(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['version', 'createdAt'],
      defaultSort: { field: 'version', direction: 'desc' },
      filterable: [],
      defaultSize: 20,
      maxSize: 100,
    });
    const cursor = readCursor(ctx.request.qs() as Record<string, unknown>, 100, 20);
    if (cursor !== undefined) {
      return ctx.response.json(
        await admin.versionsCursor(scope, {
          ...cursor,
          direction: list.sort.direction,
        }),
      );
    }
    return ctx.response.json(
      await admin.listVersions(scope, {
        page: list.page,
        size: list.size,
        direction: list.sort.direction,
      }),
    );
  }

  async getVersion(ctx: HttpContext) {
    const { scope, admin } = await this.#target(ctx);
    const version = Number((ctx.params as Record<string, string>).version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'invalid version');
    const found = await admin.version(scope, version, await this.#canReadSecrets());
    if (!found) throw new HttpError(404, `no version ${version}`);
    // The console reads `{ version, entries }`; the admin API calls the summary `summary`.
    return ctx.response.json({ version: found.summary, entries: found.entries });
  }

  async diff(ctx: HttpContext) {
    const { scope, admin } = await this.#target(ctx);
    const query = ctx.request.qs() as Record<string, unknown>;
    const from = Number(query.from);
    const to = Number(query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new HttpError(400, 'from and to must be version numbers');
    }
    return ctx.response.json({
      from,
      to,
      rows: await admin.diff(scope, from, to, await this.#canReadSecrets()),
    });
  }

  async rollback(ctx: HttpContext) {
    this.#demand(ctx, CONFIG_SCOPES.write);
    const { scope, admin, federated } = await this.#target(ctx);
    const body = this.#body(ctx);
    const to = Number(body.to);
    if (!Number.isInteger(to) || to < 1) throw new HttpError(400, 'to must be a version number');
    const message =
      typeof body.message === 'string' && body.message !== '' ? body.message : undefined;
    const result = federated
      ? await federated.rollback(scope, to, message, await this.#commandMeta(ctx))
      : await admin.rollback(scope, to, {
          actor: (await this.#actor(ctx)).id,
          ...(message !== undefined ? { message } : {}),
        });
    return ctx.response.json(result);
  }

  async audit(ctx: HttpContext) {
    const { scope, admin } = await this.#target(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['at', 'version'],
      defaultSort: { field: 'at', direction: 'desc' },
      filterable: ['key', 'action'],
      defaultSize: 50,
      maxSize: 200,
    });
    const action = list.filters.action;
    const key = list.filters.key;
    const cursor = readCursor(ctx.request.qs() as Record<string, unknown>, 200, 50);
    if (cursor !== undefined) {
      if (list.sort.field !== 'at' || list.sort.direction !== 'desc') {
        throw new HttpError(400, 'the audit pages by cursor newest first only (sort=-at)');
      }
      return ctx.response.json(
        await admin.auditCursor(scope, {
          ...cursor,
          ...(typeof action === 'string' ? { action } : {}),
          ...(typeof key === 'string' ? { key } : {}),
        }),
      );
    }
    return ctx.response.json(
      await admin.audit(scope, {
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
