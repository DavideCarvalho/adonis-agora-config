import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';

/**
 * `node ace config:sync [--app=shop]` — pushes every variable of each app's current version to its
 * platform (`sync.rules` in `config/config.ts`): the first push after setting up a rule, and the
 * fix when the platform drifted. Every new version is pushed on its own; this is the full push.
 * Prints names and counts only, never a value.
 */
export default class ConfigSyncCommand extends BaseCommand {
  static override commandName = 'config:sync';
  static override description = "Push each app's configuration to its platform (sync.rules)";
  static override options: CommandOptions = { startApp: true };

  @flags.string({ flagName: 'app', description: 'Only this app', alias: ['a'] })
  declare appName?: string;

  @flags.boolean({ description: 'Machine-readable JSON output' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const runtime = hasRuntime() ? getRuntime() : undefined;
    if (!runtime?.sync) {
      this.logger.error('no sync rules: set `sync.rules` on the control plane (config/config.ts)');
      this.exitCode = 1;
      return;
    }
    const results = await runtime.sync.syncAll(this.appName ? { app: this.appName } : {});
    if (this.json) {
      this.logger.log(
        JSON.stringify(
          results.map((r) => ({
            app: r.rule.app,
            target: r.rule.target.name,
            version: r.change?.version ?? null,
            set: r.change ? Object.keys(r.change.set) : [],
            error: r.error ?? null,
          })),
          null,
          2,
        ),
      );
    } else {
      for (const r of results) {
        if (r.error) this.logger.error(`${r.rule.app} → ${r.rule.target.name}: ${r.error}`);
        else if (!r.change)
          this.logger.info(`${r.rule.app} → ${r.rule.target.name}: no configuration yet`);
        else
          this.logger.success(
            `${r.rule.app} → ${r.rule.target.name}: v${r.change.version}, ${Object.keys(r.change.set).length} variables`,
          );
      }
    }
    if (results.some((r) => r.error)) this.exitCode = 1;
  }
}
