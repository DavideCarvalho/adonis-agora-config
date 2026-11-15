import type { ApplicationService } from '@adonisjs/core/types';
import { type SecretCodec, secretCodec } from '../src/crypto/secrets.js';
import {
  type ConfigConfig,
  type ControlPlaneConfig,
  type FactoryContext,
  type SecretsConfig,
  type StandaloneConfig,
  stores,
  type TenantTopologyConfig,
} from '../src/define_config.js';
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

/**
 * Builds the config runtime from `config/config.ts` and publishes it as `'agora.config'` and as
 * `services/main`. On a control plane it mounts the tenant API under `/_config/v1`; on a tenant it
 * loads the configuration before the first request and keeps it fresh.
 *
 * The tenant's values reach `config/*.ts` only through the bootstrap entry (`@adonis-agora/config/bootstrap`
 * in `bin/server.ts`), because config files load before any provider boots. Without it the values
 * arrive at boot and are available to controllers and services, but not to the config files.
 */
export default class ConfigProvider {
  #runtime: ConfigRuntime | undefined;
  #building: Promise<ConfigRuntime> | undefined;

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
    const nodeEnvironment = this.#nodeEnvironment();
    const environment = config.environment ?? nodeEnvironment;
    const logger = await this.#logger();

    if (config.topology === 'tenant') {
      return this.#tenant(config, environment, logger);
    }
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
      get: (key, fallback) => client.get(key, fallback),
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
    const app = config.topology === 'standalone' ? config.app : '';
    logger.info(
      `[@adonis-agora/config] ${config.topology} on ${environment}${config.topology === 'control-plane' ? ` at ${config.prefix ?? '/_config'}/v1` : ''}`,
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

  async boot(): Promise<void> {
    const runtime = await this.#build();
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
  }
}
