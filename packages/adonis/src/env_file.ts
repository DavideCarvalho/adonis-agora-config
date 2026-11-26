const START = '# config:start';
const END = '# config:end';
const SAIL_START = '# sail:start';
const BLOCK = /(^|\n)# config:start\n[\s\S]*?\n# config:end(\n|$)/;

/** Keys the file already declares at column 0 (`KEY=`), outside our managed block. */
function declaredKeys(content: string): Set<string> {
  const withoutBlock = content.replace(BLOCK, '\n');
  const keys = new Set<string>();
  for (const line of withoutBlock.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

/** What an environment variable name may look like (`DB_HOST`, `_PRIVATE`). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `value` as one POSIX shell word: unchanged when it holds only characters a shell never
 * interprets, single-quoted otherwise. `KEY=<this>` is then safe to `eval` (no `$(…)`, `;`, or a
 * newline starting a new command).
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `value` for a dotenv line, or `undefined` when it cannot be written safely. A newline would end
 * the line and let the value declare other variables (`NODE_OPTIONS`, `APP_KEY`); `$` is escaped so
 * AdonisJS' env parser does not interpolate another variable into it.
 */
export function dotenvValue(value: string): string | undefined {
  if (/[\r\n\0]/.test(value)) return undefined;
  return value.replaceAll('$', '\\$');
}

/** A dotenv file holding varlock ciphertext: appending plaintext next to it would corrupt it. */
export function hasEncryptedValues(content: string): boolean {
  return content.includes('varlock(');
}

export interface ManagedEnvResult {
  content: string;
  /** Keys written into the managed block. */
  added: string[];
  /** Keys skipped because the file already sets them (a real env var or `.env.local` wins). */
  skipped: string[];
  /** Keys not written: an invalid variable name, or a value with a line break. */
  rejected: string[];
}

/**
 * Inserts/replaces the `# config:start` … `# config:end` block. A key the file already declares
 * outside the block is skipped: that is the same precedence the app applies at runtime, and it is
 * what keeps a Sail worktree on its own ports (its `# sail:start` block wins). The block is placed
 * before Sail's block when there is one, so even a reader that takes the last assignment agrees.
 */
export function upsertConfigBlock(
  existing: string,
  values: Record<string, string>,
  options: { note?: string } = {},
): ManagedEnvResult {
  const present = declaredKeys(existing);
  const added: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (present.has(key)) {
      skipped.push(key);
      continue;
    }
    const safe = ENV_NAME.test(key) ? dotenvValue(value) : undefined;
    if (safe === undefined) {
      rejected.push(key);
      continue;
    }
    added.push(key);
    lines.push(`${key}=${safe}`);
  }

  const block =
    added.length === 0
      ? ''
      : [
          START,
          '# Managed by @adonis-agora/config (`node ace config:pull`). Re-run to refresh.',
          `# Keys already set outside this block are left alone${options.note ? ` (${options.note})` : ''}.`,
          ...lines,
          END,
        ].join('\n');

  const withoutBlock = existing
    .replace(BLOCK, '$1')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
  let content: string;
  if (block === '') {
    content = withoutBlock;
  } else if (withoutBlock.includes(SAIL_START)) {
    // Our values are the fallback; Sail's per-worktree ports are the override below them.
    content = withoutBlock.replace(SAIL_START, `${block}\n\n${SAIL_START}`);
  } else {
    const base = withoutBlock.replace(/\s+$/, '');
    content = base === '' ? `${block}\n` : `${base}\n\n${block}\n`;
  }
  return { content: content.replace(/\n{3,}/g, '\n\n'), added, skipped, rejected };
}

/** Adds an exact line to `.gitignore` when missing. */
export function ensureGitignore(
  content: string,
  entry: string,
): { content: string; changed: boolean } {
  const lines = content.split(/\r?\n/);
  if (lines.includes(entry)) return { content, changed: false };
  const base = content.replace(/\s+$/, '');
  return { content: base === '' ? `${entry}\n` : `${base}\n${entry}\n`, changed: true };
}
