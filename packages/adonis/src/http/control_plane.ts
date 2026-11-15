import { PassThrough } from 'node:stream';
import {
  CONFIG_RESOURCE,
  CONFIG_SCOPES,
  type ConfigDocument,
  type ConfigDocumentView,
  type ConfigEntryView,
  type ConfigScope,
  DEFAULT_LABEL,
  etagMatches,
  etagOf,
  fingerprintOf,
  maskDocument,
  parseVaultReference,
} from '@adonis-agora/config-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { VaultResolver } from '../define_config.js';
import type { ConfigStore } from '../store/store.js';
import {
  bearerToken,
  normalizeVerifiedTenant,
  requestHeaders,
  type TenantVerifier,
  type VerifiedTenant,
} from '../topology/verify.js';

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  any?(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
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

  constructor(private readonly options: ControlPlaneOptions) {
    this.prefix = (options.prefix ?? '/_config').replace(/\/$/, '');
    this.bus = options.bus ?? new ChangeBus();
  }

  register(router: RouterLike): void {
    const p = this.prefix;
    router.get(`${p}/v1/config`, (ctx) => this.getConfig(ctx)).as('config.cp.config');
    router.get(`${p}/v1/config/stream`, (ctx) => this.stream(ctx)).as('config.cp.stream');
    router.get(`${p}/v1/whoami`, (ctx) => this.whoami(ctx)).as('config.cp.whoami');
    if (this.options.corsOrigins?.length && router.route) {
      router.route(`${p}/v1/config`, ['OPTIONS'], (ctx) => this.preflight(ctx));
      router.route(`${p}/v1/config/stream`, ['OPTIONS'], (ctx) => this.preflight(ctx));
      router.route(`${p}/v1/whoami`, ['OPTIONS'], (ctx) => this.preflight(ctx));
    }
  }

  async #authenticate(ctx: HttpContext, required: string): Promise<VerifiedTenant | null> {
    const headers = requestHeaders(ctx);
    const verified = normalizeVerifiedTenant(
      await this.options.verifyTenant({
        token: bearerToken(ctx),
        app: ctx.request.header('x-config-app') ?? undefined,
        environment: ctx.request.header('x-config-environment') ?? undefined,
        label: ctx.request.header('x-config-label') ?? undefined,
        headers,
      }),
    );
    if (!verified) {
      ctx.response.status(401).send({ error: 'unauthorized' });
      return null;
    }
    if (!verified.capabilities.includes(required)) {
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
    const view = maskDocument(document, canReadSecrets);
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
    const canReadSecrets = verified.capabilities.includes(CONFIG_SCOPES.secretsRead);
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
    ctx.response.header('access-control-allow-methods', 'GET, OPTIONS');
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
