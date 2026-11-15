import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState, PageHeader, Pager, Panel, QueryBoundary } from '../agora-kit';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../agora-kit/ui/dialog';
import { Input } from '../agora-kit/ui/input';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { DiffRow, Entry, Version } from '../client/config-client';
import { useConsole } from './console-context';
import { exactTime, preview, relativeTime } from './format';

function entryValue(entry: Entry | undefined): string {
  if (!entry) return '—';
  if (entry.masked) return '•••••• masked';
  if (entry.vault !== undefined) return entry.vault;
  return preview(entry.value, 80);
}

const versionColumns: Column<Version>[] = [
  {
    id: 'version',
    header: 'Version',
    cell: (version) => (
      <span className="mono tnum text-[11.5px] font-medium text-fg">v{version.version}</span>
    ),
  },
  {
    id: 'when',
    header: 'When',
    cell: (version) => (
      <span className="text-[11px] text-faint" title={exactTime(version.createdAt)}>
        {version.createdBy} · {relativeTime(version.createdAt)}
      </span>
    ),
  },
  {
    id: 'size',
    header: 'Size',
    hideBelow: 'sm',
    cell: (version) => (
      <span className="mono tnum text-[11px] text-dim">
        {version.entries} · {version.secrets} secret
      </span>
    ),
  },
  {
    id: 'message',
    header: 'Why',
    hideBelow: 'md',
    cell: (version) => <span className="text-[11px] text-faint">{version.message ?? '—'}</span>,
  },
];

const diffColumns: Column<DiffRow>[] = [
  {
    id: 'kind',
    header: 'Change',
    cell: (row) => (
      <Badge
        variant={row.kind === 'added' ? 'good' : row.kind === 'removed' ? 'destructive' : 'warn'}
      >
        {row.kind}
      </Badge>
    ),
  },
  {
    id: 'key',
    header: 'Key',
    cell: (row) => <span className="mono text-[11.5px] text-fg">{row.key}</span>,
  },
  {
    id: 'before',
    header: 'Before',
    cell: (row) => (
      <span className="mono text-[11px] text-faint line-through decoration-line-strong">
        {entryValue(row.before)}
      </span>
    ),
  },
  {
    id: 'after',
    header: 'After',
    cell: (row) => <span className="mono text-[11px] text-dim">{entryValue(row.after)}</span>,
  },
];

function RollbackDialog({ version, onClose }: { version: number; onClose: () => void }) {
  const { api, scope } = useConsole();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const rollback = useMutation({
    mutationFn: () => api.rollback(scope, version, message.trim() || undefined),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['entries'] }),
        queryClient.invalidateQueries({ queryKey: ['versions'] }),
        queryClient.invalidateQueries({ queryKey: ['version'] }),
        queryClient.invalidateQueries({ queryKey: ['diff'] }),
        queryClient.invalidateQueries({ queryKey: ['audit'] }),
      ]);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Roll back to v{version}?</DialogTitle>
          <DialogDescription>
            A rollback writes a <strong>new</strong> version whose entries are the ones from v
            {version}. History stays append-only and the audit says who did it.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="rollback-message" className="grid gap-1 text-[11px] text-faint">
          Why (recorded in the audit trail)
          <Input
            id="rollback-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        {rollback.error ? (
          <p className="text-[11px] text-bad">{(rollback.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={rollback.isPending}
            onClick={() => rollback.mutate()}
          >
            {rollback.isPending ? 'Rolling back…' : 'Roll back'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HistoryPage() {
  const { api, scope } = useConsole();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [diffFrom, setDiffFrom] = useState<number | null>(null);
  const [diffTo, setDiffTo] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState<number | null>(null);

  const versions = useQuery({
    queryKey: ['versions', scope, page],
    queryFn: () => api.versions(scope, page, 20),
  });
  const latest = versions.data?.data[0]?.version ?? null;
  const current = selected ?? latest;
  const detail = useQuery({
    queryKey: ['version', scope, current],
    queryFn: () => api.version(scope, current as number),
    enabled: current !== null,
  });
  const diff = useQuery({
    queryKey: ['diff', scope, diffFrom, diffTo],
    queryFn: () => api.diff(scope, diffFrom as number, diffTo as number),
    enabled: diffFrom !== null && diffTo !== null,
  });

  const entryColumns: Column<Entry>[] = [
    {
      id: 'key',
      header: 'Key',
      cell: (entry) => <span className="mono text-[11.5px] text-fg">{entry.key}</span>,
    },
    {
      id: 'value',
      header: 'Value',
      cell: (entry) => <span className="mono text-[11px] text-dim">{entryValue(entry)}</span>,
    },
    {
      id: 'flags',
      header: 'Flags',
      hideBelow: 'sm',
      cell: (entry) => (
        <span className="flex gap-1">
          {entry.secret ? <Badge variant="warn">secret</Badge> : null}
          {entry.reloadable ? <Badge variant="info">reloadable</Badge> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="History"
        description="Immutable versions of this scope. A rollback is a new version, never a deletion."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Versions"
          description={versions.data ? `${versions.data.meta.total} versions` : undefined}
          flush
        >
          <QueryBoundary
            label="Versions"
            query={versions}
            skeleton={
              <div className="grid gap-2 p-4">
                {['a', 'b', 'c', 'd', 'e'].map((id) => (
                  <Skeleton key={id} className="h-8 w-full" />
                ))}
              </div>
            }
            isEmpty={(data) => data.data.length === 0}
            empty={<EmptyState title="No versions yet" description="Write an entry first." />}
          >
            {(data) => (
              <div className="p-2">
                <DataTable
                  label="Versions"
                  columns={versionColumns}
                  rows={data.data}
                  rowKey={(version) => String(version.version)}
                  onRowClick={(version) => setSelected(version.version)}
                  rowClassName={(version) =>
                    version.version === current ? 'bg-brand-soft/60' : undefined
                  }
                />
                <Pager meta={data.meta} onPage={setPage} />
              </div>
            )}
          </QueryBoundary>
        </Panel>

        <Panel
          title={current === null ? 'Version' : `Version ${current}`}
          description={current !== null && current === latest ? 'current' : undefined}
          flush
          action={
            current !== null && current !== latest ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDiffFrom(current);
                    setDiffTo(latest);
                  }}
                  disabled={latest === null}
                >
                  Diff vs v{latest}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setRollingBack(current)}>
                  Roll back
                </Button>
              </div>
            ) : undefined
          }
        >
          <QueryBoundary
            label="Version"
            query={detail}
            skeleton={
              <div className="p-4">
                <Skeleton className="h-40 w-full" />
              </div>
            }
          >
            {(data) => (
              <div className="p-2">
                <div className="flex flex-wrap items-center gap-3 px-2 py-2 text-[11px] text-faint">
                  <span>{data.version.createdBy}</span>
                  <span>{exactTime(data.version.createdAt)}</span>
                  <span className="mono">{data.version.fingerprint}</span>
                  {data.version.message ? <span>“{data.version.message}”</span> : null}
                </div>
                <DataTable
                  label={`Entries at version ${data.version.version}`}
                  columns={entryColumns}
                  rows={data.entries}
                  rowKey={(entry) => entry.key}
                />
              </div>
            )}
          </QueryBoundary>
        </Panel>
      </div>

      <Panel
        title="Diff"
        description={
          diffFrom !== null && diffTo !== null ? `v${diffFrom} → v${diffTo}` : 'pick two versions'
        }
        flush
        action={
          <div className="flex items-center gap-2">
            <select
              aria-label="From version"
              className="h-8 rounded-md border border-border bg-panel-2 px-2 text-[11px] text-dim"
              value={diffFrom ?? ''}
              onChange={(event) =>
                setDiffFrom(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">from…</option>
              {(versions.data?.data ?? []).map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version}
                </option>
              ))}
            </select>
            <select
              aria-label="To version"
              className="h-8 rounded-md border border-border bg-panel-2 px-2 text-[11px] text-dim"
              value={diffTo ?? ''}
              onChange={(event) =>
                setDiffTo(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">to…</option>
              {(versions.data?.data ?? []).map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {diffFrom === null || diffTo === null ? (
          <EmptyState
            title="Pick two versions"
            description="The diff shows added, removed and changed keys, with secret values masked unless you may read them."
          />
        ) : (
          <QueryBoundary
            label="Diff"
            query={diff}
            skeleton={
              <div className="p-4">
                <Skeleton className="h-24 w-full" />
              </div>
            }
            isEmpty={(data) => data.rows.length === 0}
            empty={
              <EmptyState
                title="No changes"
                description="These versions hold the same configuration."
              />
            }
          >
            {(data) => (
              <div className="p-2">
                <DataTable
                  label="Version diff"
                  columns={diffColumns}
                  rows={data.rows}
                  rowKey={(row) => row.key}
                />
              </div>
            )}
          </QueryBoundary>
        )}
      </Panel>

      {rollingBack !== null ? (
        <RollbackDialog version={rollingBack} onClose={() => setRollingBack(null)} />
      ) : null}
    </>
  );
}
