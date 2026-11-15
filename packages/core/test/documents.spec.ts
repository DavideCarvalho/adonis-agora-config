import { describe, expect, it } from 'vitest';
import {
  type ConfigDocument,
  type ConfigEntryState,
  diffDocuments,
  diffSummary,
  etagMatches,
  etagOf,
  fingerprintOf,
  maskDocument,
} from '../src/index.js';

const at = new Date(0).toISOString();

function entry(value: ConfigEntryState['value'], extra: Partial<ConfigEntryState> = {}) {
  return { value, secret: false, reloadable: false, updatedAt: at, updatedBy: 'tester', ...extra };
}

function document(entries: Record<string, ConfigEntryState>, version = 1): ConfigDocument {
  return {
    app: 'shop',
    environment: 'production',
    label: 'main',
    version,
    entries,
    createdAt: at,
    createdBy: 'tester',
    fingerprint: fingerprintOf(entries),
  };
}

describe('version', () => {
  it('is stable across key order and sensitive to flags', () => {
    const a = fingerprintOf({ a: entry(1), b: entry(2) });
    const b = fingerprintOf({ b: entry(2), a: entry(1) });
    expect(a).toBe(b);
    expect(fingerprintOf({ a: entry(1), b: entry(3) })).not.toBe(a);
    expect(fingerprintOf({ a: entry(1, { reloadable: true }), b: entry(2) })).not.toBe(a);
  });

  it('builds a strong ETag per scope and matches lists and weak tags', () => {
    const etag = etagOf('shop', 'production', 'main', 3);
    expect(etag).toBe('"shop:production:main:3"');
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
    expect(etagMatches('"x"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches('*', etag)).toBe(true);
  });
});

describe('masking', () => {
  it('drops secret and vault values without the capability', () => {
    const doc = document({
      plain: entry('x'),
      password: entry('hunter2', { secret: true }),
      apiKey: entry(undefined, { vault: 'vault://aws/x#y', secret: true }),
    });
    const masked = maskDocument(doc, false);
    expect(masked.entries.plain).toEqual({ ...entry('x'), masked: false });
    expect(masked.entries.password).toMatchObject({ masked: true, secret: true });
    expect(masked.entries.password?.value).toBeUndefined();
    expect(masked.entries.apiKey?.vault).toBe('vault://aws/x#y');
    expect(masked.entries.apiKey?.value).toBeUndefined();
  });

  it('keeps everything for a reader with the capability', () => {
    const doc = document({ password: entry('hunter2', { secret: true }) });
    expect(maskDocument(doc, true).entries.password).toEqual({
      ...entry('hunter2', { secret: true }),
      masked: false,
    });
  });
});

describe('diff', () => {
  it('reports added, removed, changed and flag-only changes', () => {
    const from = maskDocument(
      document({ keep: entry(1), gone: entry(2), same: entry(3), flag: entry(4) }, 1),
      true,
    );
    const to = maskDocument(
      document(
        {
          keep: entry(9),
          same: entry(3),
          flag: entry(4, { reloadable: true }),
          added: entry(5),
        },
        2,
      ),
      true,
    );
    const rows = diffDocuments(from, to);
    expect(rows.map((row) => [row.key, row.kind])).toEqual([
      ['added', 'added'],
      ['flag', 'changed'],
      ['gone', 'removed'],
      ['keep', 'changed'],
    ]);
    expect(diffSummary(rows)).toBe('+1 ~2 -1');
  });

  it('does not report a masked secret as changed when the value changed', () => {
    const from = maskDocument(document({ p: entry('a', { secret: true }) }), false);
    const to = maskDocument(document({ p: entry('b', { secret: true }) }), false);
    expect(diffDocuments(from, to)).toEqual([]);
  });
});
