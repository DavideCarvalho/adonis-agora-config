/** Small presentation helpers shared by the pages. */

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "20 Nov 2026" in the viewer's locale; `—` when unknown. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function exactTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** `{"a":1}` → `{"a":1}`; long values are cut for a table cell. */
export function preview(value: unknown, max = 60): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** The editor's text for a value: strings verbatim, everything else pretty JSON. */
export function editorText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * What a person typed, read like the CLI reads it: valid JSON wins (`true`, `42`, `{"a":1}`), else
 * the text is a string. Leaving the field empty removes the value (a vault reference keeps its own
 * field).
 */
export function parseEditorText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}
