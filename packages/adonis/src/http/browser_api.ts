import { PassThrough } from 'node:stream';
import {
  type ConfigDocument,
  type ConfigScope,
  type ConfigValue,
  canonicalJson,
  isHiddenEntry,
} from '@adonis-agora/config-core';
import type { HttpContext } from '@adonisjs/core/http';
import { isBrowserKey } from '../browser.js';
import { verifyBrowserToken } from '../browser_token.js';
import type { ConfigStore } from '../store/store.js';
import type { ChangeBus } from './control_plane.js';

export interface BrowserApiOptions {
  store: ConfigStore;
  bus: ChangeBus;
  /** Signs the per-scope keys tenants mint browser tokens with. */
  secret: string;
  /** Origins whose pages may call the API. */
  corsOrigins: readonly string[];
  /** How long a scope's document is reused between reads (ms). Default 2000. */
  cacheMs?: number;
  /** How often an open stream checks for a change another replica wrote (ms). Default 15000. */
  pollMs?: number;
  logger?: { warn(message: string): void };
}

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
}

interface Subscriber {
  keys: readonly string[];
  last: string;
  send(version: number): void;
}

interface Watch {
  subscribers: Set<Subscriber>;
  stop: () => void;
}

const scopeId = (scope: ConfigScope) =>
  `${scope.app}\u0000${scope.environment}\u0000${scope.label}`;

/**
 * The values a browser may read from one document: entries marked `browser`, plus the keys the
 * tenant listed (carried in the token). Never a secret, vault or sealed entry.
 */
export function browserValuesOf(
  document: ConfigDocument | null,
  keys: readonly string[],
): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [key, entry] of Object.entries(document?.entries ?? {})) {
    if (entry.value === undefined || isHiddenEntry(entry)) continue;
    if (entry.browser !== true && !isBrowserKey(keys, key)) continue;
    out[key] = entry.value;
  }
  return out;
}

/**
 * The browser API of a control plane (`browser` in its config/config.ts), under
 * `<prefix>/v1/browser`:
 *
 * - `GET /v1/browser/values` — `{ version, values }` for the token's scope (`Authorization: Bearer`
 *   or `?token=`);
 * - `GET /v1/browser/stream?token=` — server-sent `config` events when those values change.
 *
 * Reads are shared: one document read per scope at most every `cacheMs`, and one watcher per scope
 * however many pages are open, so visitors never multiply the store's load.
 */
export class BrowserApi {
  readonly #cache = new Map<string, { at: number; document: Promise<ConfigDocument | null> }>();
  readonly #watches = new Map<string, Watch>();
  readonly #unsubscribe: () => void;

  constructor(private readonly options: BrowserApiOptions) {
    this.#unsubscribe = options.bus.subscribe((scope) => {
      this.#cache.delete(scopeId(scope));
      void this.#notify(scope);
    });
  }

  register(router: RouterLike, prefix: string): void {
    const base = `${prefix}/v1/browser`;
    router.get(`${base}/values`, (ctx) => this.values(ctx)).as('config.cp.browser.values');
    router.get(`${base}/stream`, (ctx) => this.stream(ctx)).as('config.cp.browser.stream');
    if (router.route) {
      for (const path of ['values', 'stream']) {
        router.route(`${base}/${path}`, ['OPTIONS'], (ctx) => this.preflight(ctx));
      }
    }
  }

  close(): void {
    this.#unsubscribe();
    for (const watch of this.#watches.values()) watch.stop();
    this.#watches.clear();
  }

  #read(scope: ConfigScope): Promise<ConfigDocument | null> {
    const id = scopeId(scope);
    const cached = this.#cache.get(id);
    if (cached && Date.now() - cached.at < (this.options.cacheMs ?? 2000)) return cached.document;
    const document = this.options.store.read(scope).catch((error: unknown) => {
      this.#cache.delete(id);
      throw error;
    });
    this.#cache.set(id, { at: Date.now(), document });
    return document;
  }

  #cors(ctx: HttpContext): void {
    const origin = ctx.request.header('origin');
    if (origin && this.options.corsOrigins.includes(origin)) {
      ctx.response.header('access-control-allow-origin', origin);
      ctx.response.header('vary', 'Origin');
    }
  }

  #verify(ctx: HttpContext) {
    const header = ctx.request.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const query = ctx.request.qs().token;
    return verifyBrowserToken(
      bearer ?? (typeof query === 'string' ? query : undefined),
      this.options.secret,
    );
  }

  async preflight(ctx: HttpContext) {
    this.#cors(ctx);
    ctx.response.header('access-control-allow-methods', 'GET, OPTIONS');
    ctx.response.header('access-control-allow-headers', 'authorization');
    ctx.response.header('access-control-max-age', '600');
    return ctx.response.status(204).send('');
  }

  async values(ctx: HttpContext) {
    this.#cors(ctx);
    ctx.response.header('cache-control', 'no-store');
    const verified = this.#verify(ctx);
    if (!verified) return ctx.response.status(401).send({ error: 'invalid or expired token' });
    const document = await this.#read(verified.scope);
    return ctx.response.json({
      version: document?.version ?? 0,
      values: browserValuesOf(document, verified.keys),
    });
  }

  /** SSE: `event: config` with `{ version }` when the values this token reads change. */
  async stream(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = this.#verify(ctx);
    if (!verified) return ctx.response.status(401).send({ error: 'invalid or expired token' });
    const body = new PassThrough();
    const write = (chunk: string) => {
      if (!body.writableEnded) body.write(chunk);
    };
    const document = await this.#read(verified.scope);
    const subscriber: Subscriber = {
      keys: verified.keys,
      last: canonicalJson(browserValuesOf(document, verified.keys)),
      send: (version) => write(`event: config\ndata: ${JSON.stringify({ version })}\n\n`),
    };
    // A first byte flushes the headers, so the page (and any proxy) knows the stream is open.
    write(': open\n\n');
    const leave = this.#join(verified.scope, subscriber);
    const heartbeat = setInterval(() => write(': ping\n\n'), 25_000);
    heartbeat.unref();
    // The token's expiry ends the stream: the page fetches a new token and reconnects.
    const expiry = setTimeout(close, Math.max(0, verified.expiresAt - Date.now()));
    expiry.unref();
    function close() {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      leave();
      if (!body.writableEnded) body.end();
    }
    ctx.request.request.once('close', close);
    ctx.response.header('content-type', 'text/event-stream');
    ctx.response.header('cache-control', 'no-cache, no-transform');
    ctx.response.header('x-accel-buffering', 'no');
    ctx.response.stream(body);
  }

  /** Adds a page to its scope's watcher, starting the watcher on the first one. */
  #join(scope: ConfigScope, subscriber: Subscriber): () => void {
    const id = scopeId(scope);
    let watch = this.#watches.get(id);
    if (!watch) {
      // Another replica's write never reaches this bus: one poll per scope catches it.
      const poll = setInterval(() => {
        this.#cache.delete(id);
        void this.#notify(scope);
      }, this.options.pollMs ?? 15_000);
      poll.unref();
      watch = { subscribers: new Set(), stop: () => clearInterval(poll) };
      this.#watches.set(id, watch);
    }
    watch.subscribers.add(subscriber);
    return () => {
      const current = this.#watches.get(id);
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size === 0) {
        current.stop();
        this.#watches.delete(id);
      }
    };
  }

  /** Tells the pages of a scope whose values changed; the rest hear nothing. */
  async #notify(scope: ConfigScope): Promise<void> {
    const watch = this.#watches.get(scopeId(scope));
    if (!watch) return;
    let document: ConfigDocument | null;
    try {
      document = await this.#read(scope);
    } catch (error) {
      this.options.logger?.warn(
        `[@adonis-agora/config] browser stream read failed: ${(error as Error).message}`,
      );
      return;
    }
    for (const subscriber of watch.subscribers) {
      const next = canonicalJson(browserValuesOf(document, subscriber.keys));
      if (next === subscriber.last) continue;
      subscriber.last = next;
      subscriber.send(document?.version ?? 0);
    }
  }
}
