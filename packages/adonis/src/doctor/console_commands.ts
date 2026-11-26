import type { ApplicationService } from '@adonisjs/core/types';
import { appKeyOf } from '../app_key.js';
import { resolveConsoleConfig } from '../dashboard/define_config.js';
import type { ConfigConfig } from '../define_config.js';
import { consoleCommandKeys } from '../federation/console.js';
import {
  CONSOLE_AUTH_DOCS,
  ConsoleAuthConfigError,
  type ConsoleSiblings,
  classifyConsoleKeyError,
  consoleSiblingsOf,
  isForbidden,
  type ResolvedConsoleAuth,
  resolveAppConsoleAuth,
  resolveFederatedAppAuth,
} from '../federation/console_auth.js';
import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  RedisConsoleChannel,
} from '../federation/redis_channel.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

/**
 * `agora:doctor` → how this app authenticates console commands, resolved exactly like the boot:
 * `config.console-commands` (the mode on each side; an error where the web process would refuse to
 * boot) and the deep `config.console-commands-key` (in crypto mode, that the key exists and this
 * process can use it: it encrypts, and where it may, decrypts a probe).
 */

const PROBE_AAD = 'agora:doctor:console-commands';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One side, resolved: the app (`consoleCommands`) or one `federatedApps` entry. */
type Side =
  | { kind: 'app'; auth: ResolvedConsoleAuth; actions: boolean }
  | { kind: 'console'; id: string; partition: string; auth: ResolvedConsoleAuth | 'channel' }
  | { kind: 'error'; result: AgoraDoctorResult };

async function sides(
  app: ApplicationService,
): Promise<{ sides: Side[]; siblings: ConsoleSiblings } | AgoraDoctorResult> {
  const config = app.config.get<ConfigConfig | undefined>('config');
  if (!config || config.topology === 'tenant') {
    return {
      status: 'skip',
      message: 'A config tenant neither sends nor answers console commands.',
    };
  }
  const consoleConfig = resolveConsoleConfig(config.console, {
    environment: config.environment ?? 'production',
  });
  const entries = consoleConfig.enabled ? Object.entries(consoleConfig.federatedApps ?? {}) : [];
  if (!config.consoleCommands && entries.length === 0) {
    return { status: 'skip', message: 'No consoleCommands and no console.federatedApps.' };
  }
  let siblings: ConsoleSiblings;
  try {
    siblings = await consoleSiblingsOf(app.container);
  } catch (error) {
    return {
      status: 'error',
      message: message(error),
      fix: 'Fix the config of the lib named above (config/crypto.ts or config/authkit.ts) so it boots.',
      docs: CONSOLE_AUTH_DOCS,
    };
  }
  const out: Side[] = [];
  if (config.consoleCommands) {
    const appKey = await appKeyOf(app);
    try {
      out.push({
        kind: 'app',
        actions: config.consoleCommands.actions === true,
        auth: resolveAppConsoleAuth({
          options: config.consoleCommands,
          fallbackVerifyTenant:
            config.topology === 'control-plane' ? config.verifyTenant : undefined,
          hasAppKey: appKey !== undefined,
          ...(appKey
            ? {
                commandKeyId: consoleCommandKeys(
                  appKey,
                  config.consoleCommands.prefix,
                ).publicKey.kid.slice(0, 8),
              }
            : {}),
          siblings,
        }),
      });
    } catch (error) {
      if (!(error instanceof ConsoleAuthConfigError)) throw error;
      out.push({
        kind: 'error',
        result: {
          status: 'error',
          message:
            'consoleCommands is on but unauthenticated: the web process will refuse to boot.',
          fix: 'Install @adonis-agora/crypto (automatic), or set consoleCommands.secret, or consoleCommands.verifyTenant (authkit, with an APP_KEY).',
          docs: CONSOLE_AUTH_DOCS,
        },
      });
    }
  }
  for (const [id, entry] of entries) {
    const partition = entry.partition ?? id;
    if (entry.controlPlane instanceof RedisConsoleChannel) {
      out.push({ kind: 'console', id, partition, auth: 'channel' });
      continue;
    }
    try {
      out.push({
        kind: 'console',
        id,
        partition,
        auth: resolveFederatedAppAuth({
          id,
          partition,
          actions: entry.actions !== false,
          controlPlane: entry.controlPlane,
          siblings,
        }),
      });
    } catch (error) {
      if (!(error instanceof ConsoleAuthConfigError)) throw error;
      out.push({
        kind: 'error',
        result: {
          status: 'error',
          message: `"${id}" may act but its commands are unauthenticated: the web process will refuse to boot.`,
          fix: `Boot @adonis-agora/crypto here (automatic), or set federatedApps.${id}.controlPlane.secret or .token, or actions: false.`,
          docs: CONSOLE_AUTH_DOCS,
        },
      });
    }
  }
  return { sides: out, siblings };
}

/** `config.console-commands`: the mode each side resolved, as the boot log says it. */
export const consoleCommandsCheck: AgoraDoctorCheck = {
  id: 'config.console-commands',
  lib: 'config',
  title: 'Console commands',
  cost: 'cheap',
  run: async (app): Promise<AgoraDoctorResult | AgoraDoctorResult[]> => {
    const resolved = await sides(app);
    if (!('sides' in resolved)) return resolved;
    return resolved.sides.flatMap((side): AgoraDoctorResult | AgoraDoctorResult[] => {
      if (side.kind === 'error') return side.result;
      if (side.kind === 'app') {
        const line: AgoraDoctorResult = {
          status: 'ok',
          message: `console commands: ${side.auth.modes.join(' + ')}; ${side.actions ? 'actions on' : 'actions off (set consoleCommands.actions to let the console act)'}`,
        };
        // §13e: with crypto the token key is not published, and that is fine.
        if (side.auth.tokenMode && side.auth.crypto && side.auth.cryptoToken !== 'required') {
          return [
            line,
            {
              status: 'ok',
              message:
                "console commands: this app's token key is not published: crypto is enough to reach it.",
            },
          ];
        }
        // The same sentence as the boot log.
        return {
          status: 'ok',
          message: `console commands: ${side.auth.modes.join(' + ')}; ${side.actions ? 'actions on' : 'actions off (set consoleCommands.actions to let the console act)'}`,
        };
      }
      if (side.auth === 'channel') {
        return {
          status: 'ok',
          message: `console commands to "${side.id}": a channel built in config/config.ts`,
        };
      }
      return {
        status: 'ok',
        message: `console commands to "${side.id}": ${side.auth.modes.join(' + ') || 'none (actions: false, browse only)'}`,
      };
    });
  },
};

async function cipherOf(auth: ResolvedConsoleAuth): Promise<ConsoleCipher | undefined> {
  const source = auth.crypto?.cipher;
  if (!source) return undefined;
  return typeof source === 'function' ? await source() : source;
}

/** `config.console-commands-key`: in crypto mode, that the key exists and this process can use it. */
export const consoleCommandsKeyCheck: AgoraDoctorCheck = {
  id: 'config.console-commands-key',
  lib: 'config',
  title: 'Console commands: the crypto key',
  cost: 'deep',
  run: async (app): Promise<AgoraDoctorResult | AgoraDoctorResult[]> => {
    const resolved = await sides(app);
    if (!('sides' in resolved)) return resolved;
    const crypto = resolved.siblings.crypto;
    const results: AgoraDoctorResult[] = [];
    for (const side of resolved.sides) {
      if (side.kind === 'error' || side.auth === 'channel' || !side.auth.crypto) continue;
      const auth = side.auth;
      const key = auth.crypto!.key ?? CONSOLE_CRYPTO_KEY;
      const partition = side.kind === 'console' ? side.partition : (crypto?.partition ?? '');
      const who = side.kind === 'app' ? 'this app' : `"${side.id}"`;
      const createLine = `node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}`;
      // An app on a crypto tenant asks `hasKey` when its crypto server offers it (§13f): no
      // probe, so nothing lands in the crypto audit as an error.
      const hasKey = crypto?.operations.hasKey;
      if (side.kind === 'app' && !crypto?.service && typeof hasKey === 'function') {
        let present: boolean | undefined;
        try {
          present = await hasKey.call(crypto!.operations, { key });
        } catch (error) {
          // forbidden: no permission; anything else (an older server): the probe below.
          if (isForbidden(error)) {
            results.push({
              status: 'error',
              message: `${who}: the crypto server refused this app on "${key}" in partition ${partition}: ${message(error)}`,
              fix: "Check this app's crypto token is valid and the crypto server is up to date (no grant is needed for an app's own console keys).",
              docs: CONSOLE_AUTH_DOCS,
            });
            continue;
          }
        }
        if (present !== undefined) {
          results.push({
            status: 'ok',
            message: present
              ? `${who}: "${key}" exists in partition ${partition}.`
              : `${who}: "${key}" does not exist in partition ${partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${createLine}).`,
          });
          continue;
        }
      }
      try {
        // Creates the key where crypto is embedded here (automatic mode), then probes it.
        const cipher = (await cipherOf(auth))!;
        const { ciphertext } = await cipher.encrypt({ key, plaintext: 'probe', aad: PROBE_AAD });
        let decrypted = false;
        const service = auth.autoCrypto ? crypto?.service : undefined;
        if (side.kind === 'app' || service) {
          const decrypt = (input: { key: string; ciphertext: string; aad?: string }) =>
            side.kind === 'app'
              ? cipher.decrypt(input)
              : service!.decrypt(
                  { partition, capabilities: [`crypto:decrypt:${key}`], actor: 'config:doctor' },
                  input,
                );
          const { plaintext } = await decrypt({ key, ciphertext, aad: PROBE_AAD });
          if (plaintext !== 'probe')
            throw new Error('the probe did not decrypt to what was encrypted');
          decrypted = true;
        }
        results.push({
          status: 'ok',
          message: `${who}: "${key}" ${decrypted ? 'encrypts and decrypts' : 'encrypts'} in partition ${partition}.`,
        });
      } catch (error) {
        // On a crypto tenant a missing key is expected: the server provisions it on the console's
        // first seal (unless its sealProvisioning is off).
        if (!crypto?.service && classifyConsoleKeyError(error) === 'missing') {
          results.push({
            status: 'ok',
            message: `${who}: "${key}" does not exist in partition ${partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${createLine}).`,
          });
          continue;
        }
        // An app on a crypto tenant may open its own console keys but not encrypt: it cannot probe.
        if (
          side.kind === 'app' &&
          !crypto?.service &&
          classifyConsoleKeyError(error) === 'refused'
        ) {
          results.push({
            status: 'ok',
            message: `${who}: this app opens its own console key but may not encrypt with it, so the probe cannot run.`,
          });
          continue;
        }
        results.push({
          status: 'error',
          message: `${who}: the key "${key}" does not work in partition ${partition}: ${message(error)}`,
          fix:
            side.kind === 'app'
              ? `Check this app's crypto token is valid and the crypto server is up to date (no grant is needed for an app's own console keys), or run \`${createLine}\` there if its sealProvisioning is off.`
              : `Run \`${createLine}\` on the crypto server, grant this app's crypto client crypto:seal:console-*, and check federatedApps.${side.id}.partition equals that app's crypto partition.`,
          docs: CONSOLE_AUTH_DOCS,
        });
      }
    }
    if (results.length === 0) {
      return { status: 'skip', message: 'No side uses crypto for console commands.' };
    }
    return results;
  },
};
