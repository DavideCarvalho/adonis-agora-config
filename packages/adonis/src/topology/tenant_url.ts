/**
 * Where a tenant finds its control plane: a fixed URL, or a lazy one resolved before the first
 * request (`controlPlaneUrl({ issuer, resource: 'urn:agora:config' })` from
 * `@adonis-agora/authkit-client`, read structurally: this package never imports it). A lazy URL
 * may carry `refresh()`, called when the control plane stops answering in case it moved.
 */
export type TenantUrlSource = string | ((() => Promise<string>) & { refresh?(): Promise<string> });

/** Whether `value` is a usable `tenant.url`: an absolute http(s) URL, or a function. */
export function isTenantUrlSource(value: unknown): value is TenantUrlSource {
  return typeof value === 'function' || (typeof value === 'string' && value !== '');
}

function normalize(url: unknown): string {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error(
      `config: tenant.url must resolve to an absolute http(s) URL (got ${JSON.stringify(url)})`,
    );
  }
  return url.replace(/\/$/, '');
}

/**
 * One tenant's control-plane URL, resolved at most once until {@link TenantUrl.refresh} is called.
 * Concurrent callers share one resolution; a failed resolution is retried on the next call.
 */
export class TenantUrl {
  #value: string | undefined;
  #pending: Promise<string> | undefined;

  constructor(private readonly source: TenantUrlSource) {
    if (typeof source === 'string') this.#value = normalize(source);
  }

  /** Whether the URL is resolved lazily (a function). */
  get lazy(): boolean {
    return typeof this.source === 'function';
  }

  /** The resolved URL, or `undefined` before a lazy one first resolves. */
  get current(): string | undefined {
    return this.#value;
  }

  /** The URL, resolving a lazy one on first use. */
  resolve(): Promise<string> {
    if (this.#value !== undefined) return Promise.resolve(this.#value);
    return this.#run(() => (this.source as () => Promise<string>)());
  }

  /**
   * Asks a lazy URL to look itself up again (its `refresh()` when it has one, else a plain call).
   * A fixed URL never changes. Returns whether the URL is now different.
   */
  async refresh(): Promise<boolean> {
    if (typeof this.source === 'string') return false;
    const source = this.source;
    const before = this.#value;
    try {
      await this.#run(() => (source.refresh ? source.refresh() : source()));
    } catch {
      return false;
    }
    return this.#value !== before;
  }

  #run(lookup: () => Promise<string>): Promise<string> {
    this.#pending ??= Promise.resolve()
      .then(lookup)
      .then((url) => {
        this.#value = normalize(url);
        return this.#value;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }
}
