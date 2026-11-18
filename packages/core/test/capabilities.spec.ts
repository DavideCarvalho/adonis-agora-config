import { describe, expect, it } from 'vitest';
import { CONFIG_SCOPES, capabilityAllows } from '../src/index.js';

describe('capabilityAllows', () => {
  it('matches an exact capability', () => {
    expect(capabilityAllows(['config:read'], 'config:read')).toBe(true);
    expect(capabilityAllows(['config:secrets:read'], 'config:secrets:read')).toBe(true);
    expect(capabilityAllows(['config:write'], 'config:read')).toBe(false);
  });

  it('lets `*` match everything', () => {
    expect(capabilityAllows(['*'], 'config:read')).toBe(true);
    expect(capabilityAllows(['*'], 'config:secrets:read')).toBe(true);
    expect(capabilityAllows(['*'], 'flags:read')).toBe(true);
  });

  it('lets `config:*` match every config capability, nested ones included', () => {
    for (const scope of Object.values(CONFIG_SCOPES)) {
      expect(capabilityAllows(['config:*'], scope)).toBe(true);
    }
    expect(capabilityAllows(['config:*'], 'config:secrets:read')).toBe(true);
  });

  it('never lets `config:*` match another product', () => {
    expect(capabilityAllows(['config:*'], 'flags:read')).toBe(false);
    expect(capabilityAllows(['config:*'], 'config')).toBe(false);
  });

  it('matches a trailing `*` on one or more further segments', () => {
    expect(capabilityAllows(['config:secrets:*'], 'config:secrets:read')).toBe(true);
    expect(capabilityAllows(['config:secrets:*'], 'config:secrets:read:all')).toBe(true);
    expect(capabilityAllows(['config:secrets:*'], 'config:read')).toBe(false);
    // The trailing `*` covers at least one segment: it never matches the bare prefix.
    expect(capabilityAllows(['config:secrets:*'], 'config:secrets')).toBe(false);
  });

  it('lets a middle `*` match exactly one segment', () => {
    expect(capabilityAllows(['config:*:read'], 'config:secrets:read')).toBe(true);
    expect(capabilityAllows(['config:*:read'], 'config:read')).toBe(false);
    expect(capabilityAllows(['config:*:read'], 'config:secrets:write')).toBe(false);
    expect(capabilityAllows(['config:*:read'], 'config:a:b:read')).toBe(false);
  });

  it('implies nothing', () => {
    expect(capabilityAllows(['config:read'], 'config:secrets:read')).toBe(false);
    expect(capabilityAllows(['config:secrets:read'], 'config:read')).toBe(false);
    expect(capabilityAllows(['config:read'], 'config:read:more')).toBe(false);
  });

  it('ignores empty and non-string grants', () => {
    expect(capabilityAllows([], 'config:read')).toBe(false);
    expect(capabilityAllows([''], 'config:read')).toBe(false);
    expect(
      capabilityAllows([null, 42, undefined] as unknown as readonly string[], 'config:read'),
    ).toBe(false);
    expect(capabilityAllows(['', 'config:read'], 'config:read')).toBe(true);
  });
});
