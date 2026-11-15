import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigClient } from '../../src/client.js';

const entry = (value: unknown) => ({
  value,
  secret: false,
  reloadable: false,
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'ann',
  masked: false,
});

const document = {
  app: 'shop',
  environment: 'production',
  label: 'main',
  version: 1,
  fingerprint: 'abc',
  entries: { 'db.host': entry('localhost') },
  createdAt: new Date(0).toISOString(),
  createdBy: 'ann',
};

/** A `fetch` that behaves like the browser's: called with any `this` but the global, it throws. */
const strictFetch = function (
  this: unknown,
  _input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> {
  if (this !== globalThis) throw new TypeError('Illegal invocation');
  return Promise.resolve(
    new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
} as unknown as typeof fetch;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConfigClient fetch binding', () => {
  it('calls an injected fetch bound to the global object (no Illegal invocation)', async () => {
    const client = createConfigClient({
      url: 'https://config.test/_config',
      partition: 'shop',
      token: 'token',
      fetch: strictFetch,
    });
    await expect(client.load()).resolves.toMatchObject({ version: 1 });
  });

  it('calls the global fetch bound to the global object (no Illegal invocation)', async () => {
    vi.stubGlobal('fetch', strictFetch);
    const client = createConfigClient({
      url: 'https://config.test/_config',
      partition: 'shop',
      token: 'token',
    });
    await expect(client.load()).resolves.toMatchObject({ version: 1 });
  });
});
