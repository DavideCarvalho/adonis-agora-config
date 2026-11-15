import type { ConfigRuntime } from '../runtime.js';

let runtime: ConfigRuntime | undefined;

export function setRuntime(value: ConfigRuntime | undefined): void {
  runtime = value;
}

export function hasRuntime(): boolean {
  return runtime !== undefined;
}

/** The booted config runtime; throws a clear error when the provider is not registered. */
export function getRuntime(): ConfigRuntime {
  if (!runtime) {
    throw new Error(
      '@adonis-agora/config is not booted: register "@adonis-agora/config/config_provider" in adonisrc.ts',
    );
  }
  return runtime;
}
