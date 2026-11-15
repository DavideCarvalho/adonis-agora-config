import { fileURLToPath } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { ConfigAdmin } from '../src/admin.js';
import { type SecretCodec, secretCodec } from '../src/crypto/secrets.js';
import { ConfigConsole } from '../src/dashboard/console.js';
import {
  type ConsoleAuthorizeDecision,
  resolveConsoleAuthorize,
} from '../src/dashboard/console_authorize.js';
import {
  configConsoleSearch,
  readAgoraConsoles,
  registerAgoraConsole,
} from '../src/dashboard/console_switcher.js';
import {
  type ResolvedConsoleConfig,
  resolveConsoleConfig,
} from '../src/dashboard/define_config.js';
import {
  type ConfigConfig,
  type ControlPlaneConfig,
  type FactoryContext,
  type SecretsConfig,
  type StandaloneConfig,
  stores,
  type TenantTopologyConfig,
} from '../src/define_config.js';
import { registerConfigDevTools } from '../src/dev_tools.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { agoraDoctorChecks } from '../src/doctor/checks.js';
import { ControlPlane } from '../src/http/control_plane.js';
import type { ConfigRuntime } from '../src/runtime.js';
import { setRuntime } from '../src/services/accessor.js';
import { inSchema, type SqlDatabase } from '../src/sql.js';
import type { ConfigStore } from '../src/store/store.js';
import {
  createTenantClient,
  type TenantClient,
  takeTenantBootstrap,
  tenantBootstrapKey,
} from '../src/topology/tenant_client.js';
import { resolveTenantVerifier } from '../src/topology/verify.js';

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'agora.config': ConfigRuntime;
  }
}

/** This console's id in the `'agora.consoles'` registry. */
export const CONSOLE_ID = 'config';

/** The built console (`dist/assets/spa`), resolved from `dist/providers/config_provider.js`. */
function spaDirectory(): string {
  return fileURLToPath(new URL('../assets/spa/', import.meta.url));
}

/**
 * Builds the config runtime from `config/config.ts` and publishes it as `'agora.config'` and as
 * `services/main`.
 *
 * - **control plane**: mounts the tenant API under `/_config/v1`, the console (SPA + JSON API)
 *   under `/_config` and the dev tools; registers the `agora:doctor` checks.
 * - **tenant**: loads the configuration before the first request, keeps it fresh and emits the
 *   reload/restart events.
 * - **standalone**: own scope, console, commands; no tenant API.
 *
 * The tenant's values reach `config/*.ts` only through `@adonis-agora/config/bootstrap` in
 * `bin/server.ts`, because config files load before any provider boots.
 */
export default class ConfigProvider {
  #runtime: ConfigRuntime | undefined;
  #building: Promise<ConfigRuntime> | undefined;
  #admin: ConfigAdmin | undefined;
  #console: ConfigConsole | undefined;
  #consoleConfig: ResolvedConsoleConfig | undefined;

  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton('agora.config', () => this.#build());
  }

  #config(): ConfigConfig {
    const config = this.app.config.get<ConfigConfig | undefined>('config');
    if (!config) {
      throw new Error('config/config.ts is missing (node ace configure @adonis-agora/config)');
    }
    return config;
  }

  #build(): Promise<ConfigRuntime> {
    this.#building ??= this.#doBuild();
    return this.#building;
  }

  async #doBuild(): Promise<ConfigRuntime> {
    const config = this.#config();
    const environment = config.environment ?? this.#nodeEnvironment();
    const logger = await this.#logger();
    if (config.topology === 'tenant') return this.#tenant(config, environment, logger);
    return this.#server(config, environment, logger);
  }

  async #tenant(
    config: TenantTopologyConfig,
    environment: string,
    logger: { info(message: string): void; warn(message: string): void },
  ): Promise<ConfigRuntime> {
    const resolved = {
      environment: config.tenant.environment ?? environment,
      label: config.tenant.label,
    };
    const key = tenantBootstrapKey({
      url: config.tenant.url,
      partition: config.tenant.partition,
      environment: resolved.environment,
      ...(resolved.label ? { label: resolved.label } : {}),
    });
    const bootstrapped = takeTenantBootstrap(key);
    const client: TenantClient =
      bootstrapped ??
      createTenantClient({
        url: config.tenant.url,
        partition: config.tenant.partition,
        token: config.tenant.token,
        environment: resolved.environment,
        ...(resolved.label ? { label: resolved.label } : {}),
        ...(config.tenant.snapshotPath ? { snapshotPath: config.tenant.snapshotPath } : {}),
        ...(config.tenant.stream !== undefined ? { stream: config.tenant.stream } : {}),
        ...(config.tenant.intervalMs !== undefined ? { intervalMs: config.tenant.intervalMs } : {}),
        ...(config.tenant.required !== undefined ? { required: config.tenant.required } : {}),
        ...(config.tenant.reloadable ? { reloadable: config.tenant.reloadable } : {}),
        ...(config.tenant.env !== undefined ? { env: config.tenant.env } : {}),
        // Sail and every other local env source win outside production: `sail:sync-env` writes the
        // worktree's ports to `.env.local`, and the config server must not shadow them in dev.
        localEnv: config.tenant.localEnv ?? this.#nodeEnvironment() !== 'production',
        logger,
      });
    if (!bootstrapped) await client.start();
    client.onChange((change) => {
      if (change.reloadable.length > 0) {
        logger.info(
          `[@adonis-agora/config] hot-reloaded ${change.reloadable.length} key(s): ${change.reloadable.join(', ')}`,
        );
      }
      if (change.restartRequired.length > 0) {
        logger.warn(
          `[@adonis-agora/config] restart required for ${change.restartRequired.length} key(s): ${change.restartRequired.join(', ')}`,
        );
      }
      void this.#emit(change);
    });
    const status = client.status();
    if (status.source === 'snapshot') {
      logger.warn(
        `[@adonis-agora/config] ${status.app}: booted from the snapshot at v${status.version} (${status.lastError ?? 'server unreachable'})`,
      );
    }
    const runtime: ConfigRuntime = {
      topology: 'tenant',
      environment: status.environment,
      app: status.app,
      client,
      secrets: false,
      localEnv: status.localEnv,
      get: (k, fallback) => client.get(k, fallback),
      all: () => client.values(),
      status: () => client.status(),
    };
    this.#runtime = runtime;
    setRuntime(runtime);
    return runtime;
  }

  async #server(
    config: StandaloneConfig | ControlPlaneConfig,
    environment: string,
    logger: { info(message: string): void; warn(message: string): void },
  ): Promise<ConfigRuntime> {
    const container = this.app.container;
    const codec = this.#secretCodec(config.secrets);
    const autoCreateSchema = config.autoCreateSchema ?? true;
    const factoryContext: FactoryContext = {
      app: this.app,
      autoCreateSchema,
      ...(codec ? { secretCodec: codec } : {}),
      async db(connection?: string) {
        if (!container.hasBinding('lucid.db')) {
          throw new Error(
            '[@adonis-agora/config] the lucid store needs @adonisjs/lucid configured, or set `store: stores.memory()`',
          );
        }
        const db = (await container.make('lucid.db')) as unknown as {
          connection(name?: string): SqlDatabase;
        };
        return inSchema(db.connection(connection), (config as { schema?: string }).schema);
      },
    };
    const store: ConfigStore = await (config.store ?? stores.lucid())(factoryContext);
    await store.setup?.();

    const app = config.topology === 'standalone' ? config.app : '';
    const consoleConfig = resolveConsoleConfig(config.console, { environment });

    let controlPlane: ControlPlane | undefined;
    if (config.topology === 'control-plane') {
      const verifyTenant = await resolveTenantVerifier(config.verifyTenant);
      controlPlane = new ControlPlane({
        store,
        verifyTenant,
        environment,
        ...(config.prefix ? { prefix: config.prefix } : {}),
        ...(config.corsOrigins ? { corsOrigins: config.corsOrigins } : {}),
        ...(config.vault ? { vault: config.vault.resolve } : {}),
        logger,
      });
    }
    const admin = new ConfigAdmin({
      store,
      canRevealSecrets: consoleConfig.revealSecrets,
      ...(config.vault ? { vault: config.vault.resolve } : {}),
      // Every write (console, MCP, command) reaches the streams of this process immediately; another
      // replica catches up on the stream's own 15s version poll.
      ...(controlPlane
        ? { onChange: (scope, version) => controlPlane!.bus.publish(scope, version) }
        : {}),
    });
    this.#admin = admin;
    this.#consoleConfig = consoleConfig;
    logger.info(
      `[@adonis-agora/config] ${config.topology ?? 'standalone'} on ${environment}${controlPlane ? ` at ${config.topology === 'control-plane' ? (config.prefix ?? '/_config') : ''}/v1` : ''}`,
    );
    const runtime: ConfigRuntime = {
      topology: config.topology ?? 'standalone',
      environment,
      app,
      store,
      ...(controlPlane ? { controlPlane } : {}),
      secrets: codec !== undefined,
      localEnv: false,
      get: (_key, fallback) => fallback,
      all: () => ({}),
      status: () => undefined,
    };
    this.#runtime = runtime;
    setRuntime(runtime);
    return runtime;
  }

  #secretCodec(secrets: SecretsConfig | undefined): SecretCodec | undefined {
    if (secrets?.codec) return secrets.codec;
    const configured =
      typeof secrets?.key === 'function' ? secrets.key() : (secrets?.key ?? process.env.APP_KEY);
    return configured ? secretCodec(configured) : undefined;
  }

  #nodeEnvironment(): string {
    const environment = this.app.nodeEnvironment;
    if (environment === 'test') return 'test';
    return environment && environment !== 'unknown' ? environment : 'production';
  }

  async #logger(): Promise<{ info(message: string): void; warn(message: string): void }> {
    try {
      const logger = (await this.app.container.make('logger')) as {
        info(message: string): void;
        warn(message: string): void;
      };
      return logger;
    } catch {
      return { info: () => {}, warn: () => {} };
    }
  }

  /** Emits `config:reloaded` / `config:restart-required` on the app's emitter, when there is one. */
  async #emit(change: unknown): Promise<void> {
    try {
      const emitter = (await this.app.container.make('emitter')) as unknown as {
        emit(event: string, data: unknown): Promise<void> | void;
      };
      const payload = change as { reloadable: string[]; restartRequired: string[] };
      if (payload.reloadable.length > 0) await emitter.emit('config:reloaded', change);
      if (payload.restartRequired.length > 0) {
        await emitter.emit('config:restart-required', change);
      }
    } catch {
      // No emitter (ace commands, tests): the log line is the record.
    }
  }

  /** The console's resolved gate, also used by the switcher and the dev tools. */
  async #authorize(ctx: HttpContext): Promise<ConsoleAuthorizeDecision> {
    const configured = this.#consoleConfig?.authorize;
    if (configured) return resolveConsoleAuthorize(configured)(ctx);
    return this.app.inProduction
      ? { allowed: false, status: 403, reason: 'forbidden' }
      : { allowed: true };
  }

  async #mountConsole(logger: {
    warn(message: string): void;
    info(message: string): void;
  }): Promise<void> {
    const config = this.#consoleConfig;
    const admin = this.#admin;
    if (!config || !admin || !config.enabled) return;
    const registry = await readAgoraConsoles(this.app.container);
    const environment = this.#runtime?.environment ?? 'production';
    const console = new ConfigConsole({
      admin,
      config,
      spaDir: spaDirectory(),
      environment,
      ...(this.#runtime?.app ? { defaultApp: this.#runtime.app } : {}),
      inProduction: this.app.inProduction,
      ...(registry ? { registry } : {}),
      secrets: this.#runtime?.secrets ?? false,
      topology: this.#runtime?.topology === 'standalone' ? 'standalone' : 'control-plane',
      logger,
    });
    this.#console = console;
    if (!config.authorize) {
      logger.warn(
        '[@adonis-agora/config] the console has no `authorize`: it is open outside production and denies every request in production. Set `console.authorize` in config/config.ts.',
      );
    }
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      console.register(router as never);
    });
    logger.info(
      `[@adonis-agora/config] console at ${config.path === '' ? '/' : config.path} (API ${config.api})`,
    );
  }

  async #registerConsole(logger: { warn(message: string): void }): Promise<void> {
    const config = this.#consoleConfig;
    if (!config?.enabled) return;
    const path = config.path === '' ? '/' : config.path;
    const defaults = {
      app: this.#runtime?.app ?? '',
      environment: this.#runtime?.environment ?? 'production',
      label: 'main',
    };
    await registerAgoraConsole(
      this.app.container,
      {
        id: CONSOLE_ID,
        title: 'Configuration',
        package: '@adonis-agora/config',
        icon: 'generic',
        path,
        order: 65,
        authorize: async (ctx) => {
          const decision = await this.#authorize(ctx);
          if (decision.allowed) return { allowed: true };
          if (decision.status === 302) {
            return { allowed: false, redirectTo: decision.redirectTo };
          }
          return { allowed: false, reason: decision.reason };
        },
        search: configConsoleSearch(
          async () => ({
            keys: (scope) =>
              this.#admin!.keys({
                app: scope.app || defaults.app,
                environment: scope.environment || defaults.environment,
                label: scope.label || defaults.label,
              }),
          }),
          config.path,
        ),
      },
      logger,
    );
  }

  async #registerDevTools(): Promise<void> {
    const admin = this.#admin;
    if (!admin) return;
    await registerConfigDevTools(this.app.container, {
      admin,
      authorize: async (ctx) => {
        const decision = await this.#authorize(ctx);
        if (decision.allowed) return { allowed: true };
        if (decision.status === 302) {
          return { allowed: false, reason: 'forbidden', redirectTo: decision.redirectTo };
        }
        return { allowed: false, reason: decision.reason };
      },
    });
  }

  async boot(): Promise<void> {
    const runtime = await this.#build();
    const logger = await this.#logger();
    await registerDoctorChecks(this.app.container, agoraDoctorChecks);
    if (runtime.topology !== 'tenant') {
      await this.#registerConsole(logger);
      await this.#mountConsole(logger);
      await this.#registerDevTools();
    }
    await this.app.booted(async () => {
      if (!runtime.controlPlane) return;
      const router = await this.app.container.make('router');
      runtime.controlPlane.register(router as never);
    });
  }

  async shutdown(): Promise<void> {
    await this.#runtime?.client?.stop();
    setRuntime(undefined);
    this.#runtime = undefined;
    this.#building = undefined;
    this.#admin = undefined;
    this.#console = undefined;
    this.#consoleConfig = undefined;
  }
}
