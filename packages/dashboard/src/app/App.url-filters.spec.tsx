import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/config-client';
import { App } from './App';

const META: Meta = {
  apps: ['shop', 'billing'],
  environments: ['production', 'staging'],
  labels: ['default'],
  default: { app: 'shop', environment: 'production', label: 'default' },
  secrets: false,
  canRevealSecrets: false,
  topology: 'control-plane',
};

const originalFetch = globalThis.fetch;
let urls: string[] = [];

function page<T>(data: T[], currentPage = 1, lastPage = 3) {
  return {
    data,
    meta: { total: lastPage * 50, perPage: 50, currentPage, lastPage, firstPage: 1 },
  };
}

/** Three cursor pages of the trail: `c1` → page 2, `c2` → page 3 (the last). */
function auditPage(after: string | null) {
  const n = after === null ? 1 : Number(after.slice(1)) + 1;
  return {
    data: [
      {
        id: `audit-${n}`,
        app: 'shop',
        environment: 'production',
        label: 'main',
        actor: `actor-p${n}`,
        action: 'set',
        key: 'k',
        version: n,
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
    meta: {
      nextCursor: n < 3 ? `c${n}` : null,
      prevCursor: null,
      hasNext: n < 3,
      hasPrev: n > 1,
    },
  };
}

function entry(key: string) {
  return {
    key,
    value: 1,
    masked: false,
    secret: false,
    reloadable: false,
    updatedAt: '',
    updatedBy: 'a',
  };
}

beforeEach(() => {
  urls = [];
  const data = document.createElement('script');
  data.id = 'config-dashboard-config';
  data.type = 'application/json';
  data.textContent = JSON.stringify({ base: '/config', api: '/config/api' });
  document.body.appendChild(data);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const params = new URL(url, 'http://x').searchParams;
    const body = url.includes('/meta')
      ? META
      : url.includes('/entries')
        ? page([entry(`key-p${params.get('page')}`)], Number(params.get('page')))
        : url.includes('/audit')
          ? auditPage(params.get('after'))
          : page([]);
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

const lastEntriesQuery = () =>
  new URL(urls.filter((u) => u.includes('/entries')).at(-1) ?? '/', 'http://x').searchParams;

describe('the config console: view state in the URL', () => {
  it('opens on the scope, search and page a shared link names', async () => {
    window.history.replaceState(null, '', '/config#/entries?env=staging&q=db&page=2');
    renderApp();
    await screen.findByText('key-p2');
    const query = lastEntriesQuery();
    expect(query.get('environment')).toBe('staging');
    expect(query.get('search')).toBe('db');
    expect(query.get('page')).toBe('2');
    expect((screen.getByLabelText('env') as HTMLSelectElement).value).toBe('staging');
    expect((screen.getByLabelText('Search entries') as HTMLInputElement).value).toBe('db');
  });

  it('typing replaces and goes back to page 1; paging pushes and back returns', async () => {
    window.history.replaceState(null, '', '/config#/entries?page=2');
    renderApp();
    await screen.findByText('key-p2');
    const start = window.history.length;
    fireEvent.change(screen.getByLabelText('Search entries'), { target: { value: 'db' } });
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=db'));
    expect(window.history.length).toBe(start);
    await screen.findByText('key-p1');

    fireEvent.click(screen.getByLabelText('Next page'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=db&page=2'));
    expect(window.history.length).toBe(start + 1);
    await screen.findByText('key-p2');
    act(() => window.history.back());
    await screen.findByText('key-p1');
    expect(window.location.hash).toBe('#/entries?q=db');
  });

  it('the scope pick is in the URL, survives a page change, and the default leaves it', async () => {
    window.history.replaceState(null, '', '/config#/entries?q=db');
    renderApp();
    await screen.findByText('key-p1');
    fireEvent.change(screen.getByLabelText('env'), { target: { value: 'staging' } });
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=db&env=staging'));
    await waitFor(() => expect(lastEntriesQuery().get('environment')).toBe('staging'));

    // Another page keeps the scope and drops the entries search.
    fireEvent.click(screen.getByRole('link', { name: 'Audit' }));
    await waitFor(() => expect(window.location.hash).toBe('#/audit?env=staging'));
    await screen.findByRole('heading', { name: 'Audit' });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'reveal' } });
    await waitFor(() => expect(window.location.hash).toBe('#/audit?env=staging&action=reveal'));

    fireEvent.change(screen.getByLabelText('env'), { target: { value: 'production' } });
    await waitFor(() => expect(window.location.hash).toBe('#/audit?action=reveal'));
  });

  it('the audit walks by cursor: next pushes `after`, back pops it, an action resets it', async () => {
    window.history.replaceState(null, '', '/config#/audit');
    renderApp();
    await screen.findByText('actor-p1');
    const lastAudit = () =>
      new URL(urls.filter((u) => u.includes('/audit')).at(-1) ?? '/', 'http://x').searchParams;
    expect(lastAudit().get('first')).toBe('50');
    expect(lastAudit().get('page')).toBeNull();

    fireEvent.click(screen.getByLabelText('Next page'));
    await screen.findByText('actor-p2');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?after=c1'));
    fireEvent.click(screen.getByLabelText('Next page'));
    await screen.findByText('actor-p3');
    await waitFor(() => expect(window.location.hash).toBe('#/audit?after=c1,c2'));
    expect((screen.getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(true);

    act(() => window.history.back());
    await screen.findByText('actor-p2');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'reveal' } });
    await waitFor(() => expect(window.location.hash).toBe('#/audit?action=reveal'));
    expect(lastAudit().get('after')).toBeNull();
  });
});
