import { createContext, useContext } from 'react';
import type { ConfigApi, FederatedAppInfo, Meta, Scope } from '../client/config-client';

export interface ConsoleState {
  api: ConfigApi;
  meta: Meta;
  scope: Scope;
  setScope: (scope: Scope) => void;
  /** The picked app when it is another app (the federated console). */
  federated?: FederatedAppInfo | undefined;
  /** Why changes are unavailable for the picked app, or undefined when they are. */
  readOnly?: string | undefined;
}

export const ConsoleContext = createContext<ConsoleState | null>(null);

export function useConsole(): ConsoleState {
  const state = useContext(ConsoleContext);
  if (!state) throw new Error('the config console mounted without its context');
  return state;
}
