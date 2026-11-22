import { router } from '@inertiajs/react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  ConfigProvider,
  type ConfigValues,
  type TransmitLike,
  useConfigRealtime,
} from './index.js';

export interface InertiaConfigProviderProps {
  /** The first page (`props.initialPage` in `createInertiaApp`'s `setup`). */
  initialPage: { props: Record<string, unknown> };
  /** The shared prop holding `config.browser()`. Default `config`. */
  prop?: string;
  /**
   * Live updates: with `browser.realtime` in `config/config.ts` and `@adonisjs/transmit`, reloads
   * the prop (`router.reload({ only: [prop] })`) when a value the browser reads changes.
   */
  realtime?: { transmit: TransmitLike; channel?: string };
  children: ReactNode;
}

function Realtime({
  transmit,
  channel,
  prop,
}: {
  transmit: TransmitLike;
  channel: string | undefined;
  prop: string;
}) {
  useConfigRealtime({
    transmit,
    ...(channel ? { channel } : {}),
    onChange: () => router.reload({ only: [prop] }),
  });
  return null;
}

/**
 * `ConfigProvider` for Inertia apps: starts from the first page's shared `config` prop and follows
 * it on every Inertia response (visits, reloads, partial reloads). Mount it in `setup`:
 *
 * ```tsx
 * setup({ el, App, props }) {
 *   createRoot(el).render(
 *     <InertiaConfigProvider initialPage={props.initialPage} realtime={{ transmit }}>
 *       <App {...props} />
 *     </InertiaConfigProvider>,
 *   )
 * }
 * ```
 */
export function InertiaConfigProvider({
  initialPage,
  prop = 'config',
  realtime,
  children,
}: InertiaConfigProviderProps) {
  const [values, setValues] = useState<ConfigValues>(
    (initialPage.props[prop] as ConfigValues | undefined) ?? {},
  );
  useEffect(
    () =>
      // `success` fires for visits and reloads alike. A partial reload without the prop keeps the
      // current values.
      router.on('success', (event: { detail: { page: { props: Record<string, unknown> } } }) => {
        const next = event.detail.page.props[prop] as ConfigValues | undefined;
        if (next) setValues(next);
      }),
    [prop],
  );
  return (
    <ConfigProvider values={values}>
      {realtime ? (
        <Realtime transmit={realtime.transmit} channel={realtime.channel} prop={prop} />
      ) : null}
      {children}
    </ConfigProvider>
  );
}
