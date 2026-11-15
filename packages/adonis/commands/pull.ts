import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfigClient } from '@adonis-agora/config-client';
import { type ConfigValue, DEFAULT_LABEL, envNameOf, envValueOf } from '@adonis-agora/config-core';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { ConfigAdmin } from '../src/admin.js';
import { ensureGitignore, hasEncryptedValues, upsertConfigBlock } from '../src/env_file.js';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import type { TenantTokenSource } from '../src/topology/token.js';
import { cliActor } from './shared.js';

/**
 * `node ace config:pull --application=shop --write=.env.local` — the bridge between the config
 * server and the shell/Sail:
 *
 * - on a control plane/standalone it reads the store directly;
 * - on a tenant it reuses what the app already fetched (local env included);
 * - with `--url`/`--remote` it fetches over HTTP, with a shared secret or authkit client credentials.
 *
 * Without `--write` it prints `KEY=value` lines, the same shape as `sail:info --env`. With
 * `--write` it owns only the `# config:start` … `# config:end` block: a key the file already sets
 * (Sail's per-worktree ports, a real environment variable) is skipped, so the local value wins.
 */
export default class ConfigPull extends BaseCommand {
  static override commandName = 'config:pull';
  static override description = 'Resolve a scope and print it as KEY=value, or write .env.local';
  static override options: CommandOptions = { startApp: true };

  @flags.string({
    description: 'Application (partition). Default: this app, else CONFIG_APP',
    alias: 'a',
  })
  declare application?: string;

  @flags.string({ description: 'Environment. Default: this process, else NODE_ENV' })
  declare environment?: string;

  @flags.string({ description: 'Label/profile. Default: main' })
  declare label?: string;

  @flags.string({ description: 'The control plane URL (overrides CONFIG_URL and forces HTTP)' })
  declare url?: string;

  @flags.string({ description: 'A shared secret (overrides CONFIG_TOKEN)' })
  declare token?: string;

  @flags.string({ description: 'authkit issuer (overrides AUTHKIT_ISSUER)' })
  declare issuer?: string;

  @flags.string({ description: 'authkit client id (overrides AUTHKIT_CLIENT_ID)' })
  declare clientId?: string;

  @flags.string({ description: 'authkit client secret (overrides AUTHKIT_CLIENT_SECRET)' })
  declare clientSecret?: string;

  @flags.string({ description: 'The token resource. Default urn:agora:config' })
  declare resource?: string;

  @flags.boolean({ description: 'Fetch over HTTP even when this process owns a store' })
  declare remote: boolean;

  @flags.string({ description: 'Write the values into this file (.env.local, .env.test.local, …)' })
  declare write?: string;

  @flags.string({ description: 'Prefix every variable (APP_ → APP_DB_PORT)' })
  declare prefix?: string;

  @flags.boolean({ description: 'Include secret values (the token needs config:secrets:read)' })
  declare secrets: boolean;

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  override async run(): Promise<void> {
    const runtime = hasRuntime() ? getRuntime() : undefined;
    const application = this.application ?? runtime?.app ?? process.env.CONFIG_APP;
    if (!application) {
      this.logger.error('pass --application (or CONFIG_APP)');
      this.exitCode = 1;
      return;
    }
    const environment =
      this.environment ?? runtime?.environment ?? process.env.NODE_ENV ?? 'production';
    const label = this.label ?? DEFAULT_LABEL;
    const scope = { app: application, environment, label };

    try {
      const { values, source } = await this.#resolve(runtime, scope);
      const env = Object.fromEntries(
        Object.entries(values)
          .map(([key, value]) => [envNameOf(key, this.prefix ?? ''), envValueOf(value)] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );

      if (this.write === undefined) {
        if (this.json) {
          process.stdout.write(`${JSON.stringify({ source, scope, env })}\n`);
        } else {
          for (const [key, value] of Object.entries(env)) this.logger.log(`${key}=${value}`);
        }
        return;
      }

      const relative = this.write.replace(/^\.\//, '');
      const file = this.app.makePath(relative);
      let existing = '';
      try {
        existing = await readFile(file, 'utf8');
      } catch {
        existing = '';
      }
      if (hasEncryptedValues(existing)) {
        this.logger.error(
          `${relative} holds varlock ciphertext; writing plaintext next to it would corrupt the file. Run without --write and pipe the KEY=value lines into your secret manager.`,
        );
        this.exitCode = 1;
        return;
      }
      const result = upsertConfigBlock(existing, env, {
        note: 'Sail per-worktree ports, for example',
      });
      if (result.content !== existing) await writeFile(file, result.content);
      const gitignore = await this.#gitignore(relative, file);
      if (this.json) {
        process.stdout.write(
          `${JSON.stringify({
            source,
            scope,
            file: relative,
            added: result.added,
            skipped: result.skipped,
            gitignore,
          })}\n`,
        );
        return;
      }
      this.logger.success(
        `${relative}: wrote ${result.added.length} key(s) from ${source}${result.skipped.length > 0 ? `, kept ${result.skipped.length} local one(s)` : ''}`,
      );
      if (result.skipped.length > 0) {
        this.logger.info(`local values kept: ${result.skipped.join(', ')}`);
      }
      if (gitignore === 'added') this.logger.info(`added ${relative} to .gitignore`);
      if (result.added.length === 0) {
        this.logger.info('nothing to add: every key is already set outside the managed block');
      }
    } catch (error) {
      this.logger.error((error as Error).message);
      this.exitCode = 1;
    }
  }

  /** Where the values come from: the store, the running tenant, or an HTTP fetch. */
  async #resolve(
    runtime: ReturnType<typeof getRuntime> | undefined,
    scope: { app: string; environment: string; label: string },
  ): Promise<{ values: Record<string, ConfigValue>; source: 'store' | 'tenant' | 'remote' }> {
    const sameAsTenant =
      runtime?.topology === 'tenant' &&
      this.url === undefined &&
      this.remote !== true &&
      runtime.app === scope.app &&
      runtime.environment === scope.environment;
    if (sameAsTenant && runtime) {
      return { values: runtime.all(), source: 'tenant' };
    }
    const localStore =
      runtime?.store && this.url === undefined && this.remote !== true ? runtime.store : undefined;
    if (localStore) {
      const admin = new ConfigAdmin({ store: localStore });
      return {
        values: await admin.values(scope, this.secrets === true, {
          ...(this.secrets === true ? { reveal: { actor: cliActor() } } : {}),
        }),
        source: 'store',
      };
    }

    const url = this.url ?? process.env.CONFIG_URL ?? runtime?.client?.url;
    if (!url) {
      throw new Error(
        'no control plane URL: pass --url, set CONFIG_URL, or run inside a tenant that has one',
      );
    }
    const token = await this.#token();
    const client = createConfigClient({
      url,
      partition: scope.app,
      environment: scope.environment,
      label: scope.label,
      token,
    });
    await client.refresh();
    const status = client.status();
    if (status.lastError !== null) throw new Error(status.lastError);
    return { values: client.values(), source: 'remote' };
  }

  /** A shared secret, or `authkitTenantToken` from authkit-client for the issuer client. */
  async #token(): Promise<TenantTokenSource> {
    const shared = this.token ?? process.env.CONFIG_TOKEN;
    if (shared) return shared;
    const issuer = this.issuer ?? process.env.AUTHKIT_ISSUER;
    const clientId = this.clientId ?? process.env.AUTHKIT_CLIENT_ID ?? process.env.CONFIG_CLIENT_ID;
    const clientSecret =
      this.clientSecret ?? process.env.AUTHKIT_CLIENT_SECRET ?? process.env.CONFIG_CLIENT_SECRET;
    if (!issuer || !clientId || !clientSecret) {
      throw new Error(
        'no token: pass --token/CONFIG_TOKEN, or --issuer/--client-id/--client-secret (AUTHKIT_ISSUER, AUTHKIT_CLIENT_ID, AUTHKIT_CLIENT_SECRET)',
      );
    }
    let authkit: { authkitTenantToken?: (input: Record<string, unknown>) => TenantTokenSource };
    try {
      authkit = (await import('@adonis-agora/authkit-client')) as never;
    } catch {
      throw new Error(
        'the authkit flags need @adonis-agora/authkit-client installed, or pass --token',
      );
    }
    if (typeof authkit.authkitTenantToken !== 'function') {
      throw new Error(
        '@adonis-agora/authkit-client has no authkitTenantToken(); upgrade it or pass --token',
      );
    }
    return authkit.authkitTenantToken({
      issuer,
      clientId,
      clientSecret,
      resource: this.resource ?? 'urn:agora:config',
    });
  }

  /** Keeps a written env file out of git. Returns what it did. */
  async #gitignore(
    relative: string,
    file: string,
  ): Promise<'added' | 'present' | 'outside' | 'failed'> {
    if (!file.startsWith(this.app.makePath())) return 'outside';
    const path = join(this.app.makePath(), '.gitignore');
    try {
      let content = '';
      try {
        content = await readFile(path, 'utf8');
      } catch {
        content = '';
      }
      const result = ensureGitignore(content, relative);
      if (!result.changed) return 'present';
      await writeFile(path, result.content);
      return 'added';
    } catch {
      return 'failed';
    }
  }
}
