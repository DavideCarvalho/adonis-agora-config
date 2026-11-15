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
import { Textarea } from '../agora-kit/ui/textarea';
import type { Entry, EntryInput } from '../client/config-client';
import { useConsole } from './console-context';
import { editorText, exactTime, parseEditorText, preview, relativeTime } from './format';

function ValueCell({ entry }: { entry: Entry }) {
  if (entry.sealedTo !== undefined) {
    return (
      <span className="mono text-[11px] text-violet" title="Only this app's private key opens it">
        sealed for {entry.sealedTo.app}
      </span>
    );
  }
  if (entry.masked) {
    return <span className="mono text-[11px] text-faint">•••••• masked</span>;
  }
  if (entry.vault !== undefined) {
    return <span className="mono text-[11px] text-violet">{entry.vault}</span>;
  }
  return (
    <span className="mono text-[11px] text-dim" title={preview(entry.value, 2000)}>
      {preview(entry.value)}
    </span>
  );
}

const columns: Column<Entry>[] = [
  {
    id: 'key',
    header: 'Key',
    cell: (entry) => <span className="mono text-[11.5px] font-medium text-fg">{entry.key}</span>,
  },
  { id: 'value', header: 'Value', cell: (entry) => <ValueCell entry={entry} /> },
  {
    id: 'flags',
    header: 'Flags',
    hideBelow: 'sm',
    cell: (entry) => (
      <span className="flex flex-wrap gap-1">
        {entry.secret ? <Badge variant="warn">secret</Badge> : null}
        {entry.sealedTo !== undefined ? <Badge variant="info">sealed</Badge> : null}
        {entry.reloadable ? (
          <Badge variant="info">reloadable</Badge>
        ) : (
          <Badge variant="neutral">restart</Badge>
        )}
      </span>
    ),
  },
  {
    id: 'updated',
    header: 'Updated',
    hideBelow: 'md',
    cell: (entry) => (
      <span className="text-[11px] text-faint" title={exactTime(entry.updatedAt)}>
        {entry.updatedBy} · {relativeTime(entry.updatedAt)}
      </span>
    ),
  },
];

function EntryEditor({ entry, onClose }: { entry: Entry | 'new' | null; onClose: () => void }) {
  const { api, scope, meta } = useConsole();
  const queryClient = useQueryClient();
  const editing = entry !== 'new' && entry !== null ? entry : undefined;
  const [key, setKey] = useState(editing?.key ?? '');
  const [value, setValue] = useState(editing?.masked ? '' : editorText(editing?.value));
  const [vault, setVault] = useState(editing?.vault ?? '');
  const [secret, setSecret] = useState(editing?.secret ?? false);
  const [sealedTo, setSealedTo] = useState(editing?.sealedTo !== undefined);
  const [reloadable, setReloadable] = useState(editing?.reloadable ?? false);
  const [description, setDescription] = useState(editing?.description ?? '');
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['versions'] }),
      queryClient.invalidateQueries({ queryKey: ['audit'] }),
    ]);

  const save = useMutation({
    mutationFn: () => {
      const input: EntryInput = {
        secret,
        sealedTo,
        reloadable,
        ...(description.trim() !== ''
          ? { description: description.trim() }
          : { description: null }),
        ...(vault.trim() !== ''
          ? { vault: vault.trim(), value: undefined }
          : { value: parseEditorText(value) }),
        ...(message.trim() !== '' ? { message: message.trim() } : {}),
      };
      return api.set(scope, key.trim(), input);
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => api.unset(scope, key, message.trim() !== '' ? message.trim() : undefined),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const reveal = useMutation({
    mutationFn: () => api.reveal(scope, key),
    onSuccess: (revealed) => setValue(editorText(revealed.value)),
  });

  const error = (save.error ?? remove.error) as Error | null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{editing ? editing.key : 'New entry'}</DialogTitle>
          <DialogDescription>
            {scope.app} / {scope.environment} / {scope.label}. A reloadable key applies on a running
            tenant; the rest need a restart. A secret is encrypted at rest and served only with{' '}
            <span className="mono">config:secrets:read</span>. Sealing a value for the app means the
            control plane can never read it again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {editing ? null : (
            <label htmlFor="entry-key" className="grid gap-1 text-[11px] text-faint">
              Key (dot path)
              <Input
                id="entry-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="db.host"
                autoFocus
              />
            </label>
          )}

          <label htmlFor="entry-value" className="grid gap-1 text-[11px] text-faint">
            Value
            {editing?.sealedTo !== undefined ? (
              <div className="rounded-md border border-border px-2 py-1.5 text-[11px] text-faint">
                sealed for <span className="mono">{editing.sealedTo.app}</span> — only that app's
                private key opens it, so there is nothing to reveal here. Retype the value to
                replace it.
              </div>
            ) : editing?.masked ? (
              <div className="flex items-center gap-2">
                <span className="mono flex-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-faint">
                  masked — the server withheld this secret
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!meta.canRevealSecrets || reveal.isPending}
                  onClick={() => reveal.mutate()}
                >
                  Reveal
                </Button>
              </div>
            ) : null}
            <Textarea
              id="entry-value"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={4}
              placeholder={'3000 or {"a":1} or plain text'}
              className="mono text-[11.5px]"
            />
            <span className="text-[10px] text-faint">
              Valid JSON is stored as JSON; any other text as a string. A masked secret must be
              revealed (or retyped) before saving; remove an entry with the Delete button.
            </span>
          </label>

          <label htmlFor="entry-vault" className="grid gap-1 text-[11px] text-faint">
            Or a vault reference
            <Input
              id="entry-vault"
              value={vault}
              onChange={(event) => setVault(event.target.value)}
              placeholder="vault://aws/prod/shop#stripe_key"
              className="mono text-[11.5px]"
            />
          </label>

          <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-dim">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={secret}
                onChange={(event) => setSecret(event.target.checked)}
              />
              secret
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sealedTo}
                onChange={(event) => setSealedTo(event.target.checked)}
              />
              seal for {scope.app}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={reloadable}
                onChange={(event) => setReloadable(event.target.checked)}
              />
              reloadable
            </label>
          </div>

          <label htmlFor="entry-description" className="grid gap-1 text-[11px] text-faint">
            Description (optional)
            <Input
              id="entry-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <label htmlFor="entry-message" className="grid gap-1 text-[11px] text-faint">
            Why (recorded in the audit trail)
            <Input
              id="entry-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="tune the checkout timeout"
            />
          </label>

          {error ? <p className="text-[11px] text-bad">{error.message}</p> : null}
        </div>

        <DialogFooter className="gap-2">
          {editing ? (
            <Button
              variant={confirmDelete ? 'destructive' : 'ghost'}
              disabled={remove.isPending}
              onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}
            >
              {confirmDelete ? 'Really delete?' : 'Delete'}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            disabled={
              save.isPending || key.trim() === '' || (value.trim() === '' && vault.trim() === '')
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EntriesPage() {
  const { api, scope } = useConsole();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  const query = useQuery({
    queryKey: ['entries', scope, search, page],
    queryFn: () => api.entries(scope, { search, page, size: 50 }),
  });

  return (
    <>
      <PageHeader
        title="Entries"
        description="One flat document per app, environment and label. Every save is a new version."
        actions={
          <Button variant="brand" onClick={() => setEditing('new')}>
            New entry
          </Button>
        }
      />

      <Panel
        title="Configuration"
        description={`${query.data?.meta.total ?? 0} entries`}
        flush
        action={
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search keys…"
            className="h-8 w-52"
            aria-label="Search entries"
          />
        }
      >
        <QueryBoundary
          label="Entries"
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
              title={search ? 'No matching entries' : 'Nothing here yet'}
              description={
                search
                  ? 'Try a shorter search, or another app/environment in the topbar.'
                  : 'Create the first entry for this app, environment and label.'
              }
              action={
                <Button variant="brand" onClick={() => setEditing('new')}>
                  New entry
                </Button>
              }
            />
          }
        >
          {(data) => (
            <div className="p-2">
              <DataTable
                label="Configuration entries"
                columns={columns}
                rows={data.data}
                rowKey={(entry) => entry.key}
                onRowClick={(entry) => setEditing(entry)}
              />
              <Pager meta={data.meta} onPage={setPage} />
            </div>
          )}
        </QueryBoundary>
      </Panel>

      {editing ? <EntryEditor entry={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
