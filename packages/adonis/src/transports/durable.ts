import { randomUUID } from 'node:crypto';
import type { ConfigScope } from '@adonis-agora/config-core';
import type { ConfigTransport, ConfigTransportFactory } from './types.js';

/** The slice of `@adonis-agora/durable`'s `ControlPlane` this transport uses (structural). */
export interface DurableControlPlaneLike {
  publishControl(message: unknown): Promise<void> | void;
  onControl(handler: (message: unknown) => void): void;
}

export interface DurableTransportConfig {
  /** The durable control plane to fan out over (`controlPlanes.redis(...)`, the engine's, a fake). */
  controlPlane: DurableControlPlaneLike;
  /** Stable publisher id, for the durable control-plane echo. Default `config`. */
  from?: string;
}

const EVENT = 'config.changed';

interface ConfigChangedEvent {
  type: typeof EVENT;
  at: Date;
  output: {
    id: string;
    app: string;
    environment: string;
    label: string;
    version: number;
  };
}

const asChanged = (message: unknown): ConfigChangedEvent | undefined => {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as { kind?: unknown; event?: unknown };
  if (record.kind !== 'event' || !record.event || typeof record.event !== 'object')
    return undefined;
  const event = record.event as { type?: unknown; output?: unknown };
  return event.type === EVENT ? (event as unknown as ConfigChangedEvent) : undefined;
};

/**
 * Fan-out over `@adonis-agora/durable`'s `ControlPlane` (no import; the app passes its instance).
 * The control plane publishes a value-free `config.changed` engine event; a tenant subscribes and
 * fetches the document over HTTP with its token. Durable is the peer for the **watch** channel only;
 * on-demand reads stay HTTP.
 */
export function durableTransport(config: DurableTransportConfig): ConfigTransportFactory {
  return async () => {
    const from = config.from ?? 'config';
    const transport: ConfigTransport = {
      kind: 'durable',
      async publish(scope, version) {
        const event: ConfigChangedEvent = {
          type: EVENT,
          at: new Date(),
          output: {
            id: randomUUID(),
            app: scope.app,
            environment: scope.environment,
            label: scope.label,
            version,
          },
        };
        await config.controlPlane.publishControl({
          kind: 'event',
          event,
          from,
        });
      },
      async watch(scope, onChanged) {
        config.controlPlane.onControl((message) => {
          const event = asChanged(message);
          if (!event) return;
          const { app, environment, label, version } = event.output;
          if (
            app === scope.app &&
            environment === scope.environment &&
            label === scope.label &&
            typeof version === 'number'
          ) {
            onChanged(version);
          }
        });
        return () => {};
      },
    };
    return transport;
  };
}
