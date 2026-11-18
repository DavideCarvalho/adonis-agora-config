import { userInfo } from 'node:os';
import { type ConfigScope, DEFAULT_LABEL } from '@adonis-agora/config-core';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { ConfigAdmin, type EntryRow } from '../src/admin.js';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';

/** `cli:<os user>`, the actor every command records in the audit trail. */
export function cliActor(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
}

/** The booted runtime's admin, or a clear error. */
export function adminOf(app: {
  container: { make(binding: string): Promise<unknown> };
}): ConfigAdmin {
  if (!hasRuntime()) {
    throw new Error(
      '@adonis-agora/config is not booted: register "@adonis-agora/config/config_provider" in adonisrc.ts',
    );
  }
  const runtime = getRuntime();
  if (!runtime.store) {
    throw new Error(
      '@adonis-agora/config: this app is a tenant; its entries are edited on the control plane',
    );
  }
  void app;
  return new ConfigAdmin({
    store: runtime.store,
    onChange: (scope, version) => runtime.controlPlane?.bus.publish(scope, version),
  });
}

/** Shared flags and helpers for the `config:*` commands. */
export abstract class ConfigCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.string({
    flagName: 'app',
    description:
      'The app (partition). Default: the first app in the store. `--application` still works.',
    alias: ['a', 'application'],
  })
  declare appName?: string;

  @flags.string({ description: 'Environment. Default: this process environment' })
  declare environment?: string;

  @flags.string({ description: 'Label/profile. Default: main' })
  declare label?: string;

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  protected get admin(): ConfigAdmin {
    return adminOf(this.app);
  }

  /** The scope named by the flags, with the runtime's defaults. */
  protected async scope(): Promise<ConfigScope> {
    const runtime = getRuntime();
    return {
      app: this.appName ?? runtime.app ?? (await this.firstApp()),
      environment: this.environment ?? runtime.environment,
      label: this.label ?? DEFAULT_LABEL,
    };
  }

  private async firstApp(): Promise<string> {
    const apps = await this.admin.scopes();
    const app = apps.apps[0];
    if (!app) throw new Error('config: the store has no app yet; pass --app');
    return app;
  }

  /** Writes JSON to stdout when `--json`, else runs the human renderer. */
  protected output(payload: unknown, human: () => void): void {
    if (this.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else human();
  }

  /** Asks before an irreversible action unless `--force` was passed. */
  protected async confirm(message: string, force: boolean): Promise<boolean> {
    if (force) return true;
    const answer = await this.prompt.confirm(message);
    return answer === true;
  }

  protected printEntries(entries: readonly EntryRow[]): void {
    const table = this.ui.table();
    table.head(['Key', 'Value', 'Secret', 'Reloadable', 'Updated by', 'Updated at']);
    for (const entry of entries) {
      table.row([
        entry.key,
        entry.sealedTo !== undefined
          ? `(sealed for ${entry.sealedTo.app})`
          : entry.masked
            ? '(masked)'
            : entry.vault !== undefined
              ? entry.vault
              : formatValue(entry.value),
        entry.secret ? 'yes' : '',
        entry.reloadable ? 'yes' : '',
        entry.updatedBy,
        entry.updatedAt,
      ]);
    }
    table.render();
  }
}

export function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Reads a value typed on the command line: valid JSON wins, else the text is a string. */
export function parseCliValue(text: string, stringOnly: boolean): unknown {
  if (stringOnly) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
