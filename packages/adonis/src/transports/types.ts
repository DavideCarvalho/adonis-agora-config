import type { ConfigDocumentView, ConfigScope } from '@adonis-agora/config-core';

/** The application surface a transport factory may resolve an optional peer from. */
export interface ConfigTransportContext {
  app: {
    container: {
      make(token: unknown): Promise<unknown>;
      hasBinding?(token: unknown): boolean;
    };
    config: { get<T>(key: string, fallback?: T): T };
  };
}

/**
 * How a tenant and a control plane talk. `http` is the default and keeps today's behavior; the other
 * drivers provide the **watch** channel (a value-free "changed" notification; the tenant fetches the
 * document over HTTP, authenticated). Browsers, the console and every public endpoint always use the
 * control plane's HTTP API, whatever transport the tenants use.
 */
export interface ConfigTransport {
  kind: 'http' | 'redis' | 'durable';
  /** Overrides the control-plane URL (`transports.http({ url })`). */
  url?: string;
  /** Replaces the global fetch (proxy, mTLS, crypto envelope, tests). */
  fetch?: typeof fetch;
  /** Timeout for the HTTP fetch, in ms. */
  timeoutMs?: number;
  /** Control plane: announce a new version, with the masked document for a broker snapshot. */
  publish?(scope: ConfigScope, version: number, snapshot: ConfigDocumentView): Promise<void>;
  /** Tenant: receive "changed" notifications; returns a stop function. */
  watch?(scope: ConfigScope, onChanged: (version: number) => void): Promise<() => void>;
  /** Tenant: last masked document kept by the broker (a boot fallback when there is no local one). */
  snapshot?(scope: ConfigScope): Promise<ConfigDocumentView | null>;
}

/** A lazy transport factory, like durable's `transports.*`. Peer deps load only when selected. */
export type ConfigTransportFactory = (context: ConfigTransportContext) => Promise<ConfigTransport>;
