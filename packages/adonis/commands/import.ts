import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { keyFromEnvName } from '@adonis-agora/config-core';
import { flags } from '@adonisjs/core/ace';
import { ConfigCommand, cliActor } from './shared.js';

/** Env names treated as secrets unless `--secrets` says otherwise. */
export const DEFAULT_SECRET_PATTERN =
  '(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|_KEY$|KEY_ID$|DSN|WEBHOOK|PRIVATE|CREDENTIAL|JWKS|PEPPER|COOKIE)';

/** Reads every byte of stdin (the import piped in). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** `KEY=value` lines (a `.env`) or a JSON object of strings, into name → value. */
export function parseImport(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue;
      out[name] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  }
  return { ...parseEnv(text) } as Record<string, string>;
}

/**
 * `node ace config:import --app=shop --file=.env.production` (or piped on stdin): every variable
 * becomes an entry (`RESEND_API_KEY` → `resend.api.key`), in ONE new version. Names matching
 * `--secrets` are stored as secrets. Values are kept as text, exactly as the environment had them.
 * Prints names and counts only, never a value.
 */
export default class ConfigImport extends ConfigCommand {
  static override commandName = 'config:import';
  static override description =
    'Import env variables (a .env file, JSON, or stdin) as entries, in one version';

  @flags.string({ description: 'Read from this file instead of stdin (.env or JSON)' })
  declare file?: string;

  @flags.string({
    description: `Regex of env names stored as secrets. Default: ${DEFAULT_SECRET_PATTERN}`,
  })
  declare secrets?: string;

  @flags.string({ description: 'Regex of env names to leave out' })
  declare skip?: string;

  @flags.string({ description: 'Why: recorded in the audit trail' })
  declare message?: string;

  @flags.boolean({ description: 'List what would be imported, write nothing' })
  declare dryRun: boolean;

  override async run(): Promise<void> {
    const text = this.file !== undefined ? await readFile(this.file, 'utf8') : await readStdin();
    const variables = parseImport(text);
    const secretRe = new RegExp(this.secrets ?? DEFAULT_SECRET_PATTERN);
    const skipRe = this.skip !== undefined ? new RegExp(this.skip) : null;
    const entries: Array<{ key: string; value: string; secret: boolean; name: string }> = [];
    const skipped: string[] = [];
    for (const [name, value] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (skipRe && skipRe.test(name))) {
        skipped.push(name);
        continue;
      }
      entries.push({ name, key: keyFromEnvName(name), value, secret: secretRe.test(name) });
    }
    const scope = await this.scope();
    let version: number | null = null;
    if (!this.dryRun) {
      const result = await this.admin.setEntries(
        scope,
        entries.map(({ key, value, secret }) => ({ key, value, secret })),
        { actor: cliActor(), message: this.message ?? 'config:import' },
      );
      version = result.version;
    }
    const summary = {
      app: scope.app,
      environment: scope.environment,
      version,
      imported: entries.map((e) => ({ name: e.name, key: e.key, secret: e.secret })),
      skipped,
    };
    const secretCount = entries.filter((e) => e.secret).length;
    this.output(summary, () => {
      this.logger.info(
        `${this.dryRun ? 'would import' : 'imported'} ${entries.length} variables into ${scope.app}/${scope.environment}` +
          `${version !== null ? ` (v${version})` : ''}: ${secretCount} secrets, ${entries.length - secretCount} plain` +
          `${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
      );
      for (const e of entries) this.logger.log(`  ${e.secret ? '🔒' : '  '} ${e.name} → ${e.key}`);
    });
  }
}
