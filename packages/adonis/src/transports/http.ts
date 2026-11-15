import type { ConfigTransport, ConfigTransportFactory } from './types.js';

export interface HttpTransportConfig {
  /** Override the control-plane URL (default: `tenant.url`). */
  url?: string;
  /** A proxy, mTLS, a crypto envelope, or a test double. */
  fetch?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/**
 * The default: conditional GET over HTTP, SSE for push notifications (plus polling as a fallback).
 * Nothing to install; `fetch` and the URL already exist on the tenant.
 */
export function httpTransport(config: HttpTransportConfig = {}): ConfigTransportFactory {
  return async () => {
    const transport: ConfigTransport = { kind: 'http' };
    if (config.url !== undefined) transport.url = config.url;
    if (config.fetch !== undefined) transport.fetch = config.fetch;
    if (config.timeoutMs !== undefined) transport.timeoutMs = config.timeoutMs;
    return transport;
  };
}
