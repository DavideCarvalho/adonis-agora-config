import { describe, expect, it } from 'vitest';
import {
  type ConfigEntryState,
  canonicalJson,
  documentValues,
  flattenObject,
  unflattenObject,
} from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: true } })).toBe(
      '{"a":{"c":true,"d":[2,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('flatten / unflatten', () => {
  it('flattens nested objects and keeps arrays whole', () => {
    expect(
      flattenObject({ db: { host: 'localhost', pool: [1, 2] }, debug: true, map: { a: { b: 1 } } }),
    ).toEqual({ 'db.host': 'localhost', 'db.pool': [1, 2], debug: true, 'map.a.b': 1 });
  });

  it('round-trips', () => {
    const flat = { 'db.host': 'h', 'db.pool': [1], debug: false, 'a.b.c': null };
    expect(flattenObject(unflattenObject(flat) as Record<string, unknown>)).toEqual(flat);
  });

  it('refuses a key that is both a value and a path', () => {
    expect(() => unflattenObject({ db: 'x', 'db.host': 'y' })).toThrow(/both a value and a path/);
    expect(() => unflattenObject({ 'db.host': 'y', db: 'x' })).toThrow(/both a value and a path/);
  });

  it('refuses reserved segments and never touches Object.prototype', () => {
    for (const path of [
      '__proto__.polluted',
      'a.__proto__.polluted',
      'constructor.prototype.polluted',
      'a.prototype',
      '__proto__',
    ]) {
      expect(() => unflattenObject({ [path]: 'PWNED' })).toThrow(/reserved segment/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reads the values of a document', () => {
    const at = new Date(0).toISOString();
    const entries: Record<string, ConfigEntryState> = {
      'db.host': { value: 'h', secret: false, reloadable: true, updatedAt: at, updatedBy: 'x' },
      token: {
        vault: 'vault://aws/x#y',
        secret: true,
        reloadable: false,
        updatedAt: at,
        updatedBy: 'x',
      },
    };
    expect(documentValues(entries)).toEqual({ 'db.host': 'h' });
  });
});
