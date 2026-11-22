// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectConfigProvider, type EventSourceLike, useConfig } from '../../src/react/index.js';

afterEach(cleanup);

function Banner() {
  return <p>{String(useConfig('site.banner', 'none'))}</p>;
}

class FakeSource implements EventSourceLike {
  static opened: FakeSource[] = [];
  readonly listeners = new Map<string, () => void>();
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSource.opened.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DirectConfigProvider', () => {
  it('reads the control plane with a token from the app, and follows its stream', async () => {
    FakeSource.opened = [];
    let banner = 'old';
    let tokens = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/_config/browser-token') {
        tokens += 1;
        return json({
          token: `t${tokens}`,
          expiresAt: Date.now() + 60_000,
          url: 'https://hub.test/_config',
        });
      }
      expect(url).toBe('https://hub.test/_config/v1/browser/values');
      expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer t${tokens}`);
      return json({ version: 1, values: { 'site.banner': banner } });
    });
    const { unmount } = render(
      <DirectConfigProvider fetch={fetch as never} EventSource={FakeSource} retryMs={1}>
        <Banner />
      </DirectConfigProvider>,
    );
    expect(await screen.findByText('old')).toBeTruthy();
    await vi.waitFor(() => expect(FakeSource.opened).toHaveLength(1));
    expect(FakeSource.opened[0]!.url).toBe('https://hub.test/_config/v1/browser/stream?token=t1');

    banner = 'new';
    await act(async () => FakeSource.opened[0]!.listeners.get('config')!());
    expect(await screen.findByText('new')).toBeTruthy();

    // The stream drops (the token expired): a new token, a new stream.
    await act(async () => FakeSource.opened[0]!.onerror!({}));
    await vi.waitFor(() => expect(FakeSource.opened).toHaveLength(2));
    expect(FakeSource.opened[0]!.closed).toBe(true);
    expect(FakeSource.opened[1]!.url).toContain('token=t2');
    unmount();
    expect(FakeSource.opened[1]!.closed).toBe(true);
  });

  it('keeps the initial values when the app cannot mint a token', async () => {
    const fetch = vi.fn(async () => json({ error: 'config unavailable' }, 503));
    render(
      <DirectConfigProvider
        fetch={fetch as never}
        EventSource={FakeSource}
        initialValues={{ 'site.banner': 'server' }}
        live={false}
      >
        <Banner />
      </DirectConfigProvider>,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('server')).toBeTruthy();
  });
});
