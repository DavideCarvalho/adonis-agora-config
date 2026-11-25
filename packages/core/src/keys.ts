import type { ConfigEntryState, ConfigValue } from './types.js';

const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Segments that would reach `Object.prototype` when a key is turned into a nested object. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether `segment` is one of `__proto__`, `constructor`, `prototype`. */
export function isReservedKeySegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment);
}

/** Throws unless `key` is a dot path of plain segments (`db.host`, `feature.new_ui`). */
export function assertConfigKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('config: a key is required');
  }
  if (key.length > 255) throw new Error(`config: key "${key}" is longer than 255 characters`);
  for (const segment of key.split('.')) {
    if (!KEY_SEGMENT.test(segment)) {
      throw new Error(
        `config: invalid key "${key}" (segments are letters, digits, _ and -, separated by dots)`,
      );
    }
    if (isReservedKeySegment(segment)) {
      throw new Error(`config: invalid key "${key}" ("${segment}" is a reserved segment)`);
    }
  }
}

/** Whether `value` is a `vault://provider/path#field` reference. */
export function isVaultReference(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('vault://');
}

/** `vault://aws/prod/db#password` → `{ provider: 'aws', path: 'prod/db', field: 'password' }`. */
export interface VaultReference {
  provider: string;
  path: string;
  field: string;
}

export function parseVaultReference(reference: string): VaultReference {
  const match = /^vault:\/\/([^/]+)\/(.+?)(?:#([^#]+))?$/.exec(reference);
  if (!match) {
    throw new Error(
      `config: invalid vault reference "${reference}" (expected vault://provider/path#field)`,
    );
  }
  return { provider: match[1]!, path: match[2]!, field: match[3] ?? 'value' };
}

/** Builds a vault reference, rejecting empty parts. */
export function vaultReference(provider: string, path: string, field = 'value'): string {
  if (!provider || !path || !field) {
    throw new Error('config: a vault reference needs a provider, a path and a field');
  }
  return `vault://${provider}/${path}#${encodeURIComponent(field)}`;
}

/** A JSON value from unknown input, or a clear error. Rejects functions, Dates, BigInt. */
export function toConfigValue(value: unknown, key = 'value'): ConfigValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`config: ${key} must be a finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      item === undefined ? null : toConfigValue(item, `${key}[${index}]`),
    );
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`config: ${key} is not JSON (${proto?.constructor?.name ?? typeof value})`);
    }
    const out: Record<string, ConfigValue> = {};
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[name] = toConfigValue(item, `${key}.${name}`);
    }
    return out;
  }
  throw new Error(`config: ${key} is not JSON (${typeof value})`);
}

/**
 * Reads a value typed by a person (console, CLI): valid JSON wins (`true`, `42`, `{"a":1}`), else the
 * text is a string. `--string` keeps even valid-JSON text as a string.
 */
export function parseConfigValue(text: string, options: { string?: boolean } = {}): ConfigValue {
  if (options.string) return text;
  try {
    return toConfigValue(JSON.parse(text));
  } catch {
    return text;
  }
}

/** The text form of a value: strings verbatim, everything else pretty-printed JSON. */
export function serializeConfigValue(value: ConfigValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** A value safe to put in `process.env`: objects and arrays become JSON, null becomes empty. */
export function envValueOf(value: ConfigValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The env variable name a config key maps to: `db.port` → `DB_PORT`, `feature.new-ui` →
 * `FEATURE_NEW_UI`. The same mapping in the bootstrap (remote → env) and in the tenant's local-env
 * override (env → remote), so the two directions always agree.
 */
export function envNameOf(key: string, prefix = ''): string {
  return `${prefix}${key}`
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replaceAll('.', '_')
    .replaceAll('-', '_');
}

/** A config key back from an env variable name (`DB_PORT` → `db.port`), lowercased. */
export function keyFromEnvName(name: string): string {
  return name.toLowerCase().replaceAll('_', '.');
}

/**
 * Types an env string like the value it overrides: `'5789'` becomes `5789` when the remote value is
 * a number, `'true'` a boolean, and JSON text an object. An unparsable value stays the raw string —
 * never silently dropped.
 */
export function coerceEnvValue(text: string, reference: ConfigValue | undefined): ConfigValue {
  if (typeof reference === 'number') {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (typeof reference === 'boolean') {
    return text === 'true' ? true : text === 'false' ? false : text;
  }
  if (reference !== null && typeof reference === 'object') {
    try {
      return toConfigValue(JSON.parse(text));
    } catch {
      return text;
    }
  }
  return text;
}

/** A deep copy, so a caller can mutate a document it received. */
export function cloneEntries(
  entries: Record<string, ConfigEntryState>,
): Record<string, ConfigEntryState> {
  return structuredClone(entries);
}
