import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/config-client';
import { App } from './App';

const META: Meta = {
  apps: ['shop'],
  environments: ['production'],
  labels: ['default'],
  default: { app: 'shop', environment: 'production', label: 'default' },
  secrets: true,
  canRevealSecrets: false,
  topology: 'control-plane',
};

const entry = (key: string, extra: Record<string, unknown>) => ({
  key,
  masked: false,
  secret: false,
  reloadable: true,
  updatedAt: '2026-11-18T16:30:00.000Z',
  updatedBy: 'ann',
  ...extra,
});

const ENTRIES = {
  data: [
    entry('site.banner', { value: 'hi' }),
    entry('site.title', { value: 'Shop', browser: true }),
    entry('stripe.key', { masked: true, secret: true }),
  ],
  meta: { total: 3, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
};

const originalFetch = globalThis.fetch;
const puts: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  puts.length = 0;
  const data = document.createElement('script');
  data.id = 'config-dashboard-config';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ base: '/config', api: '/config/api' });
  document.body.appendChild(data);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ version: 2, changed: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = url.includes('/meta')
      ? META
      : url.includes('/entries')
        ? ENTRIES
        : { data: [], meta: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.getElementById('config-dashboard-config')?.remove();
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState(null, '', '/config#/entries');
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const browserBox = () => screen.getByLabelText('browser') as HTMLInputElement;

describe('the browser mark in the config console', () => {
  it('badges marked entries in the list', async () => {
    renderApp();
    await screen.findByText('site.title');
    expect(screen.getAllByText('browser')).toHaveLength(1);
  });

  it('is off by default, and saving with it checked sends browser: true', async () => {
    renderApp();
    await act(async () => {
      fireEvent.click(await screen.findByText('site.banner'));
    });
    expect(browserBox().checked).toBe(false);
    fireEvent.click(browserBox());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.url).toContain('/entries/site.banner');
    expect(puts[0]!.body).toMatchObject({ browser: true });
  });

  it('cannot be checked on a secret', async () => {
    renderApp();
    await act(async () => {
      fireEvent.click(await screen.findByText('stripe.key'));
    });
    expect(browserBox().disabled).toBe(true);
    expect(browserBox().checked).toBe(false);
  });
});
