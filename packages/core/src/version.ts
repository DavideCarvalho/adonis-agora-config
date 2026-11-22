import { createHash } from 'node:crypto';
import { canonicalJson } from './json.js';
import type { ConfigEntryState } from './types.js';

/**
 * A short content hash of the entries (and their flags): two versions with the same fingerprint hold
 * the same configuration. Used as the ETag's second half and to recognise a no-op write.
 */
export function fingerprintOf(entries: Record<string, ConfigEntryState>): string {
  const canonical = canonicalJson(
    Object.fromEntries(
      Object.entries(entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [
          key,
          {
            value: entry.value ?? null,
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

/** The ETag of a scope version: strong, and different for two scopes with the same number. */
export function etagOf(app: string, environment: string, label: string, version: number): string {
  return `"${app}:${environment}:${label}:${version}"`;
}

/** Whether an `if-none-match` header matches `etag` (comma-separated list, `W/` prefixes). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => bare(candidate) === bare(etag));
}
