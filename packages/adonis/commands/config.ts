import { assertConfigKey, envNameOf, envValueOf } from '@adonis-agora/config-core';
import { args, flags } from '@adonisjs/core/ace';
import { getRuntime } from '../src/services/accessor.js';
import { ConfigCommand, cliActor, formatValue, parseCliValue } from './shared.js';

/** `node ace config:entry:list --app=shop --environment=production`. */
export class ConfigEntryList extends ConfigCommand {
  static override commandName = 'config:entry:list';
  static override description = 'List configuration entries of an app/environment/label';

  @flags.string({ description: 'Only keys or descriptions containing this text' })
  declare search?: string;

  @flags.boolean({ description: 'Only secret entries' })
  declare secret: boolean;

  @flags.boolean({ description: 'Only reloadable entries' })
  declare reloadable: boolean;

  @flags.number({ description: 'Page number (1-based). Default 1' })
  declare page?: number;

  @flags.number({ description: 'Rows per page. Default 50, at most 200' })
  declare size?: number;

  @flags.boolean({ description: 'Show secret values (the CLI is the operator, not a tenant)' })
  declare secrets: boolean;

  override async run(): Promise<void> {
    const scope = await this.scope();
    const result = await this.admin.listEntries(scope, this.secrets === true, {
      page: this.page ?? 1,
      size: this.size ?? 50,
      filters: {
        ...(this.search !== undefined ? { search: this.search } : {}),
        ...(this.secret === true ? { secret: true } : {}),
        ...(this.reloadable === true ? { reloadable: true } : {}),
      },
    });
    this.output({ scope, ...result }, () => {
      this.logger.info(
        `${scope.app} / ${scope.environment} / ${scope.label} — ${result.meta.total} entries`,
      );
      if (result.data.length === 0) {
        this.logger.info('nothing here yet');
        return;
      }
      this.printEntries(result.data);
      if (result.meta.lastPage > 1) {
        this.logger.info(`page ${result.meta.currentPage} of ${result.meta.lastPage}`);
      }
    });
  }
}

/** `node ace config:entry:get db.host --app=shop`. */
export class ConfigEntryGet extends ConfigCommand {
  static override commandName = 'config:entry:get';
  static override description = 'Show one configuration entry';

  @args.string({ description: 'Entry key (dot path)' })
  declare key: string;

  @flags.boolean({ description: 'Show the value of a secret entry (recorded as a reveal)' })
  declare secrets: boolean;

  override async run(): Promise<void> {
    const scope = await this.scope();
    assertConfigKey(this.key);
    const entry = await this.admin.getEntry(scope, this.key, {
      canReadSecrets: this.secrets === true,
      ...(this.secrets === true ? { reveal: { actor: cliActor() } } : {}),
    });
    if (!entry) {
      this.logger.error(
        `no entry "${this.key}" in ${scope.app}/${scope.environment}/${scope.label}`,
      );
      this.exitCode = 1;
      return;
    }
    this.output(entry, () => {
      this.logger.info(`${entry.key} (${scope.app} / ${scope.environment} / ${scope.label})`);
      this.logger.log(
        entry.masked
          ? '(masked — pass --secrets to reveal, which is audited)'
          : entry.vault !== undefined
            ? entry.vault
            : formatValue(entry.value),
      );
      this.logger.info(
        `${entry.secret ? 'secret' : 'plain'} · ${entry.reloadable ? 'reloadable' : 'needs a restart'} · ${entry.updatedBy} · ${entry.updatedAt}`,
      );
    });
  }
}

/** `node ace config:entry:set checkout.timeoutMs 5000 --app=shop --reloadable`. */
export class ConfigEntrySet extends ConfigCommand {
  static override commandName = 'config:entry:set';
  static override description = 'Create or update a configuration entry';

  @args.string({ description: 'Entry key (dot path)' })
  declare key: string;

  @args.string({
    description: 'The value: valid JSON, or text. Omit with --vault',
    required: false,
  })
  declare value?: string;

  @flags.string({ description: 'The value, when not passed as an argument' })
  declare setValue?: string;

  @flags.string({ description: 'A vault:// reference instead of a value' })
  declare vault?: string;

  @flags.boolean({ description: 'Encrypt the value at rest and gate it on config:secrets:read' })
  declare secret: boolean;

  @flags.boolean({ description: 'Apply on a running tenant without a restart' })
  declare reloadable: boolean;

  @flags.string({ description: 'A short description' })
  declare description?: string;

  @flags.string({ description: 'Why: recorded in the audit trail' })
  declare message?: string;

  @flags.boolean({ description: 'Keep the value as a string even when it parses as JSON' })
  declare string: boolean;

  override async run(): Promise<void> {
    assertConfigKey(this.key);
    const text = this.setValue ?? this.value;
    if (text === undefined && this.vault === undefined) {
      this.logger.error('pass a value, --value=… or --vault=vault://…');
      this.exitCode = 1;
      return;
    }
    const scope = await this.scope();
    const result = await this.admin.setEntry(
      scope,
      this.key,
      {
        ...(text !== undefined
          ? { value: parseCliValue(text, this.string === true) as never }
          : {}),
        ...(this.vault !== undefined ? { vault: this.vault } : {}),
        // A missing flag keeps the entry's current flags (the console can turn them off explicitly).
        ...(this.secret === true ? { secret: true } : {}),
        ...(this.reloadable === true ? { reloadable: true } : {}),
        ...(this.description !== undefined ? { description: this.description } : {}),
      },
      { actor: cliActor(), ...(this.message !== undefined ? { message: this.message } : {}) },
    );
    this.output({ scope, key: this.key, ...result }, () => {
      this.logger.success(
        `${result.changed ? 'wrote' : 'no change to'} ${this.key} at v${result.version} in ${scope.app}/${scope.environment}/${scope.label}`,
      );
    });
  }
}

/** `node ace config:entry:unset db.host --app=shop --force`. */
export class ConfigEntryUnset extends ConfigCommand {
  static override commandName = 'config:entry:unset';
  static override description = 'Remove a configuration entry';

  @args.string({ description: 'Entry key (dot path)' })
  declare key: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  @flags.string({ description: 'Why: recorded in the audit trail' })
  declare message?: string;

  override async run(): Promise<void> {
    assertConfigKey(this.key);
    const scope = await this.scope();
    if (
      !(await this.confirm(
        `Remove ${this.key} from ${scope.app}/${scope.environment}?`,
        this.force,
      ))
    ) {
      this.logger.info('cancelled');
      return;
    }
    const result = await this.admin.unsetEntry(scope, this.key, {
      actor: cliActor(),
      ...(this.message !== undefined ? { message: this.message } : {}),
    });
    this.output({ scope, key: this.key, ...result }, () => {
      this.logger.success(
        result.changed
          ? `removed ${this.key} at v${result.version}`
          : `${this.key} was not set: nothing to do`,
      );
    });
  }
}

/** `node ace config:history --app=shop`. */
export class ConfigHistory extends ConfigCommand {
  static override commandName = 'config:history';
  static override description = 'List the versions of a configuration scope, newest first';

  @flags.number({ description: 'Page number (1-based). Default 1' })
  declare page?: number;

  @flags.number({ description: 'Rows per page. Default 20, at most 100' })
  declare size?: number;

  @flags.boolean({ description: 'Oldest first' })
  declare oldest: boolean;

  override async run(): Promise<void> {
    const scope = await this.scope();
    const result = await this.admin.listVersions(scope, {
      page: this.page ?? 1,
      size: this.size ?? 20,
      direction: this.oldest === true ? 'asc' : 'desc',
    });
    this.output({ scope, ...result }, () => {
      this.logger.info(
        `${scope.app} / ${scope.environment} / ${scope.label} — ${result.meta.total} versions`,
      );
      const table = this.ui.table();
      table.head(['Version', 'When', 'Who', 'Entries', 'Secrets', 'Why']);
      for (const version of result.data) {
        table.row([
          `v${version.version}`,
          version.createdAt,
          version.createdBy,
          String(version.entries),
          String(version.secrets),
          version.message ?? '',
        ]);
      }
      table.render();
    });
  }
}

/** `node ace config:rollback --to=3 --app=shop --force`. */
export class ConfigRollback extends ConfigCommand {
  static override commandName = 'config:rollback';
  static override description = 'Copy a past version into a new version';

  @flags.number({ description: 'The version to restore' })
  declare to: number;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  @flags.string({ description: 'Why: recorded in the audit trail' })
  declare message?: string;

  override async run(): Promise<void> {
    const scope = await this.scope();
    if (
      !(await this.confirm(
        `Roll ${scope.app}/${scope.environment} back to v${this.to}?`,
        this.force,
      ))
    ) {
      this.logger.info('cancelled');
      return;
    }
    try {
      const result = await this.admin.rollback(scope, this.to, {
        actor: cliActor(),
        ...(this.message !== undefined ? { message: this.message } : {}),
      });
      this.output({ scope, to: this.to, ...result }, () => {
        this.logger.success(
          result.changed
            ? `rolled back to v${this.to} as v${result.version}`
            : `v${this.to} is already the current configuration`,
        );
      });
    } catch (error) {
      this.logger.error((error as Error).message);
      this.exitCode = 1;
    }
  }
}

/** `node ace config:version:show 3 --application=shop`. */
export class ConfigVersionShow extends ConfigCommand {
  static override commandName = 'config:version:show';
  static override description = 'Show one version exactly as it was';

  @args.string({ description: 'Version number' })
  declare version: string;

  @flags.boolean({ description: 'Show secret values (the CLI is the operator, not a tenant)' })
  declare secrets: boolean;

  override async run(): Promise<void> {
    const scope = await this.scope();
    const version = Number(this.version);
    if (!Number.isInteger(version) || version < 1) {
      this.logger.error('version must be a positive integer');
      this.exitCode = 1;
      return;
    }
    const found = await this.admin.version(scope, version, this.secrets === true);
    if (!found) {
      this.logger.error(
        `no version ${version} in ${scope.app}/${scope.environment}/${scope.label}`,
      );
      this.exitCode = 1;
      return;
    }
    this.output(found, () => {
      this.logger.info(
        `v${found.summary.version} · ${found.summary.createdBy} · ${found.summary.createdAt}${found.summary.message ? ` · ${found.summary.message}` : ''}`,
      );
      this.printEntries(found.entries);
    });
  }
}

/** `node ace config:diff --from=1 --to=3 --application=shop`. */
export class ConfigDiff extends ConfigCommand {
  static override commandName = 'config:diff';
  static override description = 'Show the changes between two versions';

  @flags.number({ description: 'The version to compare from' })
  declare from: number;

  @flags.number({ description: 'The version to compare to' })
  declare to: number;

  @flags.boolean({ description: 'Show secret values' })
  declare secrets: boolean;

  override async run(): Promise<void> {
    if (!Number.isInteger(this.from) || !Number.isInteger(this.to)) {
      this.logger.error('pass --from=<version> and --to=<version>');
      this.exitCode = 1;
      return;
    }
    const scope = await this.scope();
    try {
      const rows = await this.admin.diff(scope, this.from, this.to, this.secrets === true);
      this.output({ scope, from: this.from, to: this.to, rows }, () => {
        this.logger.info(
          `${scope.app} / ${scope.environment} / ${scope.label}: v${this.from} → v${this.to} — ${rows.length} change(s)`,
        );
        if (rows.length === 0) {
          this.logger.info('these versions hold the same configuration');
          return;
        }
        const table = this.ui.table();
        table.head(['Change', 'Key', 'Before', 'After']);
        for (const row of rows) {
          table.row([
            row.kind,
            row.key,
            row.before?.masked ? '(masked)' : formatValue(row.before?.value ?? row.before?.vault),
            row.after?.masked ? '(masked)' : formatValue(row.after?.value ?? row.after?.vault),
          ]);
        }
        table.render();
      });
    } catch (error) {
      this.logger.error((error as Error).message);
      this.exitCode = 1;
    }
  }
}

/** `node ace config:audit --application=shop --action=reveal`. */
export class ConfigAudit extends ConfigCommand {
  static override commandName = 'config:audit';
  static override description = 'Show the audit trail of a scope, newest first';

  @flags.string({ description: 'Only changes to this key' })
  declare key?: string;

  @flags.string({ description: 'Only this action (set, unset, rollback, reveal)' })
  declare action?: string;

  @flags.number({ description: 'Page number (1-based). Default 1' })
  declare page?: number;

  @flags.number({ description: 'Rows per page. Default 50, at most 200' })
  declare size?: number;

  override async run(): Promise<void> {
    const scope = await this.scope();
    const result = await this.admin.audit(scope, {
      page: this.page ?? 1,
      size: this.size ?? 50,
      ...(this.key !== undefined ? { key: this.key } : {}),
      ...(this.action !== undefined ? { action: this.action } : {}),
    });
    this.output({ scope, ...result }, () => {
      this.logger.info(
        `${scope.app} / ${scope.environment} / ${scope.label} — ${result.meta.total} rows`,
      );
      const table = this.ui.table();
      table.head(['When', 'Actor', 'Action', 'Key', 'Version', 'Why']);
      for (const row of result.data) {
        table.row([
          row.at,
          row.actor,
          row.action,
          row.key ?? '',
          `v${row.version}`,
          row.message ?? '',
        ]);
      }
      table.render();
    });
  }
}

/** `node ace config:env --app=shop` — the resolved values as KEY=value, like `sail:info --env`. */
export class ConfigEnv extends ConfigCommand {
  static override commandName = 'config:env';
  static override description = 'Print the resolved configuration as KEY=value lines';

  @flags.boolean({ description: 'Include secret values (masked by default)' })
  declare secrets: boolean;

  @flags.string({ description: 'Prefix every variable (APP_ → APP_DB_PORT)' })
  declare prefix?: string;

  override async run(): Promise<void> {
    const runtime = getRuntime();
    const values =
      runtime.topology === 'tenant'
        ? runtime.all()
        : await this.admin.values(await this.scope(), this.secrets === true);
    const lines = Object.entries(values)
      .map(([key, value]) => [envNameOf(key, this.prefix ?? ''), envValueOf(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.output(Object.fromEntries(lines), () => {
      for (const [name, value] of lines) this.logger.log(`${name}=${value}`);
    });
  }
}
