import { useQuery } from '@tanstack/react-query';
import { parseAsArrayOf, parseAsString, useQueryStates } from 'nuqs';
import { EmptyState, PageHeader, Panel, QueryBoundary } from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { AuditRow } from '../client/config-client';
import { useConsole } from './console-context';
import { CursorPager, useCursorPager } from './cursor-pager';
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

/** The audit trail's view, in the hash's query (`#/audit?action=reveal&after=…`). Both are explicit
 *  picks, so each adds a history entry; a new action goes back to the first page. Pages walk by
 *  cursor, so the trail shows no total. */
export const auditParams = {
  action: parseAsString.withDefault(''),
  /** The cursor stack {@link useCursorPager} keeps; listed so an action change can clear it. */
  after: parseAsArrayOf(parseAsString),
};

export function AuditPage() {
  const { api, scope } = useConsole();
  const [{ action }, setView] = useQueryStates(auditParams, { history: 'push' });
  const pager = useCursorPager();
  const after = pager.after;
  const query = useQuery({
    queryKey: ['audit', scope, after, action],
    queryFn: () =>
      api.audit(scope, { size: 50, ...(after ? { after } : {}), ...(action ? { action } : {}) }),
  });

  return (
    <>
      <PageHeader
        title="Audit"
        description="Who changed what, when, and why. A reveal row records who read a secret."
      />
      <Panel
        title="Changes"
        description={query.data ? `page ${pager.page}` : undefined}
        flush
        action={
          <select
            aria-label="Action"
            className="h-8 rounded-md border border-border bg-panel-2 px-2 text-[11px] text-dim"
            value={action}
            onChange={(event) => void setView({ action: event.target.value, after: null })}
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
              <CursorPager
                meta={data.meta}
                page={pager.page}
                onNext={() => pager.next(data.meta.nextCursor)}
                onPrevious={pager.previous}
              />
            </div>
          )}
        </QueryBoundary>
      </Panel>
    </>
  );
}
