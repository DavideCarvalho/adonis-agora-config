/**
 * The console's wire client. Same-origin only, JSON, CSRF echoed from the XSRF-TOKEN cookie, and
 * the list envelopes follow `_1x/LIST-API-SPEC.md` (`{ data, meta }`).
 */

export interface Entry {
  key: string;
  value?: unknown;
  masked: boolean;
  /** The app this value is sealed to (`agora:pk1`); the control plane cannot open it. */
  sealedTo?: { app: string; kid: string };
  secret: boolean;
  reloadable: boolean;
  description?: string;
  vault?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface OffsetMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

export interface Page<T> {
  data: T[];
  meta: OffsetMeta;
}

export interface Version {
  version: number;
  createdAt: string;
  createdBy: string;
  message?: string;
  entries: number;
  secrets: number;
  fingerprint: string;
}

export interface AuditRow {
  id: string;
  actor: string;
  action: 'set' | 'unset' | 'rollback' | 'reveal';
  key?: string;
  version: number;
  message?: string;
  at: string;
  before?: { value?: unknown; secret?: boolean; reloadable?: boolean };
  after?: { value?: unknown; secret?: boolean; reloadable?: boolean };
}

export interface DiffRow {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  before?: Entry;
  after?: Entry;
}

export interface Scope {
  app: string;
  environment: string;
  label: string;
}

export interface Meta {
  apps: string[];
  environments: string[];
  labels: string[];
  default: Scope;
  /** Whether this deployment has a secrets key (secrets can be written). */
  secrets: boolean;
  /** Whether the viewer may read secret values (the entry is otherwise masked). */
  canRevealSecrets: boolean;
  topology: 'standalone' | 'control-plane' | 'tenant';
}

export interface EntryInput {
  value?: unknown;
  vault?: string;
  /** Seal the value to this app's registered public key (no reveal afterwards). */
  sealedTo?: boolean;
  secret?: boolean;
  reloadable?: boolean;
  description?: string | null;
  message?: string;
}

export interface ConsoleBootstrap extends Partial<Scope> {
  base: string;
  api: string;
  viewer?: { label: string; email?: string; role?: string };
  signOut?: { action: string; csrfToken?: string } | { href: string };
  switcher?: { endpoint: string; others: number };
  search?: { endpoint: string };
}

/** A response the console can show: the HTTP status and the API's own message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export class ConfigApi {
  readonly #fetcher: typeof fetch;

  constructor(
    readonly base: string,
    fetcher: typeof fetch = fetch,
  ) {
    // `fetch` lives on `window` in the browser and throws "Illegal invocation" when it is called
    // as a method of another object (which `this.#fetcher(...)` would do). Bind it once here.
    this.#fetcher = fetcher.bind(globalThis);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = csrfToken();
    if (token !== undefined && method !== 'GET') headers['x-xsrf-token'] = token;
    const response = await this.#fetcher(`${this.base}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      issues?: Array<{ path?: string; message?: string }>;
    };
    if (!response.ok) {
      const issues = payload.issues?.length
        ? `: ${payload.issues.map((i) => `${i.path ?? ''} ${i.message ?? ''}`.trim()).join('; ')}`
        : '';
      throw new ApiError(response.status, `${payload.error ?? response.statusText}${issues}`);
    }
    return payload as T;
  }

  #scope(scope: Scope): string {
    const query = new URLSearchParams({
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
    });
    return query.toString();
  }

  meta(): Promise<Meta> {
    return this.#request('GET', '/meta');
  }

  entries(
    scope: Scope,
    options: { search?: string; page?: number; size?: number; sort?: string } = {},
  ): Promise<Page<Entry>> {
    const query = new URLSearchParams({
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
      page: String(options.page ?? 1),
      size: String(options.size ?? 50),
      sort: options.sort ?? 'key',
    });
    if (options.search) query.set('search', options.search);
    return this.#request('GET', `/entries?${query}`);
  }

  entry(scope: Scope, key: string): Promise<Entry> {
    return this.#request('GET', `/entries/${encodeURIComponent(key)}?${this.#scope(scope)}`);
  }

  reveal(scope: Scope, key: string): Promise<Entry> {
    return this.#request(
      'POST',
      `/entries/${encodeURIComponent(key)}/reveal?${this.#scope(scope)}`,
      {},
    );
  }

  set(scope: Scope, key: string, input: EntryInput): Promise<{ entry: Entry; version: number }> {
    return this.#request('PUT', `/entries/${encodeURIComponent(key)}?${this.#scope(scope)}`, input);
  }

  unset(
    scope: Scope,
    key: string,
    message?: string,
  ): Promise<{ version: number; changed: boolean }> {
    return this.#request(
      'DELETE',
      `/entries/${encodeURIComponent(key)}?${this.#scope(scope)}`,
      message ? { message } : {},
    );
  }

  versions(scope: Scope, page = 1, size = 20): Promise<Page<Version>> {
    return this.#request(
      'GET',
      `/versions?${this.#scope(scope)}&page=${page}&size=${size}&sort=-version`,
    );
  }

  version(scope: Scope, version: number): Promise<{ version: Version; entries: Entry[] }> {
    return this.#request('GET', `/versions/${version}?${this.#scope(scope)}`);
  }

  diff(
    scope: Scope,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; rows: DiffRow[] }> {
    return this.#request('GET', `/diff?${this.#scope(scope)}&from=${from}&to=${to}`);
  }

  rollback(
    scope: Scope,
    to: number,
    message?: string,
  ): Promise<{ version: number; changed: boolean }> {
    return this.#request('POST', `/rollback?${this.#scope(scope)}`, {
      to,
      ...(message ? { message } : {}),
    });
  }

  audit(
    scope: Scope,
    options: { page?: number; size?: number; action?: string; key?: string } = {},
  ): Promise<Page<AuditRow>> {
    const query = new URLSearchParams({
      app: scope.app,
      environment: scope.environment,
      label: scope.label,
      page: String(options.page ?? 1),
      size: String(options.size ?? 50),
      sort: '-at',
    });
    if (options.action) query.set('filter[action]', options.action);
    if (options.key) query.set('filter[key]', options.key);
    return this.#request('GET', `/audit?${query}`);
  }
}

/** The JSON data block the control plane injects into `index.html`. */
export function readBootstrap(elementId = 'config-dashboard-config'): ConsoleBootstrap | null {
  if (typeof document === 'undefined') return null;
  const element = document.getElementById(elementId);
  if (element === null) return null;
  try {
    const parsed = JSON.parse(element.textContent ?? '') as Partial<ConsoleBootstrap>;
    if (typeof parsed.base !== 'string' || typeof parsed.api !== 'string') return null;
    return parsed as ConsoleBootstrap;
  } catch {
    return null;
  }
}
