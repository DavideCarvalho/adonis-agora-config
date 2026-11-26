import { describe, expect, it } from 'vitest';
import {
  CONSOLE_ALL,
  CONSOLE_READ,
  CONSOLE_WRITE,
  consoleCapabilityAllows,
  consoleCapabilityKind,
} from '../../src/dashboard/console_capabilities.js';
import { CONFIG_CONSOLE_TABLE, configConsoleAllows } from '../../src/federation/console.js';

const READ = 'config:read';
const WRITE = 'config:write';
const SECRETS = 'config:secrets:read';

/** [granted, required, allowed] — through config's table, as every config check runs it. */
const CASES: Array<[string, string, boolean]> = [
  // Exact.
  [READ, READ, true],
  [WRITE, WRITE, true],
  [SECRETS, SECRETS, true],
  [READ, WRITE, false],
  [WRITE, READ, false],
  [READ, SECRETS, false],
  // Literal aliases.
  ['*', READ, true],
  ['*', WRITE, true],
  ['*', SECRETS, true],
  ['config:*', READ, true],
  ['config:*', WRITE, true],
  ['config:*', SECRETS, true],
  [CONSOLE_ALL, READ, true],
  [CONSOLE_ALL, WRITE, true],
  [CONSOLE_ALL, SECRETS, true],
  // console:write covers reads and writes (write implies read); console:read covers reads.
  [CONSOLE_WRITE, READ, true],
  [CONSOLE_WRITE, WRITE, true],
  [CONSOLE_WRITE, CONSOLE_READ, true],
  [CONSOLE_WRITE, SECRETS, false],
  [CONSOLE_READ, READ, true],
  [CONSOLE_READ, WRITE, false],
  [CONSOLE_READ, CONSOLE_WRITE, false],
  [CONSOLE_READ, SECRETS, false],
  // Hierarchical, the only `*` last.
  ['config:secrets:*', SECRETS, true],
  ['config:secrets:*', READ, false],
  ['config:console:read:*', READ, false],
  // Look-alikes: any other `*` grants nothing.
  ['config:*:read', SECRETS, false],
  ['config:*:read', READ, false],
  ['*:console:*', READ, false],
  ['*:console:*', WRITE, false],
  ['config:console:w*', WRITE, false],
  ['config:console:w*', CONSOLE_WRITE, false],
  ['config:c*', READ, false],
  ['config:c*', CONSOLE_READ, false],
  ['other:console:*', READ, false],
  ['other:*', READ, false],
  ['other:console:write', WRITE, false],
  ['config:*:*', SECRETS, false],
  ['config:secrets:*:*', SECRETS, false],
  ['config::*', READ, false],
  ['', READ, false],
  // The aliases do not reach another lib's capabilities.
  ['config:*', 'flags:write', false],
  [CONSOLE_ALL, 'flags:read', false],
  [CONSOLE_WRITE, 'flags:write', false],
];

describe('the canonical console-capability matcher', () => {
  it.each(CASES)('%s → %s: %s', (granted, required, allowed) => {
    expect(configConsoleAllows([granted], required)).toBe(allowed);
  });

  it('classifies by the lib table; the aliases classify themselves', () => {
    expect(consoleCapabilityKind(READ, CONFIG_CONSOLE_TABLE)).toBe('read');
    expect(consoleCapabilityKind(WRITE, CONFIG_CONSOLE_TABLE)).toBe('write');
    expect(consoleCapabilityKind(SECRETS, CONFIG_CONSOLE_TABLE)).toBeUndefined();
    expect(consoleCapabilityKind(CONSOLE_READ)).toBe('read');
    expect(consoleCapabilityKind(CONSOLE_WRITE)).toBe('write');
    expect(consoleCapabilityKind('toString', CONFIG_CONSOLE_TABLE)).toBeUndefined();
  });

  it('without a table, the read/write aliases cover nothing but themselves', () => {
    expect(consoleCapabilityAllows([CONSOLE_WRITE], READ)).toBe(false);
    expect(consoleCapabilityAllows([CONSOLE_WRITE], CONSOLE_READ)).toBe(true);
    expect(consoleCapabilityAllows([CONSOLE_ALL], READ)).toBe(true);
  });

  it('malformed input allows nothing', () => {
    expect(consoleCapabilityAllows(undefined, READ)).toBe(false);
    expect(consoleCapabilityAllows('*' as never, READ)).toBe(false);
    expect(consoleCapabilityAllows([1, null, {}] as never, READ)).toBe(false);
    expect(consoleCapabilityAllows(['*'], '')).toBe(false);
    expect(configConsoleAllows([READ, '*'], WRITE)).toBe(true);
  });
});
