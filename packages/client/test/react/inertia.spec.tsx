// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConfig } from '../../src/react/index.js';
import { fakeTransmit } from './fake_transmit.js';

type Listener = (event: { detail: { page: { props: Record<string, unknown> } } }) => void;
const listeners = new Set<Listener>();
const reloads: unknown[] = [];

vi.mock('@inertiajs/react', () => ({
  router: {
    reload: (options: unknown) => reloads.push(options),
    on: (_type: string, listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));

const { InertiaConfigProvider } = await import('../../src/react/inertia.js');

afterEach(cleanup);

function Banner() {
  return <p>{String(useConfig('site.banner', 'none'))}</p>;
}

const respond = (props: Record<string, unknown>) =>
  act(() => {
    for (const listener of listeners) listener({ detail: { page: { props } } });
  });

describe('InertiaConfigProvider', () => {
  it('follows the config prop on every Inertia response', async () => {
    render(
      <InertiaConfigProvider initialPage={{ props: { config: { 'site.banner': 'old' } } }}>
        <Banner />
      </InertiaConfigProvider>,
    );
    expect(screen.getByText('old')).toBeTruthy();
    await respond({ config: { 'site.banner': 'new' } });
    expect(screen.getByText('new')).toBeTruthy();
    // A partial reload without the prop keeps the current values.
    await respond({ user: {} });
    expect(screen.getByText('new')).toBeTruthy();
  });

  it('reloads only the config prop when the server says a value changed', async () => {
    const { transmit, state } = fakeTransmit();
    const { unmount } = render(
      <InertiaConfigProvider initialPage={{ props: {} }} prop="settings" realtime={{ transmit }}>
        <Banner />
      </InertiaConfigProvider>,
    );
    await vi.waitFor(() => expect(state.deliver).toBeDefined());
    expect(state.channels).toEqual(['config/browser']);
    state.deliver!({ version: 4 });
    expect(reloads).toEqual([{ only: ['settings'] }]);
    unmount();
    expect(state.deliver).toBeUndefined();
    expect(listeners.size).toBe(0);
  });
});
