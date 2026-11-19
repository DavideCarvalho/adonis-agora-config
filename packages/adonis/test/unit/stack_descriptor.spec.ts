import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineConfig, stores } from '../../src/define_config.js';
import { STACK_DESCRIPTOR } from '../../src/stack.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { transports } from '../../src/transports/index.js';

const appConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@adonisjs/core/services/app', () => ({
  default: { config: { get: (key: string) => appConfig.current[key] } },
}));

const uses = (value: object) => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];
const database = {
  connection: 'pg',
  connections: { pg: { client: 'pg' }, lite: { client: 'better-sqlite3' } },
};

afterEach(() => {
  appConfig.current = {};
});

describe('stack descriptors', () => {
  it('names the Lucid connection of the store, not enumerable', () => {
    appConfig.current = { database };
    expect(STACK_DESCRIPTOR).toBe(Symbol.for('@adonis-agora/stack'));
    expect(uses(stores.lucid())).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'configuration' },
    ]);
    expect(uses(stores.lucid({ connection: 'lite' }))).toEqual([
      { tech: 'sqlite', connection: 'lite', purpose: 'configuration' },
    ]);
    expect(Object.keys(stores.lucid())).toEqual([]);
    expect(uses(stores.memory())).toBeUndefined();
  });

  it('describes the default store on the defineConfig result', () => {
    appConfig.current = { database };
    expect(uses(defineConfig({ app: 'shop' }))).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'configuration' },
    ]);
    expect(
      uses(
        defineConfig({
          topology: 'control-plane',
          verifyTenant: sharedSecretVerifier({ partitions: { shop: 's' } }),
        }),
      ),
    ).toEqual([{ tech: 'postgres', connection: 'pg', purpose: 'configuration' }]);
    expect(uses(defineConfig({ app: 'shop', store: stores.memory() }))).toEqual([]);
    expect(
      uses(
        defineConfig({
          topology: 'tenant',
          tenant: { url: 'https://config.example.com/_config', partition: 'shop', token: 't' },
        }),
      ),
    ).toEqual([]);
  });

  it('describes nothing by default without a database config', () => {
    expect(uses(defineConfig({ app: 'shop' }))).toEqual([]);
  });

  it('names the Redis connection of the redis transport (default main)', () => {
    expect(uses(transports.redis())).toEqual([
      { tech: 'redis', connection: 'main', purpose: 'change feed' },
    ]);
    expect(uses(transports.redis({ connection: 'bus' }))).toEqual([
      { tech: 'redis', connection: 'bus', purpose: 'change feed' },
    ]);
    expect(uses(transports.redis({ client: {} as never }))).toBeUndefined();
  });
});
