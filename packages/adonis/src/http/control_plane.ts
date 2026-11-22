import { PassThrough } from 'node:stream';
import {
  CONFIG_RESOURCE,
  CONFIG_SCOPES,
  type ConfigDocument,
  type ConfigDocumentView,
  type ConfigEntryView,
  type ConfigScope,
  capabilityAllows,
  DEFAULT_LABEL,
  etagMatches,
  etagOf,
  fingerprintOf,
  maskDocument,
  parseVaultReference,
} from '@adonis-agora/config-core';
import type { HttpContext } from '@adonisjs/core/http';
import { browserKeyOf } from '../browser_token.js';
import {
  registerTenantKeys,
  resealTenantEntries,
  type TenantResealUpdate,
} from '../crypto/tenant_keys.js';
import type { VaultResolver } from '../define_config.js';
import { emitConfig } from '../diagnostics.js';
import type { ConfigStore } from '../store/store.js';
import {
  bearerToken,
  checkVerifiedTenant,
  requestHeaders,
  type TenantVerifier,
  type VerifiedTenant,
} from '../topology/verify.js';
import type { ConfigTransport } from '../transports/types.js';
import { BrowserApi } from './browser_api.js';

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  any?(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
}

/** A body reader that works with Adonis' request and the test harness alike. */
function bodyOf(ctx: HttpContext): unknown {
  const request = ctx.request as unknown as { body?: () => unknown };
  return typeof request.body === 'function' ? request.body() : {};
}

/** A tenant that reached the control plane, for the console's overview. */
export interface TenantPresence {
  partition: string;
  environment: string;
  label: string;
  capabilities: string[];
  lastSeenAt: string;
  lastVersion?: number;
}

/** In-process change notifications for SSE streams (a replica without it falls back to polling). */
export class ChangeBus {
  readonly #listeners = new Set<(scope: ConfigScope, version: number) => void>();

  publish(scope: ConfigScope, version: number): void {
    for (const listener of this.#listeners) {
      try {
        listener(scope, version);
      } catch {
        // a broken stream must not break the writer
      }
    }
  }

  subscribe(listener: (scope: ConfigScope, version: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export interface ControlPlaneOptions {
  store: ConfigStore;
  verifyTenant: TenantVerifier;
  /** The environment used when the token does not name one. */
  environment: string;
  /** `/_config`. */
  prefix?: string;
  /** Origins allowed to call the tenant API from a browser. */
  corsOrigins?: string[];
  /** Resolves `vault://…` entries for a token with `config:secrets:read`. */
  vault?: VaultResolver;
  logger?: { warn(message: string): void; debug?(message: string): void };
  /** Where change notifications come from (the provider shares one with the console). */
  bus?: ChangeBus;
  /** Broker transport for tenants that watch over redis/durable; the HTTP API is always mounted. */
  transport?: ConfigTransport;
  /** Serve browsers directly (`browser` in config/config.ts): the browser-key route and API. */
  browser?: { secret: string; corsOrigins: readonly string[] };
}

const presence = new Map<string, TenantPresence>();

/** Tenants that called this control plane since boot, newest activity last (shown in the console). */
export function knownTenants(): TenantPresence[] {
  return [...presence.values()].sort((a, b) => a.partition.localeCompare(b.partition));
}

/** Forgets tenant presence rows (tests). */
export function resetKnownTenants(): void {
  presence.clear();
}

/**
 * The tenant-facing API, under `/_config/v1`:
 *
 * - `GET /v1/config` — the token's scope as one document, with an `ETag` (conditional GET → 304);
 * - `GET /v1/config/stream` — server-sent events on every change;
 * - `GET /v1/whoami` — what the token is (the doctor's reachability and token check).
 *
 * The app and environment come from the verified token. A header that claims another app is
 * passed to the verifier (which may use it to pick the shared secret) and is never trusted alone.
 */
export class ControlPlane {
  readonly prefix: string;
  readonly bus: ChangeBus;
  /** The browser API, when `browser` is configured. */
  readonly browser: BrowserApi | undefined;

  constructor(private readonly options: ControlPlaneOptions) {
    this.prefix = (options.prefix ?? '/_config').replace(/\/$/, '');
    this.bus = options.bus ?? new ChangeBus();
    this.browser = options.browser
      ? new BrowserApi({
          store: options.store,
          bus: this.bus,
          secret: options.browser.secret,
          corsOrigins: options.browser.corsOrigins,
          ...(options.logger ? { logger: options.logger } : {}),
        })
      : undefined;
  }

  /** Stops the browser streams' watchers. */
  close(): void {
    this.browser?.close();
  }

  register(router: RouterLike): void {
    const p = this.prefix;
    router.get(`${p}/v1/config`, (ctx) => this.getConfig(ctx)).as('config.cp.config');
    router.get(`${p}/v1/config/stream`, (ctx) => this.stream(ctx)).as('config.cp.stream');
    router.get(`${p}/v1/whoami`, (ctx) => this.whoami(ctx)).as('config.cp.whoami');
    this.#route(router, `${p}/v1/keys`, 'GET', (ctx) => this.getKeys(ctx));
    this.#route(router, `${p}/v1/keys`, 'PUT', (ctx) => this.putKeys(ctx));
    this.#route(router, `${p}/v1/sealed`, 'POST', (ctx) => this.postSealed(ctx));
    if (this.browser) {
      this.#route(router, `${p}/v1/browser-key`, 'POST', (ctx) => this.postBrowserKey(ctx));
      this.browser.register(router, p);
    }
    if (this.options.corsOrigins?.length && router.route) {
      for (const path of ['config', 'config/stream', 'whoami', 'keys']) {
        router.route(`${p}/v1/${path}`, ['OPTIONS'], (ctx) => this.preflight(ctx));
      }
      router.route(`${p}/v1/sealed`, ['OPTIONS'], (ctx) => this.preflight(ctx));
    }
  }

  /** Registers a non-GET route: `route` on Adonis, `any` on a minimal router. */
  #route(
    router: RouterLike,
    pattern: string,
    method: string,
    handler: (ctx: HttpContext) => unknown,
  ): void {
    if (router.route) {
      router.route(pattern, [method], handler);
      return;
    }
    router.any?.(pattern, handler);
  }

  async #authenticate(ctx: HttpContext, required: string): Promise<VerifiedTenant | null> {
    const headers = requestHeaders(ctx);
    const claimed = ctx.request.header('x-config-app') ?? undefined;
    let verified: VerifiedTenant | null;
    try {
      verified = checkVerifiedTenant(
        await this.options.verifyTenant({
          token: bearerToken(ctx),
          app: claimed,
          partition: claimed,
          tenant: claimed,
          environment: ctx.request.header('x-config-environment') ?? undefined,
          label: ctx.request.header('x-config-label') ?? undefined,
          headers,
        }),
      );
    } catch (error) {
      // A verifier that throws (discovery down, malformed answer) never becomes an accepted tenant.
      this.options.logger?.warn(
        `[@adonis-agora/config] verifyTenant failed: ${(error as Error).message}`,
      );
      ctx.response.status(401).send({ error: 'unauthorized' });
      return null;
    }
    if (!verified) {
      ctx.response.status(401).send({ error: 'unauthorized' });
      return null;
    }
    if (!capabilityAllows(verified.capabilities, required)) {
      ctx.response.status(403).send({ error: `token lacks the ${required} capability` });
      return null;
    }
    return verified;
  }

  #scope(verified: VerifiedTenant, ctx?: HttpContext): ConfigScope {
    const queryLabel = ctx ? (ctx.request.qs().label as string | undefined) : undefined;
    return {
      app: verified.partition,
      environment: verified.environment ?? this.options.environment,
      label: verified.label ?? queryLabel ?? DEFAULT_LABEL,
    };
  }

  #record(scope: ConfigScope, verified: VerifiedTenant, version: number): void {
    presence.set(`${scope.app}\u0000${scope.environment}\u0000${scope.label}`, {
      partition: scope.app,
      environment: scope.environment,
      label: scope.label,
      capabilities: verified.capabilities,
      lastSeenAt: new Date().toISOString(),
      lastVersion: version,
    });
  }

  /** The document as the caller may see it: masked first, then vault references resolved. */
  async view(document: ConfigDocument, canReadSecrets: boolean): Promise<ConfigDocumentView> {
    // A sealed value is served as ciphertext to a secret reader (only the app opens it); without
    // the capability it stays masked like any other secret.
    const view = maskDocument(document, canReadSecrets, { serveSealed: true });
    if (!canReadSecrets || !this.options.vault) return view;
    const entries: Record<string, ConfigEntryView> = {};
    for (const [key, entry] of Object.entries(view.entries)) {
      if (entry.vault === undefined) {
        entries[key] = entry;
        continue;
      }
      try {
        const resolved = await this.options.vault(parseVaultReference(entry.vault));
        if (resolved === undefined) {
          const { value: _value, ...rest } = entry;
          entries[key] = { ...rest, masked: true };
        } else {
          entries[key] = { ...entry, value: resolved, masked: false };
        }
      } catch (error) {
        this.options.logger?.warn(
          `[@adonis-agora/config] vault reference for "${key}" failed: ${(error as Error).message}`,
        );
        const { value: _value, ...rest } = entry;
        entries[key] = { ...rest, masked: true };
      }
    }
    return { ...view, entries };
  }

  async #snapshot(scope: ConfigScope, verified: VerifiedTenant) {
    const document = await this.options.store.read(scope);
    const canReadSecrets = capabilityAllows(verified.capabilities, CONFIG_SCOPES.secretsRead);
    if (!document) {
      return {
        view: {
          ...scope,
          version: 0,
          fingerprint: fingerprintOf({}),
          entries: {},
          createdAt: new Date(0).toISOString(),
          createdBy: '',
        } satisfies ConfigDocumentView,
        version: 0,
      };
    }
    return { view: await this.view(document, canReadSecrets), version: document.version };
  }

  #cors(ctx: HttpContext): void {
    const origin = ctx.request.header('origin');
    if (origin && this.options.corsOrigins?.includes(origin)) {
      ctx.response.header('access-control-allow-origin', origin);
      ctx.response.header('vary', 'Origin');
      ctx.response.header('access-control-expose-headers', 'ETag, X-Config-Version');
    }
  }

  async preflight(ctx: HttpContext) {
    this.#cors(ctx);
    ctx.response.header('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
    ctx.response.header(
      'access-control-allow-headers',
      'authorization, x-api-key, x-config-app, x-config-environment, x-config-label, if-none-match',
    );
    return ctx.response.status(204).send('');
  }

  async getConfig(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    const scope = this.#scope(verified, ctx);
    const { view } = await this.#snapshot(scope, verified);
    this.#record(scope, verified, view.version);
    const etag = etagOf(scope.app, scope.environment, scope.label, view.version);
    ctx.response.header('etag', etag);
    ctx.response.header('x-config-version', String(view.version));
    ctx.response.header('cache-control', 'no-cache');
    if (etagMatches(ctx.request.header('if-none-match'), etag)) {
      return ctx.response.status(304).send('');
    }
    // The control plane coordinates the read, so it emits it (attributed to the tenant's app).
    emitConfig('tenant.fetch', {
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
      version: view.version,
      actor: verified.clientId ?? verified.partition,
      entries: Object.keys(view.entries).length,
      secrets: capabilityAllows(verified.capabilities, CONFIG_SCOPES.secretsRead),
    });
    return ctx.response.json(view);
  }

  async whoami(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    const scope = this.#scope(verified, ctx);
    ctx.response.header('cache-control', 'no-store');
    return ctx.response.json({
      resource: CONFIG_RESOURCE,
      partition: scope.app,
      environment: scope.environment,
      label: scope.label,
      capabilities: verified.capabilities,
      ...(verified.expiresAt ? { expiresAt: new Date(verified.expiresAt).toISOString() } : {}),
    });
  }

  /** The public keys this app registered (no private part ever reaches the server). */
  async getKeys(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    const keys = (await this.options.store.listTenantKeys?.(verified.partition)) ?? [];
    ctx.response.header('cache-control', 'no-store');
    return ctx.response.json({
      app: verified.partition,
      active: keys.find((key) => key.active)?.kid ?? keys[0]?.kid,
      keys: keys.map((key) => ({
        ...key.publicKey,
        active: key.active,
        registeredAt: key.createdAt,
        registeredBy: key.createdBy,
      })),
    });
  }

  /**
   * Registers the app's X25519 public keys. The app comes from the verified token; the body only
   * carries public JWKs and which `kid` is active, so a tenant can only speak for itself.
   */
  async putKeys(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    try {
      const keys = await registerTenantKeys(this.options.store, verified.partition, bodyOf(ctx), {
        actor: verified.clientId ?? verified.partition,
        now: new Date().toISOString(),
      });
      const active = keys.find((key) => key.active)?.kid ?? keys[0]?.kid;
      emitConfig('key.registered', {
        app: verified.partition,
        ...(active !== undefined ? { active } : {}),
        kids: keys.map((key) => key.kid),
        actor: verified.clientId ?? verified.partition,
      });
      return ctx.response.json({
        app: verified.partition,
        active,
        keys: keys.map((key) => ({
          ...key.publicKey,
          active: key.active,
          registeredAt: key.createdAt,
          registeredBy: key.createdBy,
        })),
      });
    } catch (error) {
      this.options.logger?.debug?.(`[@adonis-agora/config] key registration refused: ${error}`);
      return ctx.response.status(400).send({ error: (error as Error).message });
    }
  }

  /**
   * Accepts ciphertext the app re-sealed to its active key. The control plane validates that every
   * entry was already sealed to this app and that the target `kid` is registered, then writes it
   * without opening it.
   */
  async postSealed(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    const scope = this.#scope(verified, ctx);
    const body = bodyOf(ctx) as { version?: unknown; entries?: unknown };
    if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) {
      return ctx.response.status(400).send({ error: 'version must be a positive integer' });
    }
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return ctx.response.status(400).send({ error: 'entries must be a non-empty array' });
    }
    const updates: TenantResealUpdate[] = [];
    for (const value of body.entries) {
      const entry = value as Partial<TenantResealUpdate>;
      if (
        typeof entry.key !== 'string' ||
        typeof entry.value !== 'string' ||
        typeof entry.kid !== 'string'
      ) {
        return ctx.response
          .status(400)
          .send({ error: 'each entry needs { key, value, kid } (all strings)' });
      }
      updates.push({ key: entry.key, value: entry.value, kid: entry.kid });
    }
    try {
      const result = await resealTenantEntries(this.options.store, scope, updates, {
        actor: verified.clientId ?? verified.partition,
        now: new Date().toISOString(),
        version: body.version,
      });
      if (result.changed) {
        this.bus.publish(scope, result.version);
        if (this.options.transport?.publish) {
          const document = await this.options.store.read(scope);
          if (document) {
            try {
              void Promise.resolve(
                this.options.transport.publish(
                  scope,
                  result.version,
                  maskDocument(document, false),
                ),
              ).catch(() => {});
            } catch {
              // Broker outage: the write stands; tenants still poll/SSE.
            }
          }
        }
        emitConfig('sealed.reseal', {
          app: scope.app,
          environment: scope.environment,
          label: scope.label,
          version: result.version,
          actor: verified.clientId ?? verified.partition,
          keys: result.keys,
        });
      }
      return ctx.response.json(result);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('stale re-seal')) {
        return ctx.response.status(409).send({ error: message });
      }
      this.options.logger?.debug?.(`[@adonis-agora/config] re-seal refused: ${message}`);
      return ctx.response.status(400).send({ error: message });
    }
  }

  /**
   * The key this tenant signs its browser tokens with, derived from the control plane's secret and
   * the token's scope: a tenant only ever gets the key of its own scope.
   */
  async postBrowserKey(ctx: HttpContext) {
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    const scope = this.#scope(verified, ctx);
    ctx.response.header('cache-control', 'no-store');
    return ctx.response.json({
      key: browserKeyOf(this.options.browser!.secret, scope),
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
    });
  }

  /** SSE: `event: config` on every change; closes when the token expires. */
  async stream(ctx: HttpContext) {
    const verified = await this.#authenticate(ctx, CONFIG_SCOPES.read);
    if (!verified) return;
    const scope = this.#scope(verified, ctx);
    const body = new PassThrough();
    const send = (chunk: string) => {
      if (!body.writableEnded) body.write(chunk);
    };
    let last = (await this.options.store.read(scope))?.fingerprint ?? '';
    const initial = (await this.options.store.read(scope))?.version ?? 0;
    send(`event: config\ndata: ${JSON.stringify({ version: initial, fingerprint: last })}\n\n`);

    const cleanups: Array<() => void> = [];
    const close = () => {
      for (const fn of cleanups.splice(0)) fn();
      if (!body.writableEnded) body.end();
    };
    const check = async () => {
      try {
        const document = await this.options.store.read(scope);
        const fingerprint = document?.fingerprint ?? '';
        if (fingerprint === last) return;
        last = fingerprint;
        send(
          `event: config\ndata: ${JSON.stringify({ version: document?.version ?? 0, fingerprint })}\n\n`,
        );
      } catch {
        // keep the stream; the tenant polls too
      }
    };
    cleanups.push(
      this.bus.subscribe((changed, version) => {
        if (
          changed.app === scope.app &&
          changed.environment === scope.environment &&
          changed.label === scope.label
        ) {
          last = '';
          send(`event: config\ndata: ${JSON.stringify({ version, fingerprint: last })}\n\n`);
        }
      }),
    );
    // Cross-replica fallback: another process may have written, and its bus is not ours.
    const poll = setInterval(() => void check(), 15_000);
    poll.unref();
    cleanups.push(() => clearInterval(poll));
    const heartbeat = setInterval(() => send(': ping\n\n'), 25_000);
    heartbeat.unref();
    cleanups.push(() => clearInterval(heartbeat));
    if (verified.expiresAt) {
      const expiry = setTimeout(close, Math.max(0, verified.expiresAt - Date.now()));
      expiry.unref();
      cleanups.push(() => clearTimeout(expiry));
    }
    ctx.request.request.once('close', close);

    ctx.response.header('content-type', 'text/event-stream');
    ctx.response.header('cache-control', 'no-cache, no-transform');
    ctx.response.header('x-accel-buffering', 'no');
    ctx.response.stream(body);
  }
}

/** Shield CSRF exceptions for the tenant API: server-to-server calls carry no cookie. */
export function configCsrfExceptions(url: string, options: { prefix?: string } = {}): boolean {
  const prefix = (options.prefix ?? '/_config').replace(/\/$/, '');
  const path = url.split('?')[0] ?? '';
  return path.startsWith(`${prefix}/v1/`);
}
