import { flags } from '@adonisjs/core/ace';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import { ConfigCommand } from './shared.js';

/**
 * `node ace config:tenant:key [--rotate] [--reseal] [--dry-run] [--json]` — the app-side half of
 * sealed secrets.
 *
 * On a tenant it shows or rotates this app's X25519 key pair. The private keys never leave the app
 * (they are sealed with APP_KEY at rest); only the public half is registered with the control plane.
 * `--rotate` keeps the retired private keys, publishes the new public key and re-seals every value
 * sealed to the old one. `--reseal` only re-seals (and `--dry-run` counts).
 *
 * On a control plane/standalone it lists the public keys an app registered — `--app=shop`.
 */
export default class ConfigTenantKey extends ConfigCommand {
  static override commandName = 'config:tenant:key';
  static override description = "Show, rotate or re-seal a tenant's X25519 key for sealed secrets";

  @flags.boolean({
    description: 'Create a new active key and re-seal the values sealed to the old one',
  })
  declare rotate: boolean;

  @flags.boolean({ description: 'Re-seal values still sealed to a retired key' })
  declare reseal: boolean;

  @flags.boolean({ description: 'Count what would be re-sealed; change nothing' })
  declare dryRun: boolean;

  override async run(): Promise<void> {
    if (!hasRuntime()) {
      this.logger.error(
        'config:tenant:key needs the app booted: register "@adonis-agora/config/config_provider"',
      );
      this.exitCode = 1;
      return;
    }
    const runtime = getRuntime();
    if (runtime.topology !== 'tenant') {
      await this.#listServerKeys(runtime);
      return;
    }
    const keys = runtime.keys;
    const client = runtime.client;
    if (!keys || !client) {
      this.logger.error(
        'this app has no tenant keyring: set APP_KEY and leave tenant.keyPath on (default storage/config-tenant-key.json)',
      );
      this.exitCode = 1;
      return;
    }

    try {
      if (this.rotate) {
        if (this.dryRun) {
          const sealed = client.keyStatus().sealed;
          this.output(
            { action: 'rotate', dryRun: true, active: keys.activeKid, reseal: sealed },
            () => {
              this.logger.info(
                `would create a new key and re-seal ${sealed} value(s) sealed to ${keys.activeKid}`,
              );
            },
          );
          return;
        }
        const publicKey = await keys.rotate();
        const registered = await client.registerKeys();
        const report = await client.resealSealed();
        this.output(
          { action: 'rotate', publicKey, registered, ...report, key: keys.status() },
          () => {
            this.logger.success(`rotated to ${keys.activeKid} (${keys.status().path})`);
            if (!registered) {
              this.logger.warning(
                'the control plane did not accept the new public key; retry later',
              );
            }
            this.logger.info(
              `re-sealed ${report.resealed} of ${report.scanned} value(s) sealed to this app`,
            );
          },
        );
        return;
      }

      if (this.reseal) {
        const report = await client.resealSealed({ dryRun: this.dryRun });
        this.output({ action: 'reseal', ...report, key: keys.status() }, () => {
          this.logger.info(
            `${report.dryRun ? 'would re-seal' : 're-sealed'} ${report.resealed} of ${report.scanned} value(s)${report.skipped > 0 ? `, ${report.skipped} already on the active key` : ''}`,
          );
        });
        return;
      }

      // The CLI is also the explicit registration path: a key the server lost (a fresh dev
      // database, a restored backup) is published again here.
      if (client.keyStatus().registered !== true) await client.registerKeys();
      const status = client.keyStatus();
      const publicKeys = keys.publicKeys();
      this.output({ action: 'show', ...status, publicKeys, path: keys.path }, () => {
        this.logger.info(`${runtime.app}: ${keys.path}`);
        const table = this.ui.table();
        table.head(['Kid', 'Active', 'Public key']);
        for (const key of publicKeys) {
          table.row([key.kid, key.kid === keys.activeKid ? 'yes' : '', key.x]);
        }
        table.render();
        this.logger.info(
          `registered with the control plane: ${status.registered === null ? 'not tried yet' : status.registered ? 'yes' : `no (${status.error ?? 'error'})`}`,
        );
        this.logger.info(
          `${status.sealed} sealed value(s), ${status.unreadable} unreadable${status.staleKids.length > 0 ? `, sealed to retired key(s): ${status.staleKids.join(', ')}` : ''}`,
        );
        if (status.unreadable > 0) this.exitCode = 1;
      });
    } catch (error) {
      this.logger.error((error as Error).message);
      this.exitCode = 1;
    }
  }

  /** Control plane/standalone: the public keys an app registered (never a private key). */
  async #listServerKeys(runtime: ReturnType<typeof getRuntime>): Promise<void> {
    const app = this.application ?? runtime.app;
    if (!app) {
      this.logger.error(
        'pass --app=<name> (a control plane has no app of its own to list keys for)',
      );
      this.exitCode = 1;
      return;
    }
    if (!runtime.store?.listTenantKeys) {
      this.logger.error('this store cannot keep tenant keys');
      this.exitCode = 1;
      return;
    }
    const keys = await runtime.store.listTenantKeys(app);
    this.output({ app, keys }, () => {
      if (keys.length === 0) {
        this.logger.info(`no public key registered for "${app}"`);
        return;
      }
      this.logger.info(`${app}: ${keys.length} public key(s)`);
      const table = this.ui.table();
      table.head(['Kid', 'Active', 'Registered', 'By']);
      for (const key of keys) {
        table.row([key.kid, key.active ? 'yes' : '', key.createdAt, key.createdBy]);
      }
      table.render();
    });
  }
}
