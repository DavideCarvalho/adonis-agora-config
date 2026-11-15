import type { ConfigEntryState, ConfigValue } from './types.js';

/** JSON with sorted object keys: the same value always has the same text (and hash). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`config: cannot canonicalize ${typeof value}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Nested object → flat dot paths (`{ db: { host } }` → `{ 'db.host' }`). Arrays stay whole values:
 * an array is a single setting, not a list of settings.
 */
export function flattenObject(
  input: Record<string, unknown>,
  prefix = '',
  out: Record<string, ConfigValue> = {},
): Record<string, ConfigValue> {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) flattenObject(value, path, out);
    else out[path] = value as ConfigValue;
  }
  return out;
}

/** Flat dot paths → a nested object. `db.host` and `db` in one map: `db` must be an object. */
export function unflattenObject(flat: Record<string, ConfigValue>): Record<string, ConfigValue> {
  const root: Record<string, ConfigValue> = {};
  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split('.');
    let cursor: Record<string, ConfigValue> = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const next = cursor[segment];
      if (next === undefined) {
        const created: Record<string, ConfigValue> = {};
        cursor[segment] = created;
        cursor = created;
      } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        cursor = next as Record<string, ConfigValue>;
      } else {
        throw new Error(
          `config: "${segments.slice(0, index + 1).join('.')}" is both a value and a path`,
        );
      }
    }
    const last = segments[segments.length - 1]!;
    if (cursor[last] !== undefined) throw new Error(`config: "${path}" is both a value and a path`);
    cursor[last] = value;
  }
  return root;
}

/** The values of a document, flattened, without the flags. */
export function documentValues(
  entries: Record<string, ConfigEntryState>,
): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.value !== undefined) out[key] = entry.value;
  }
  return out;
}
