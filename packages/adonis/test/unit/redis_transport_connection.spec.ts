import { describe, expect, it } from 'vitest';
import { redisTransport } from '../../src/transports/redis.js';

/**
 * `transports.redis({ connection })` takes the connection from the app container, so it works while
 * providers boot (an ace command such as `migration:run` builds the control plane's transport before
 * `@adonisjs/redis/services/main` is filled).
 */
function fakeApp() {
  const used: string[] = [];
  const published: string[] = [];
  const manager = {
    connection(name = 'main') {
      used.push(name);
      return {
        async set() {
          return 'OK';
        },
        async publish(channel: string) {
          published.push(channel);
          return 1;
        },
        subscribe() {},
      };
    },
  };
  const app = {
    container: {
      async make(token: unknown) {
        if (token !== 'redis') throw new Error(`unexpected binding ${String(token)}`);
        return manager;
      },
    },
  };
  return { app, used, published };
}

describe('transports.redis connection', () => {
  it('resolves the named connection from the container', async () => {
    const { app, used, published } = fakeApp();
    const transport = await redisTransport({ connection: 'agora_bus' })({ app } as never);
    await transport.publish(
      { app: 'shop', environment: 'production', label: 'main' },
      3,
      {} as never,
    );
    expect(used).toEqual(['agora_bus']);
    expect(published).toHaveLength(1);
  });

  it('defaults to the main connection', async () => {
    const { app, used } = fakeApp();
    await redisTransport()({ app } as never);
    expect(used).toEqual(['main']);
  });
});
