import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ActivityIcon,
  AppShell,
  ClockIcon,
  ErrorBoundary,
  ListIcon,
  PageBody,
  readShellConfig,
} from '../agora-kit';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { ConfigApi, type Meta, readBootstrap, type Scope } from '../client/config-client';
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
  const value = (typeof window === 'undefined' ? '' : window.location.hash).replace(/^#\/?/, '');
  return value === 'history' || value === 'audit' ? value : 'entries';
}

function useRoute(): [Page, (page: Page) => void] {
  const [page, setPage] = useState<Page>(readPage);
  useEffect(() => {
    const onChange = () => setPage(readPage());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [
    page,
    (next) => {
      window.location.hash = `#/${next}`;
      setPage(next);
    },
  ];
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

function Select({
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
  return (
    <label className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
      {label}
      <select
        aria-label={label}
        className="h-7 rounded-md border border-border bg-panel-2 px-1.5 text-[11.5px] font-normal normal-case tracking-normal text-dim"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
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

export function App() {
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
  const [scope, setScope] = useState<Scope | null>(null);

  useEffect(() => {
    if (!meta.data || scope !== null) return;
    setScope({
      app: bootstrap?.app ?? meta.data.default.app,
      environment: bootstrap?.environment ?? meta.data.default.environment,
      label: bootstrap?.label ?? meta.data.default.label,
    });
  }, [meta.data, scope, bootstrap]);

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

  const environments = [...new Set([...meta.data.environments, scope.environment])];
  const labels = [...new Set([...meta.data.labels, scope.label])];
  const CurrentPage = PAGES[page];

  return (
    <ConsoleContext.Provider value={{ api, meta: meta.data, scope, setScope }}>
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
            <Select
              label="app"
              value={scope.app}
              options={[...new Set([...meta.data.apps, scope.app])]}
              onChange={(app) => setScope({ ...scope, app })}
            />
            <Select
              label="env"
              value={scope.environment}
              options={environments}
              onChange={(environment) => setScope({ ...scope, environment })}
            />
            <Select
              label="label"
              value={scope.label}
              options={labels}
              onChange={(label) => setScope({ ...scope, label })}
            />
          </>
        }
      >
        <PageBody>
          <ErrorBoundary label={CurrentPage.title} resetKeys={[page, scope]}>
            <CurrentPage.render />
          </ErrorBoundary>
        </PageBody>
      </AppShell>
    </ConsoleContext.Provider>
  );
}
