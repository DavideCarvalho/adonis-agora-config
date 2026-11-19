import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta } from '../client/config-client';
import { App } from './App';

const META: Meta = {
  apps: ['eduliberta', 'et', 'ro'],
  federated: [
    { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app', environment: 'prod' },
    { id: 'ro', label: 'Read Only', mode: 'federated', actions: 'none' },
  ],
  environments: ['production'],
  labels: ['main'],
  default: { app: 'eduliberta', environment: 'production', label: 'main' },
  secrets: true,
  canRevealSecrets: true,
  topology: 'control-plane',
};

const originalFetch = globalThis.fetch;
let urls: string[] = [];

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
    const body = url.includes('/meta')
      ? META
      : url.includes('/scopes')
        ? {
            environments: ['prod', 'staging-et'],
            labels: ['main'],
            default: { environment: 'prod', label: 'main' },
          }
        : {
            data: [],
            meta: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
          };
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

async function pickApp(text: string, option: string) {
  const input = screen.getByRole('combobox', { name: 'app' });
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: text } });
    await new Promise((r) => setTimeout(r, 20));
  });
  const item = await screen.findByRole('option', { name: option });
  await act(async () => {
    fireEvent.click(item);
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('the federated config console', () => {
  it('a federated app opens on its own environment, with its badge and notice', async () => {
    window.history.replaceState(null, '', '/config#/entries');
    renderApp();
    await screen.findByRole('heading', { name: 'Entries' });
    expect(document.querySelector('[data-federated-notice]')).toBeNull();

    await pickApp('et', 'et');
    await waitFor(() => expect(window.location.hash).toBe('#/entries?app=et&env=prod'));
    await waitFor(() =>
      expect(document.querySelector('[data-app-mode="federated"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-federated-notice]')?.textContent).toMatch(
      /Entre Textos's own store.*sent to Entre Textos/,
    );
    // Its environments come from its own store.
    await waitFor(() => expect(urls.some((u) => u.includes('/scopes?app=et'))).toBe(true));
    const buttons = screen.getAllByRole('button', { name: 'New entry' }) as HTMLButtonElement[];
    expect(buttons.some((button) => button.disabled)).toBe(false);
  });

  it('a read-only federated app disables the changes', async () => {
    window.history.replaceState(null, '', '/config#/entries?app=ro');
    renderApp();
    await screen.findByRole('heading', { name: 'Entries' });
    await waitFor(() => expect(document.querySelector('[data-federated-notice]')).not.toBeNull());
    const buttons = screen.getAllByRole('button', { name: 'New entry' }) as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.title).toMatch(/read-only here/);
  });
});
