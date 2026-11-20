import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/config-client';
import { App } from './App';
import { exactTime, shortDate } from './format';

const CREATED = '2026-01-05T10:00:00.000Z';
const UPDATED = '2026-11-18T16:30:00.000Z';

const META: Meta = {
  apps: ['shop'],
  environments: ['production'],
  labels: ['default'],
  default: { app: 'shop', environment: 'production', label: 'default' },
  secrets: false,
  canRevealSecrets: false,
  topology: 'control-plane',
};

const ENTRIES = {
  data: [
    {
      key: 'db.host',
      value: 'pg',
      masked: false,
      secret: false,
      reloadable: false,
      createdAt: CREATED,
      updatedAt: UPDATED,
      updatedBy: 'ann',
    },
    {
      key: 'legacy',
      value: 1,
      masked: false,
      secret: false,
      reloadable: false,
      createdAt: null,
      updatedAt: UPDATED,
      updatedBy: 'bob',
    },
  ],
  meta: { total: 2, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
  document: { version: 7, createdAt: CREATED, updatedAt: UPDATED },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  const data = document.createElement('script');
  data.id = 'config-dashboard-config';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ base: '/config', api: '/config/api' });
  document.body.appendChild(data);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/meta')
      ? META
      : url.includes('/entries')
        ? ENTRIES
        : { data: [], meta: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.getElementById('config-dashboard-config')?.remove();
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe('dates in the config console', () => {
  it('formats a short date, and a dash when unknown', () => {
    expect(shortDate(null)).toBe('—');
    expect(shortDate('nope')).toBe('—');
    expect(shortDate(CREATED)).toBe(
      new Date(CREATED).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    );
  });

  it("shows the current document's version and dates over the entry list", async () => {
    window.history.replaceState(null, '', '/config#/entries');
    renderApp();
    await screen.findByText('db.host');
    expect(
      screen.getByText(
        `2 entries · v7 · created ${shortDate(CREATED)} · updated ${shortDate(UPDATED)}`,
      ),
    ).toBeTruthy();
  });

  it('shows created and updated on the entry detail, a dash when unknown', async () => {
    window.history.replaceState(null, '', '/config#/entries');
    renderApp();
    await act(async () => {
      fireEvent.click(await screen.findByText('db.host'));
    });
    const stamps = await screen.findByTestId('entry-stamps');
    expect(stamps.textContent).toContain(`Created ${shortDate(CREATED)}`);
    expect(stamps.textContent).toContain(`Updated ${shortDate(UPDATED)} by ann`);
    expect(screen.getByText(shortDate(CREATED)).getAttribute('title')).toBe(exactTime(CREATED));
  });

  it('shows a dash for an entry written before createdAt was kept', async () => {
    window.history.replaceState(null, '', '/config#/entries');
    renderApp();
    await act(async () => {
      fireEvent.click(await screen.findByText('legacy'));
    });
    expect((await screen.findByTestId('entry-stamps')).textContent).toContain('Created —');
  });
});
