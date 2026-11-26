import { createHash } from 'node:crypto';
import { canonicalJson } from './json.js';
import type { ConfigEntryState, ConfigValue } from './types.js';

export interface FingerprintOptions {
  /**
   * A keyed digest of a secret's plaintext (an HMAC under a key only the server holds). The
   * fingerprint is shown to callers that cannot read secrets, so an unkeyed hash of a secret would
   * let them confirm guesses offline; with this, a secret enters the fingerprint only through the
   * keyed digest. Without it the plaintext is hashed as before (no secret store: nothing to guess).
   */
  secretDigest?: ((value: ConfigValue) => string) | undefined;
}

/**
 * A short content hash of the entries (and their flags): two versions with the same fingerprint hold
 * the same configuration. Used to recognise a no-op write and to signal changes to tenants.
 */
export function fingerprintOf(
  entries: Record<string, ConfigEntryState>,
  options: FingerprintOptions = {},
): string {
  const { secretDigest } = options;
  const canonical = canonicalJson(
    Object.fromEntries(
      Object.entries(entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [
          key,
          {
            value:
              secretDigest !== undefined &&
              entry.secret &&
              entry.value !== undefined &&
              entry.sealedTo === undefined
                ? { digest: secretDigest(entry.value) }
                : (entry.value ?? null),
            vault: entry.vault ?? null,
            sealedTo: entry.sealedTo ?? null,
            secret: entry.secret,
            reloadable: entry.reloadable,
            // Only when set, so the fingerprint of every version written before it is unchanged.
            ...(entry.browser === true ? { browser: true } : {}),
            description: entry.description ?? null,
          },
        ]),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The ETag of a scope version: strong, and different for two scopes with the same number. Each part
 * is percent-encoded, so the header is always plain ASCII whatever the label holds (a control or
 * non-latin1 character in a response header makes Node throw after the handler returned).
 */
export function etagOf(app: string, environment: string, label: string, version: number): string {
  const part = (value: string) => encodeURIComponent(value);
  return `"${part(app)}:${part(environment)}:${part(label)}:${version}"`;
}

/** Whether an `if-none-match` header matches `etag` (comma-separated list, `W/` prefixes). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => bare(candidate) === bare(etag));
}
