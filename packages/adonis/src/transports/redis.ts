import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type ConfigDocumentView,
  type ConfigScope,
  canonicalJson,
} from '@adonis-agora/config-core';
import { describeStackUse } from '../stack.js';
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
  /**
   * A secret the control plane and its tenants share (at least 16 characters). The control plane
   * signs each snapshot with it, and a tenant only boots from a snapshot whose signature checks out.
   * Without it a tenant never boots from a snapshot (the fallback when the control plane is down):
   * anyone who can write to Redis could otherwise hand it a configuration.
   */
  secret?: string | { release(): string };
}

/** HMAC over a snapshot and the scope it is for (so one scope's snapshot cannot serve another). */
function snapshotMac(key: Buffer, scope: ConfigScope, snapshot: unknown): string {
  return createHmac('sha256', key)
    .update(
      `config:snapshot\n${canonicalJson([scope.app, scope.environment, scope.label, snapshot] as never)}`,
    )
    .digest('base64url');
}

function snapshotKeyOf(secret: RedisTransportConfig['secret']): Buffer | undefined {
  if (secret === undefined) return undefined;
  const raw = typeof secret === 'string' ? secret : secret.release();
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new Error('config: transports.redis `secret` must be at least 16 characters');
  }
  return createHmac('sha256', raw).update('agora:config:redis-snapshot').digest();
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
  const factory: ConfigTransportFactory = async (ctx) => {
    const prefix = config.prefix ?? 'config';
    const ttl = config.snapshotTtlSeconds ?? 86_400;
    const client = await resolveRedis(ctx, config);
    const key = snapshotKeyOf(config.secret);

    const transport: ConfigTransport = {
      kind: 'redis',
      async publish(scope, version, snapshot) {
        // Signed when there is a secret; an unsigned one is still written (older tenants read it),
        // but a tenant of this version only boots from a signed one.
        const stored = key
          ? { signed: 1, snapshot, mac: snapshotMac(key, scope, snapshot) }
          : snapshot;
        await client.set(snapshotKey(prefix, scope), JSON.stringify(stored), 'EX', ttl);
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
        if (!key) return null;
        const raw = await client.get(snapshotKey(prefix, scope));
        if (typeof raw !== 'string') return null;
        try {
          const parsed = JSON.parse(raw) as { signed?: unknown; snapshot?: unknown; mac?: unknown };
          if (parsed?.signed !== 1 || typeof parsed.mac !== 'string') return null;
          const snapshot = parsed.snapshot as ConfigDocumentView;
          if (!snapshot || typeof snapshot !== 'object') return null;
          const expected = Buffer.from(snapshotMac(key, scope, snapshot));
          const actual = Buffer.from(parsed.mac);
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
          return snapshot;
        } catch {
          return null;
        }
      },
    };
    return transport;
  };
  // A raw `client` names no connection; otherwise the one resolved below (default `main`).
  return config.client
    ? factory
    : describeStackUse(factory, {
        tech: 'redis',
        connection: config.connection ?? 'main',
        purpose: 'change feed',
      });
}
