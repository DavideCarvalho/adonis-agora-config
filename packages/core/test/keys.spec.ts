import { describe, expect, it } from 'vitest';
import {
  assertConfigKey,
  coerceEnvValue,
  envNameOf,
  envValueOf,
  keyFromEnvName,
  parseConfigValue,
  parseVaultReference,
  serializeConfigValue,
  toConfigValue,
  vaultReference,
} from '../src/index.js';

describe('keys', () => {
  it('accepts dot paths of plain segments', () => {
    for (const key of ['db', 'db.host', 'feature.new_ui', 'a-b_c.d1']) {
      expect(() => assertConfigKey(key)).not.toThrow();
    }
  });

  it('rejects empty, long and malformed keys', () => {
    expect(() => assertConfigKey('')).toThrow(/required/);
    expect(() => assertConfigKey('a'.repeat(256))).toThrow(/255/);
    for (const key of ['db..host', '.db', 'db.', 'db host', 'db/url']) {
      expect(() => assertConfigKey(key)).toThrow(/invalid key/);
    }
  });

  it('rejects reserved segments', () => {
    for (const key of ['__proto__.polluted', 'a.constructor', 'a.prototype.b']) {
      expect(() => assertConfigKey(key)).toThrow(/reserved segment/);
    }
  });

  it('parses and builds vault references', () => {
    expect(parseVaultReference('vault://aws/prod/db#password')).toEqual({
      provider: 'aws',
      path: 'prod/db',
      field: 'password',
    });
    expect(parseVaultReference('vault://gcp/team/app')).toEqual({
      provider: 'gcp',
      path: 'team/app',
      field: 'value',
    });
    expect(vaultReference('aws', 'prod/db', 'password')).toBe('vault://aws/prod/db#password');
    expect(() => parseVaultReference('https://x')).toThrow(/invalid vault reference/);
    expect(() => vaultReference('', 'x')).toThrow(/needs a provider/);
  });
});

describe('values', () => {
  it('accepts JSON and rejects the rest', () => {
    expect(toConfigValue({ a: [1, 'x', true, null] })).toEqual({ a: [1, 'x', true, null] });
    expect(() => toConfigValue(Number.NaN)).toThrow(/finite/);
    expect(() => toConfigValue(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => toConfigValue(() => 1)).toThrow(/not JSON/);
    expect(() => toConfigValue(new Date())).toThrow(/not JSON/);
  });

  it('drops undefined object members and keeps arrays whole', () => {
    expect(toConfigValue({ a: 1, b: undefined, c: [1, undefined] })).toEqual({
      a: 1,
      c: [1, null],
    });
  });

  it('reads typed text: JSON wins, text is a string', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('42')).toBe(42);
    expect(parseConfigValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseConfigValue('hello')).toBe('hello');
    expect(parseConfigValue('true', { string: true })).toBe('true');
  });

  it('serializes strings verbatim and objects as JSON', () => {
    expect(serializeConfigValue('hello')).toBe('hello');
    expect(serializeConfigValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('maps keys to env names and back, and types env strings like the value they override', () => {
    expect(envNameOf('db.port')).toBe('DB_PORT');
    expect(envNameOf('checkout.timeoutMs')).toBe('CHECKOUT_TIMEOUT_MS');
    expect(envNameOf('feature.new-ui')).toBe('FEATURE_NEW_UI');
    expect(envNameOf('db.port', 'APP_')).toBe('APP_DB_PORT');
    expect(keyFromEnvName('DB_PORT')).toBe('db.port');
    expect(coerceEnvValue('5789', 5432)).toBe(5789);
    expect(coerceEnvValue('nope', 5432)).toBe('nope');
    expect(coerceEnvValue('false', true)).toBe(false);
    expect(coerceEnvValue('{"a":1}', { a: 0 })).toEqual({ a: 1 });
    expect(coerceEnvValue('plain', 'remote')).toBe('plain');
  });

  it('turns values into env text', () => {
    expect(envValueOf(null)).toBe('');
    expect(envValueOf('x')).toBe('x');
    expect(envValueOf(3)).toBe('3');
    expect(envValueOf(false)).toBe('false');
    expect(envValueOf({ a: 1 })).toBe('{"a":1}');
  });
});
