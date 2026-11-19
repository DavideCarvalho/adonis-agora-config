import { useQuery } from '@tanstack/react-query';
import { parseAsString, useQueryStates } from 'nuqs';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIcon,
  AppModeBadge,
  AppShell,
  actionsUnavailableReason,
  ClockIcon,
  ComboSelect,
  ErrorBoundary,
  FederatedNotice,
  ListIcon,
  NuqsHashAdapter,
  PageBody,
  readShellConfig,
  splitHash,
  subscribeHashUrl,
} from '../agora-kit';
import { Skeleton } from '../agora-kit/ui/skeleton';
import {
  ConfigApi,
  type Meta,
  readBootstrap,
  type Scope,
  type ScopeLists,
} from '../client/config-client';
import { AuditPage } from './AuditPage';
import { ConsoleContext } from './console-context';
import { EntriesPage } from './EntriesPage';
import { HistoryPage } from './HistoryPage';

/** The console's one colour input (CONSOLE-SHELL-SPEC; violet is not used by another console). */
export const CONFIG_ACCENT = '#a78bfa';

type Page = 'entries' | 'history' | 'audit';

const PAGES: Record<Page, { title: string; render: () => ReactNode }> = {
  entries: { title: 'Entries', render: () => <EntriesPage /> },
  history: { title: 'History', render: () => <HistoryPage /> },
  audit: { title: 'Audit', render: () => <AuditPage /> },
};

function readPage(): Page {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const value = splitHash(hash).path.replace(/^\/?/, '');
  return value === 'history' || value === 'audit' ? value : 'entries';
}

/** The scope picked in the topbar (`?app=…&env=…&label=…` in the hash), kept across pages. */
const SCOPE_KEYS = ['app', 'env', 'label'] as const;

/**
 * The page is the hash's path (`#/history`); its view state (search, page, selected version) and
 * the topbar's scope ride in the hash's query, written by nuqs through the kit's
 * `NuqsHashAdapter`. Moving to another page keeps the scope and drops the old page's view state.
 */
function useRoute(): [Page, (page: Page) => void] {
  const [page, setPage] = useState<Page>(readPage);
  // Follows links, back/forward and query-only writes (which fire no `hashchange`).
  useEffect(() => subscribeHashUrl(() => setPage(readPage())), []);
  const go = useCallback((next: Page) => {
    const current = new URLSearchParams(splitHash(window.location.hash).search);
    const kept = new URLSearchParams();
    for (const key of SCOPE_KEYS) {
      const value = current.get(key);
      if (value !== null) kept.set(key, value);
    }
    const query = kept.toString();
    window.location.hash = query === '' ? `#/${next}` : `#/${next}?${query}`;
    setPage(next);
  }, []);
  return [page, go];
}

const scopeParams = {
  app: parseAsString.withOptions({ history: 'push' }),
  env: parseAsString.withOptions({ history: 'push' }),
  label: parseAsString.withOptions({ history: 'push' }),
};

/**
 * The scope every page reads: the URL's pick, else the bootstrap's / the server's default. Picking
 * the default again takes the param out of the URL, so a plain link still opens on the default.
 */
function useScope(defaults: Scope | null): [Scope | null, (scope: Scope) => void] {
  const [picked, setPicked] = useQueryStates(scopeParams);
  const scope = useMemo<Scope | null>(
    () =>
      defaults === null
        ? null
        : {
            app: picked.app ?? defaults.app,
            environment: picked.env ?? defaults.environment,
            label: picked.label ?? defaults.label,
          },
    [defaults, picked.app, picked.env, picked.label],
  );
  const setScope = useCallback(
    (next: Scope) => {
      if (defaults === null) return;
      void setPicked({
        app: next.app === defaults.app ? null : next.app,
        env: next.environment === defaults.environment ? null : next.environment,
        label: next.label === defaults.label ? null : next.label,
      });
    },
    [defaults, setPicked],
  );
  return [scope, setScope];
}

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </g>
      <g fill="currentColor">
        <circle cx="9" cy="7" r="1.8" />
        <circle cx="15" cy="12" r="1.8" />
        <circle cx="7" cy="17" r="1.8" />
      </g>
    </svg>
  );
}

/**
 * A topbar scope picker: a select with autocomplete over `/meta`'s list. `/meta` only lists scopes
 * that hold something, so a name outside it can be typed (to open a still-empty scope).
 */
function ScopePicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const id = `config-scope-${label}`;
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint"
    >
      {label}
      <ComboSelect
        id={id}
        aria-label={label}
        className="h-7 w-36 font-normal normal-case tracking-normal text-[11.5px]"
        options={options}
        value={value}
        creatable
        clearable={false}
        onValueChange={(next) => {
          const picked = next?.trim();
          if (picked && picked !== value) onChange(picked);
        }}
      />
    </label>
  );
}

function MetaScreen({ error }: { error: unknown }) {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : 0;
  const message =
    status === 401
      ? 'Your session ended. Sign in again to continue.'
      : status === 403
        ? 'Your account is not allowed to open this console.'
        : error instanceof Error
          ? error.message
          : 'The config server did not answer.';
  return (
    <div className="grid min-h-svh place-items-center bg-background p-8">
      <div className="agora-surface max-w-md rounded-lg border border-border p-6">
        <h1 className="text-sm font-bold text-fg">
          {status === 401 || status === 403 ? 'Not allowed' : 'The console could not load'}
        </h1>
        <p className="mt-2 text-xs text-faint">{message}</p>
      </div>
    </div>
  );
}

/**
 * The config console, wrapped in the kit's `NuqsHashAdapter`: the scope and each page's view state
 * live in the hash's query (`#/history?env=staging&version=12`), so a view is a link.
 */
export function App() {
  return (
    <NuqsHashAdapter>
      <Console />
    </NuqsHashAdapter>
  );
}

function Console() {
  const bootstrap = useMemo(() => readBootstrap(), []);
  const shell = useMemo(() => readShellConfig('config-dashboard-config'), []);
  const api = useMemo(() => (bootstrap ? new ConfigApi(bootstrap.api) : null), [bootstrap]);
  const [page, go] = useRoute();
  const meta = useQuery<Meta>({
    queryKey: ['meta'],
    queryFn: () => api!.meta(),
    enabled: api !== null,
    retry: false,
  });
  const defaults = useMemo<Scope | null>(
    () =>
      meta.data
        ? {
            app: bootstrap?.app ?? meta.data.default.app,
            environment: bootstrap?.environment ?? meta.data.default.environment,
            label: bootstrap?.label ?? meta.data.default.label,
          }
        : null,
    [meta.data, bootstrap],
  );
  const [scope, setScope] = useScope(defaults);
  const federated = meta.data?.federated?.find((app) => app.id === scope?.app);
  // Another app's environments and labels live in its own store.
  const federatedScopes = useQuery<ScopeLists>({
    queryKey: ['scopes', federated?.id],
    queryFn: () => api!.scopes(federated!.id),
    enabled: api !== null && federated !== undefined,
    retry: false,
  });

  if (bootstrap === null || api === null) {
    return (
      <div className="grid min-h-svh place-items-center bg-background p-8">
        <div className="max-w-md rounded-lg border border-border p-6 text-xs text-faint">
          This page is the config console, but it was served without its data block. Mount it with
          <span className="mono"> controlPlane.console </span> enabled.
        </div>
      </div>
    );
  }
  if (meta.error) return <MetaScreen error={meta.error} />;
  if (meta.data === undefined || scope === null) {
    return (
      <div className="grid min-h-svh gap-3 bg-background p-8">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const lists = federated ? federatedScopes.data : meta.data;
  const environments = [...new Set([...(lists?.environments ?? []), scope.environment])];
  const labels = [...new Set([...(lists?.labels ?? []), scope.label])];
  const CurrentPage = PAGES[page];
  const readOnly = federated ? actionsUnavailableReason(federated.label, federated) : undefined;
  const pickApp = (app: string) => {
    const target = meta.data?.federated?.find((candidate) => candidate.id === app);
    // A federated app opens on its own environment; coming back keeps the current one.
    setScope({ ...scope, app, environment: target?.environment ?? scope.environment });
  };

  return (
    <ConsoleContext.Provider value={{ api, meta: meta.data, scope, setScope, federated, readOnly }}>
      <AppShell
        brand={{
          name: 'config',
          subtitle: 'control plane',
          mark: <LogoMark />,
          current: { title: 'Configuration', package: '@adonis-agora/config', icon: 'generic' },
        }}
        nav={[
          {
            section: 'Configuration',
            items: [
              {
                id: 'entries',
                label: 'Entries',
                icon: <ListIcon />,
                href: '#/entries',
                onSelect: () => go('entries'),
              },
            ],
          },
          {
            section: 'Change',
            items: [
              {
                id: 'history',
                label: 'History',
                icon: <ClockIcon />,
                href: '#/history',
                onSelect: () => go('history'),
              },
              {
                id: 'audit',
                label: 'Audit',
                icon: <ActivityIcon />,
                href: '#/audit',
                onSelect: () => go('audit'),
              },
            ],
          },
        ]}
        activeId={page}
        shell={shell}
        title={CurrentPage.title}
        actions={
          <>
            <ScopePicker
              label="app"
              value={scope.app}
              options={[...new Set([...meta.data.apps, scope.app])]}
              onChange={pickApp}
            />
            {federated ? (
              <AppModeBadge
                appLabel={federated.label}
                mode={federated.mode}
                actions={federated.actions}
              />
            ) : null}
            <ScopePicker
              label="env"
              value={scope.environment}
              options={environments}
              onChange={(environment) => setScope({ ...scope, environment })}
            />
            <ScopePicker
              label="label"
              value={scope.label}
              options={labels}
              onChange={(label) => setScope({ ...scope, label })}
            />
          </>
        }
      >
        <PageBody>
          {federated ? (
            <FederatedNotice
              appLabel={federated.label}
              mode={federated.mode}
              actions={federated.actions}
              className="mb-3"
            />
          ) : null}
          <ErrorBoundary label={CurrentPage.title} resetKeys={[page, scope]}>
            <CurrentPage.render />
          </ErrorBoundary>
        </PageBody>
      </AppShell>
    </ConsoleContext.Provider>
  );
}
