/**
 * Test helpers for apps and for this package: an in-memory control plane you can write to with the
 * same store the real one uses, plus a seeded document.
 */
import {
  type ConfigEntryInput,
  type ConfigScope,
  type ConfigValue,
} from '@adonis-agora/config-core';
import { secretCodec } from '../crypto/secrets.js';
import { MemoryStore } from '../store/memory_store.js';

export { LucidStore } from '../store/lucid_store.js';
export { MemoryStore } from '../store/memory_store.js';

export interface MemoryConfigOptions {
  /** The key secrets are encrypted with. Default: a fixed test key. */
  secretsKey?: string | false;
}

/** A memory store, with secrets sealed exactly like the database store seals them. */
export function memoryConfig(options: MemoryConfigOptions = {}): MemoryStore {
  if (options.secretsKey === false) return new MemoryStore();
  return new MemoryStore({
    secretCodec: secretCodec(options.secretsKey ?? 'test-secret-key-for-agora-config'),
  });
}

/** Writes entries into a scope, as a tenant's operator would (actor `test`). */
export async function seedConfig(
  store: MemoryStore,
  scope: ConfigScope,
  entries: Array<ConfigEntryInput | [string, ConfigValue]>,
): Promise<void> {
  const changes: ConfigEntryInput[] = entries.map((entry) =>
    Array.isArray(entry) ? { key: entry[0], value: entry[1] } : entry,
  );
  await store.write(scope, changes, { actor: 'test', now: new Date().toISOString() });
}

/** The scope every test starts from. */
export const testScope: ConfigScope = {
  app: 'shop',
  environment: 'production',
  label: 'main',
};
