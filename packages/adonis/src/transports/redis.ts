import { randomUUID } from 'node:crypto';
import type { ConfigDocumentView, ConfigScope } from '@adonis-agora/config-core';
import type { ConfigTransport, ConfigTransportFactory } from './types.js';

/** The subscriber half of a raw ioredis client. */
interface RedisSubscriber {
  subscribe(channel: string): unknown;
  on?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(reconnect?: boolean): void;
}

/** A command connection: raw ioredis or an `@adonisjs/redis` connection. */
interface RedisClient {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  set(key: string, value: string, ...args: unknown[]): unknown;
  get(key: string): Promise<string | null> | string | null;
  duplicate?(): RedisSubscriber;
}

export interface RedisTransportConfig {
  /** `@adonisjs/redis` connection name (a key of `config/redis.ts`). Default `main`. */
  connection?: string;
  /** Channel/key prefix. Default `config`. */
  prefix?: string;
  /** Snapshot key TTL in seconds. Default one day. */
  snapshotTtlSeconds?: number;
  /** A raw ioredis client (or a test double); takes precedence over `connection`. */
  client?: RedisClient;
}

const encode = (part: string) => encodeURIComponent(part);
const changedChannel = (prefix: string, scope: ConfigScope) =>
  `${prefix}:${encode(scope.app)}:${encode(scope.environment)}:${encode(scope.label)}:changed`;
const snapshotKey = (prefix: string, scope: ConfigScope) =>
  `${prefix}:${encode(scope.app)}:${encode(scope.environment)}:${encode(scope.label)}:snapshot`;

const isRawClient = (
  client: RedisClient,
): client is RedisClient & { duplicate(): RedisSubscriber } =>
  typeof client.duplicate === 'function';

async function resolveRedis(
  ctx: { app: { container: { make(token: unknown): Promise<unknown> } } },
  config: RedisTransportConfig,
): Promise<RedisClient> {
  if (config.client) return config.client;
  // From the container, not `@adonisjs/redis/services/main`: that service is only filled once the
  // app has booted, and the control plane builds its transport while providers boot (an ace command
  // such as `migration:run` crashed on `service.connection` being undefined).
  const redis = (await ctx.app.container.make('redis')) as {
    connection(name?: string): RedisClient;
  };
  return redis.connection(config.connection ?? 'main');
}

/**
 * Redis pub/sub for the **watch** channel: the control plane publishes `changed v=N` on a per-scope
 * channel (never a value), writes a masked snapshot key, and tenants subscribe. The actual document
 * is still fetched over HTTP, with the tenant token — the broker is not a trust boundary and carries
 * no secrets.
 */
export function redisTransport(config: RedisTransportConfig = {}): ConfigTransportFactory {
  return async (ctx) => {
    const prefix = config.prefix ?? 'config';
    const ttl = config.snapshotTtlSeconds ?? 86_400;
    const client = await resolveRedis(ctx, config);

    const transport: ConfigTransport = {
      kind: 'redis',
      async publish(scope, version, snapshot) {
        await client.set(snapshotKey(prefix, scope), JSON.stringify(snapshot), 'EX', ttl);
        await client.publish(
          changedChannel(prefix, scope),
          JSON.stringify({
            id: randomUUID(),
            app: scope.app,
            environment: scope.environment,
            label: scope.label,
            version,
            at: new Date().toISOString(),
          }),
        );
      },
      async watch(scope, onChanged) {
        const channel = changedChannel(prefix, scope);
        const handle = (payload: string) => {
          let message: { app?: unknown; environment?: unknown; label?: unknown; version?: unknown };
          try {
            message = JSON.parse(payload) as typeof message;
          } catch {
            return;
          }
          if (
            message.app === scope.app &&
            message.environment === scope.environment &&
            message.label === scope.label &&
            typeof message.version === 'number'
          ) {
            onChanged(message.version);
          }
        };
        if (isRawClient(client)) {
          const subscriber = client.duplicate();
          void subscriber.subscribe(channel);
          subscriber.on?.('message', (_name, payload) => handle(payload));
          return () => subscriber.disconnect?.(false);
        }
        void client.subscribe(channel, handle);
        // `@adonisjs/redis` owns its subscriber connection; there is no public unsubscribe.
        return () => {};
      },
      async snapshot(scope) {
        const raw = await client.get(snapshotKey(prefix, scope));
        if (typeof raw !== 'string') return null;
        try {
          const parsed = JSON.parse(raw) as ConfigDocumentView;
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      },
    };
    return transport;
  };
}
