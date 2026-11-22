// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigProvider, RemoteConfigProvider, useConfig } from '../../src/react/index.js';
import { fakeTransmit } from './fake_transmit.js';

afterEach(cleanup);

function Banner() {
  return <p>{String(useConfig('site.banner', 'none'))}</p>;
}

describe('useConfig', () => {
  it('reads a value by key, with a fallback for a key the server did not send', () => {
    render(
      <ConfigProvider values={{ 'site.banner': 'Manutenção às 22h' }}>
        <Banner />
      </ConfigProvider>,
    );
    expect(screen.getByText('Manutenção às 22h')).toBeTruthy();
    cleanup();
    render(
      <ConfigProvider values={{}}>
        <Banner />
      </ConfigProvider>,
    );
    expect(screen.getByText('none')).toBeTruthy();
  });
});

describe('RemoteConfigProvider', () => {
  it('loads the browser route, and again when the server says a value changed', async () => {
    let banner = 'old';
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: 1, values: { 'site.banner': banner } }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { transmit, state } = fakeTransmit();
    render(
      <RemoteConfigProvider
        url="/_config/browser"
        fetch={fetch as never}
        realtime={{ transmit, channel: 'shop/config' }}
      >
        <Banner />
      </RemoteConfigProvider>,
    );
    expect(await screen.findByText('old')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/_config/browser', expect.anything());
    await vi.waitFor(() => expect(state.deliver).toBeDefined());
    expect(state.channels).toEqual(['shop/config']);

    banner = 'new';
    await act(async () => state.deliver!({ version: 2 }));
    expect(await screen.findByText('new')).toBeTruthy();
  });

  it('keeps the current values when a request fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'));
    const { transmit, state } = fakeTransmit();
    render(
      <RemoteConfigProvider
        url="/_config/browser"
        initialValues={{ 'site.banner': 'server-rendered' }}
        fetch={fetch as never}
        realtime={{ transmit }}
      >
        <Banner />
      </RemoteConfigProvider>,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.deliver).toBeDefined());
    expect(state.channels).toEqual(['config/browser']);
    await act(async () => state.deliver!({ version: 2 }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('server-rendered')).toBeTruthy();
  });
});
