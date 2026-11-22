import type { ConfigDiffRow, ConfigDocumentView, ConfigEntryView } from './types.js';

function view(entry: ConfigEntryView): ConfigEntryView {
  return { ...entry, masked: entry.masked === true };
}

function sameValue(a: ConfigEntryView, b: ConfigEntryView): boolean {
  if (a.masked || b.masked) return a.masked === b.masked;
  return JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null);
}

function sameFlags(a: ConfigEntryView, b: ConfigEntryView): boolean {
  return (
    a.secret === b.secret &&
    a.reloadable === b.reloadable &&
    (a.browser === true) === (b.browser === true) &&
    (a.description ?? '') === (b.description ?? '') &&
    (a.vault ?? '') === (b.vault ?? '')
  );
}

/**
 * The changes between two versions of the same scope, key by key. Secret values the reader may not
 * read arrive masked; an untouched masked value is not reported as a change.
 */
export function diffDocuments(from: ConfigDocumentView, to: ConfigDocumentView): ConfigDiffRow[] {
  const keys = new Set([...Object.keys(from.entries), ...Object.keys(to.entries)]);
  const rows: ConfigDiffRow[] = [];
  for (const key of [...keys].sort()) {
    const before = from.entries[key];
    const after = to.entries[key];
    if (before === undefined && after !== undefined) {
      rows.push({ key, kind: 'added', after: view(after) });
    } else if (before !== undefined && after === undefined) {
      rows.push({ key, kind: 'removed', before: view(before) });
    } else if (before !== undefined && after !== undefined) {
      if (sameValue(before, after) && sameFlags(before, after)) continue;
      rows.push({ key, kind: 'changed', before: view(before), after: view(after) });
    }
  }
  return rows;
}

/** A one-line summary of a diff (`+2 ~1 -0`), for lists and the CLI. */
export function diffSummary(rows: readonly ConfigDiffRow[]): string {
  const count = (kind: ConfigDiffRow['kind']) => rows.filter((row) => row.kind === kind).length;
  return `+${count('added')} ~${count('changed')} -${count('removed')}`;
}
