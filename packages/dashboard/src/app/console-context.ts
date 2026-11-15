import { createContext, useContext } from 'react';
import type { ConfigApi, Meta, Scope } from '../client/config-client';

export interface ConsoleState {
  api: ConfigApi;
  meta: Meta;
  scope: Scope;
  setScope: (scope: Scope) => void;
}

export const ConsoleContext = createContext<ConsoleState | null>(null);

export function useConsole(): ConsoleState {
  const state = useContext(ConsoleContext);
  if (!state) throw new Error('the config console mounted without its context');
  return state;
}
