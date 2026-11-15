import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConfigApi, readBootstrap } from './config-client';

/**
 * A `fetch` that behaves like the browser's: it is a method of `window`, so calling it with any
 * other `this` throws "Illegal invocation". The console used to do exactly that.
 */
const strictFetch = function (
  this: unknown,
  _input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> {
  if (this !== globalThis) throw new TypeError('Illegal invocation');
  return Promise.resolve(response({ data: [], meta: { total: 0 } }));
} as unknown as typeof fetch;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const scope = { app: 'shop', environment: 'production', label: 'main' };

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  // biome-ignore lint/suspicious/noDocumentCookie: the console reads the CSRF cookie by design
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('readBootstrap', () => {
  it('reads the injected data block and refuses a missing one', () => {
    document.body.innerHTML =
      '<script type="application/json" id="config-dashboard-config">{"base":"/_config","api":"/_config/api","app":"shop"}</script>';
    expect(readBootstrap()).toMatchObject({ base: '/_config', api: '/_config/api', app: 'shop' });
    document.body.innerHTML = '';
    expect(readBootstrap()).toBeNull();
  });
});

describe('ConfigApi', () => {
  it('lists entries with the list envelope and its query', async () => {
    const fetcher = vi.fn(async () => response({ data: [{ key: 'a' }], meta: { total: 1 } }));
    const api = new ConfigApi('/_config/api', fetcher as unknown as typeof fetch);
    const page = await api.entries(scope, { search: 'a', page: 2, size: 10 });
    expect(page.data).toEqual([{ key: 'a' }]);
    const url = String((fetcher.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/entries?');
    expect(url).toContain('app=shop');
    expect(url).toContain('page=2');
    expect(url).toContain('search=a');
  });

  it('sets an entry with a JSON body and echoes the CSRF token', async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the console reads the CSRF cookie by design
    document.cookie = 'XSRF-TOKEN=token-123';
    const fetcher = vi.fn(async () => response({ entry: { key: 'a' }, version: 2 }));
    const api = new ConfigApi('/_config/api', fetcher as unknown as typeof fetch);
    await api.set(scope, 'a', { value: 1, reloadable: true });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/entries/a?');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ value: 1, reloadable: true });
    expect((init.headers as Record<string, string>)['x-xsrf-token']).toBe('token-123');
  });

  it('sends filter fields for audit and version sorting for history', async () => {
    const fetcher = vi.fn(async () => response({ data: [], meta: { total: 0 } }));
    const api = new ConfigApi('/_config/api', fetcher as unknown as typeof fetch);
    await api.audit(scope, { page: 1, size: 10, action: 'reveal', key: 'p' });
    const auditUrl = String((fetcher.mock.calls[0] as unknown[])[0]);
    expect(auditUrl).toContain('filter%5Baction%5D=reveal');
    expect(auditUrl).toContain('filter%5Bkey%5D=p');
    await api.versions(scope, 1, 20);
    expect(String((fetcher.mock.calls[1] as unknown[])[0])).toContain('sort=-version');
  });

  it('calls the global fetch bound to the window (no Illegal invocation)', async () => {
    vi.stubGlobal('fetch', strictFetch);
    const api = new ConfigApi('/_config/api');
    await expect(api.entries(scope)).resolves.toMatchObject({ data: [] });
  });

  it('calls an injected fetch bound to the window (no Illegal invocation)', async () => {
    const api = new ConfigApi('/_config/api', strictFetch);
    await expect(api.meta()).resolves.toBeDefined();
  });

  it('turns a refusal into an ApiError with the server message', async () => {
    const fetcher = vi.fn(async () =>
      response({ error: 'forbidden', issues: [{ path: 'value', message: 'invalid' }] }, 403),
    );
    const api = new ConfigApi('/_config/api', fetcher as unknown as typeof fetch);
    await expect(api.meta()).rejects.toMatchObject({
      status: 403,
      message: 'forbidden: value invalid',
    });
    await expect(api.meta()).rejects.toBeInstanceOf(ApiError);
  });
});
