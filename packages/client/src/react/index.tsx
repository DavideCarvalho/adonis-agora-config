import type { ConfigValue } from '@adonis-agora/config-core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type { ConfigValue };

/** The keys the server lets the browser read (`config.browser()`), by dot path. */
export type ConfigValues = Record<string, ConfigValue>;

/** The default channel of `browser.realtime` on the server. */
export const DEFAULT_CONFIG_CHANNEL = 'config/browser';

const ConfigContext = createContext<ConfigValues>({});

/** Provides config values read on the server, typically from an Inertia shared prop. */
export function ConfigProvider({
  values,
  children,
}: {
  values: ConfigValues;
  children: ReactNode;
}) {
  return <ConfigContext.Provider value={values}>{children}</ConfigContext.Provider>;
}

/** Every value the browser may read. */
export function useConfigValues(): ConfigValues {
  return useContext(ConfigContext);
}

/**
 * One value by dot path (`site.banner`), or `fallback` when the server did not send it: the key is
 * missing, or it is not listed in `browser.keys`.
 */
export function useConfig<T extends ConfigValue = ConfigValue>(key: string): T | undefined;
export function useConfig<T extends ConfigValue = ConfigValue>(key: string, fallback: T): T;
export function useConfig<T extends ConfigValue = ConfigValue>(
  key: string,
  fallback?: T,
): T | undefined {
  const value = useContext(ConfigContext)[key];
  return value === undefined ? fallback : (value as T);
}

/** The part of `@adonisjs/transmit-client` these hooks use. */
export interface TransmitLike {
  subscription(channel: string): {
    create(): Promise<void>;
    onMessage<T>(handler: (message: T) => void): () => void;
    delete(): Promise<void>;
  };
}

/**
 * Calls `onChange` when a value the browser reads changed on the server (`browser.realtime` in
 * `config/config.ts`). The message carries only the version: reload the values from the server.
 *
 * ```tsx
 * useConfigRealtime({ transmit, onChange: () => router.reload({ only: ['config'] }) })
 * ```
 */
export function useConfigRealtime(options: {
  transmit: TransmitLike;
  onChange: (version: number) => void;
  /** Must match the server's `browser.realtime.channel`. Default `config/browser`. */
  channel?: string;
}) {
  const onChange = useRef(options.onChange);
  onChange.current = options.onChange;
  const channel = options.channel ?? DEFAULT_CONFIG_CHANNEL;
  const transmit = options.transmit;
  useEffect(() => {
    const subscription = transmit.subscription(channel);
    let stop: (() => void) | undefined;
    let cancelled = false;
    void subscription.create().then(() => {
      if (cancelled) return;
      stop = subscription.onMessage<{ version: number }>((message) =>
        onChange.current(message.version),
      );
    });
    return () => {
      cancelled = true;
      stop?.();
      void subscription.delete();
    };
  }, [transmit, channel]);
}

export interface RemoteConfigProviderProps {
  /** The server's `browser.route` (`/_config/browser`). */
  url: string;
  /** Values to render before the first response (server-rendered pages). Default none. */
  initialValues?: ConfigValues;
  /** Fetch it again when the server says a value changed. */
  realtime?: { transmit: TransmitLike; channel?: string };
  /** Default: the global `fetch`, with the page's cookies. */
  fetch?: typeof fetch;
  children: ReactNode;
}

/**
 * For pages that do not get the values as Inertia props: reads them from the server's
 * `browser.route`, and again on every realtime change. A failed request keeps the current values.
 */
export function RemoteConfigProvider({
  url,
  initialValues,
  realtime,
  fetch: fetcher,
  children,
}: RemoteConfigProviderProps) {
  const [values, setValues] = useState<ConfigValues>(initialValues ?? {});
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const response = await (fetcher ?? globalThis.fetch)(url, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { values?: ConfigValues };
      // An older request that answers last must not overwrite a newer one.
      if (request === latest.current && body.values) setValues(body.values);
    } catch {
      // Offline or the server is restarting: keep what the page has.
    }
  }, [url, fetcher]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <ConfigProvider values={values}>
      {realtime ? (
        <Realtime transmit={realtime.transmit} channel={realtime.channel} onChange={load} />
      ) : null}
      {children}
    </ConfigProvider>
  );
}

function Realtime({
  transmit,
  channel,
  onChange,
}: {
  transmit: TransmitLike;
  channel: string | undefined;
  onChange: () => void;
}) {
  useConfigRealtime({ transmit, ...(channel ? { channel } : {}), onChange });
  return null;
}

/** A frozen copy of the values, for code outside React's render. */
export function useConfigSnapshot(): Readonly<ConfigValues> {
  const values = useConfigValues();
  return useMemo(() => Object.freeze({ ...values }), [values]);
}

/** What the app's token route answers (`browser.direct` in its config/config.ts). */
export interface BrowserTokenResponse {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The control plane's base URL (`https://hub.example.com/_config`). */
  url: string;
}

/** The part of `EventSource` the direct mode uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface DirectConfigProviderProps {
  /** The app's token route. Default `/_config/browser-token`. */
  tokenUrl?: string;
  /** Values to render before the first response. */
  initialValues?: ConfigValues;
  /** Follow changes over the control plane's stream. Default `true`. */
  live?: boolean;
  /** Delay before reconnecting after the stream drops (ms). Default 5000. */
  retryMs?: number;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Default: the global `EventSource`. */
  EventSource?: new (
    url: string,
  ) => EventSourceLike;
  children: ReactNode;
}

/**
 * The direct mode: reads the values from the control plane itself, with a short-lived token from
 * the app (`browser.direct`), and follows changes over the control plane's stream. When the token
 * expires the stream closes, and the provider fetches a new token and reconnects. A failure keeps
 * the values the page has.
 */
export function DirectConfigProvider({
  tokenUrl = '/_config/browser-token',
  initialValues,
  live = true,
  retryMs = 5000,
  fetch: fetcher,
  EventSource: Source,
  children,
}: DirectConfigProviderProps) {
  const [values, setValues] = useState<ConfigValues>(initialValues ?? {});
  useEffect(() => {
    const doFetch = fetcher ?? globalThis.fetch;
    const Stream =
      Source ?? (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
    let stopped = false;
    let source: EventSourceLike | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let latest = 0;
    const load = async (issued: BrowserTokenResponse) => {
      const request = ++latest;
      const response = await doFetch(`${issued.url}/v1/browser/values`, {
        headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`config: ${response.status}`);
      const body = (await response.json()) as { values?: ConfigValues };
      if (!stopped && request === latest && body.values) setValues(body.values);
    };
    const connect = async () => {
      try {
        const response = await doFetch(tokenUrl, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`config: token ${response.status}`);
        const issued = (await response.json()) as BrowserTokenResponse;
        if (stopped) return;
        await load(issued);
        if (stopped || !live || !Stream) return;
        source = new Stream(
          `${issued.url}/v1/browser/stream?token=${encodeURIComponent(issued.token)}`,
        );
        source.addEventListener('config', () => {
          load(issued).catch(() => {});
        });
        // A dropped stream, or the token's expiry: start over with a new token.
        source.onerror = () => {
          source?.close();
          source = undefined;
          if (!stopped) retry = setTimeout(() => void connect(), retryMs);
        };
      } catch {
        if (!stopped && live) retry = setTimeout(() => void connect(), retryMs);
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [tokenUrl, live, retryMs, fetcher, Source]);
  return <ConfigProvider values={values}>{children}</ConfigProvider>;
}
