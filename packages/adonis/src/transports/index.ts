export {
  type DurableControlPlaneLike,
  type DurableTransportConfig,
  durableTransport,
} from './durable.js';
export { type HttpTransportConfig, httpTransport } from './http.js';
export { type RedisTransportConfig, redisTransport } from './redis.js';
export type {
  ConfigTransport,
  ConfigTransportContext,
  ConfigTransportFactory,
} from './types.js';

import { durableTransport } from './durable.js';
import { httpTransport } from './http.js';
import { redisTransport } from './redis.js';

/**
 * The transport namespace: pick how a tenant watches the control plane. `http` is the default;
 * `redis` and `durable` replace only the watch channel. Browsers and the console always use the
 * control plane's HTTP API.
 */
export const transports = {
  http: httpTransport,
  redis: redisTransport,
  durable: durableTransport,
};
