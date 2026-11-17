import { useQuery } from '@tanstack/react-query';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { EmptyState, PageHeader, Pager, Panel, QueryBoundary } from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { AuditRow } from '../client/config-client';
import { useConsole } from './console-context';
import { exactTime, relativeTime } from './format';

const ACTION_TONE: Record<AuditRow['action'], 'good' | 'warn' | 'info' | 'violet'> = {
  set: 'good',
  unset: 'warn',
  rollback: 'violet',
  reveal: 'info',
};

const columns: Column<AuditRow>[] = [
  {
    id: 'at',
    header: 'When',
    cell: (row) => (
      <span className="text-[11px] text-faint" title={exactTime(row.at)}>
        {relativeTime(row.at)}
      </span>
    ),
  },
  {
    id: 'actor',
    header: 'Who',
    cell: (row) => <span className="text-[11.5px] text-fg">{row.actor}</span>,
  },
  {
    id: 'action',
    header: 'Action',
    cell: (row) => <Badge variant={ACTION_TONE[row.action]}>{row.action}</Badge>,
  },
  {
    id: 'key',
    header: 'Key',
    cell: (row) => <span className="mono text-[11px] text-dim">{row.key ?? '—'}</span>,
  },
  {
    id: 'version',
    header: 'Version',
    hideBelow: 'sm',
    cell: (row) => <span className="mono tnum text-[11px] text-faint">v{row.version}</span>,
  },
  {
    id: 'message',
    header: 'Why',
    hideBelow: 'md',
    cell: (row) => <span className="text-[11px] text-faint">{row.message ?? '—'}</span>,
  },
];

/** The audit trail's view, in the hash's query (`#/audit?action=reveal&page=2`). Both are explicit
 *  picks, so each adds a history entry; a new action goes back to page 1. */
export const auditParams = {
  page: parseAsInteger.withDefault(1),
  action: parseAsString.withDefault(''),
};

export function AuditPage() {
  const { api, scope } = useConsole();
  const [{ page, action }, setView] = useQueryStates(auditParams, { history: 'push' });
  const setPage = (next: number) => void setView({ page: next });
  const query = useQuery({
    queryKey: ['audit', scope, page, action],
    queryFn: () => api.audit(scope, { page, size: 50, ...(action ? { action } : {}) }),
  });

  return (
    <>
      <PageHeader
        title="Audit"
        description="Who changed what, when, and why. A reveal row records who read a secret."
      />
      <Panel
        title="Changes"
        description={query.data ? `${query.data.meta.total} rows` : undefined}
        flush
        action={
          <select
            aria-label="Action"
            className="h-8 rounded-md border border-border bg-panel-2 px-2 text-[11px] text-dim"
            value={action}
            onChange={(event) => void setView({ action: event.target.value, page: null })}
          >
            <option value="">every action</option>
            <option value="set">set</option>
            <option value="unset">unset</option>
            <option value="rollback">rollback</option>
            <option value="reveal">reveal</option>
          </select>
        }
      >
        <QueryBoundary
          label="Audit"
          query={query}
          skeleton={
            <div className="grid gap-2 p-4">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((id) => (
                <Skeleton key={id} className="h-8 w-full" />
              ))}
            </div>
          }
          isEmpty={(data) => data.data.length === 0}
          empty={
            <EmptyState
              title="Nothing recorded yet"
              description="Changes to this scope show up here."
            />
          }
        >
          {(data) => (
            <div className="p-2">
              <DataTable
                label="Audit trail"
                columns={columns}
                rows={data.data}
                rowKey={(row) => row.id}
              />
              <Pager meta={data.meta} onPage={setPage} />
            </div>
          )}
        </QueryBoundary>
      </Panel>
    </>
  );
}
