import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';

/**
 * `node ace config:crypto:reseal [--dry-run] [--json]` — walks every stored version and audit row
 * and re-seals secrets written with a retired or legacy key with the active key. A dry run only
 * counts them. Exit code 1 when a value could not be re-sealed (a missing key, tampering, …).
 */
export default class ConfigCryptoReseal extends BaseCommand {
  static override commandName = 'config:crypto:reseal';
  static override description = 'Re-seal secret values with the active crypto key';
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Count what would be re-sealed; change nothing' })
  declare dryRun: boolean;

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  override async run(): Promise<void> {
    if (!hasRuntime() || !getRuntime().store) {
      this.logger.error(
        'config:crypto:reseal runs on a control plane or standalone app; a tenant has no store',
      );
      this.exitCode = 1;
      return;
    }
    const runtime = getRuntime();
    if (!runtime.secrets) {
      this.logger.error('no crypto keyring: set APP_KEY, or `crypto.keys` in config/config.ts');
      this.exitCode = 1;
      return;
    }
    const store = runtime.store;
    if (!store) {
      this.logger.error('this app has no configuration store');
      this.exitCode = 1;
      return;
    }
    if (!store.reseal) {
      this.logger.error('the configured store cannot re-seal values');
      this.exitCode = 1;
      return;
    }

    const report = await store.reseal({ dryRun: this.dryRun === true });
    if (this.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      this.logger.info(
        `${this.dryRun ? 'would re-seal' : 're-sealed'} ${report.resealed} of ${report.scanned} secret value(s)`,
      );
      const table = this.ui.table();
      table.head(['Status', 'Values']);
      for (const [status, count] of Object.entries(report.statuses)) {
        table.row([status, String(count)]);
      }
      table.render();
      if (report.failed > 0) {
        this.logger.error(
          `${report.failed} value(s) could not be re-sealed (missing key or tampering)`,
        );
      }
    }
    if (report.failed > 0) this.exitCode = 1;
  }
}
