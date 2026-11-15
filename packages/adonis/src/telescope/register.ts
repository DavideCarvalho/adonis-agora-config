import { configTelescopeExtension } from './extension.js';
import type { TelescopeExtension } from './telescope-sdk.js';

/** The container key every Agora lib pushes its telescope extension into. */
export const TELESCOPE_EXTENSIONS_BINDING = 'agora.telescope.extensions';

/** The slice of the AdonisJS container this registration touches (structural). */
export interface TelescopeContainerLike {
  hasBinding(key: string): boolean;
  bindValue(key: string, value: unknown): void;
  make(key: string): Promise<unknown>;
}

/**
 * Pushes the config extension into `'agora.telescope.extensions'`, created-if-absent — the
 * zero-config wiring telescope's provider reads in addition to `config/telescope.ts`. Idempotent
 * (never adds a second `config` extension) and never throws: an app without telescope keeps
 * working, it simply has no one to read the binding.
 */
export async function registerConfigTelescopeExtension(
  container: TelescopeContainerLike,
  extension: TelescopeExtension = configTelescopeExtension(),
): Promise<boolean> {
  try {
    if (!container.hasBinding(TELESCOPE_EXTENSIONS_BINDING)) {
      container.bindValue(TELESCOPE_EXTENSIONS_BINDING, [] as TelescopeExtension[]);
    }
    const value = await container.make(TELESCOPE_EXTENSIONS_BINDING);
    if (!Array.isArray(value)) return false;
    if (value.some((entry) => (entry as { name?: unknown } | null)?.name === extension.name)) {
      return false;
    }
    value.push(extension);
    return true;
  } catch {
    return false;
  }
}
