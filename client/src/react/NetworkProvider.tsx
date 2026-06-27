/**
 * client/src/react/NetworkProvider.tsx
 * ---------------------------------------------------------------------------
 * React context over the {@link ClientStore}. Holds the store + the underlying
 * {@link NetworkClient} (for sending commands) and exposes one hook per slice.
 * Each hook uses `useSyncExternalStore`, so a component re-renders only when the
 * slice it reads changes — the telemetry window churns on LLM calls without ever
 * waking the topbar, and vice-versa.
 * ---------------------------------------------------------------------------
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { NetworkClient } from '../NetworkClient';
import type { ClientStore } from './store';

interface NetworkContextValue {
  net: NetworkClient;
  store: ClientStore;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({
  net,
  store,
  children,
}: {
  net: NetworkClient;
  store: ClientStore;
  children: ReactNode;
}): React.JSX.Element {
  return <NetworkContext.Provider value={{ net, store }}>{children}</NetworkContext.Provider>;
}

function useCtx(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork* must be used within <NetworkProvider>');
  return ctx;
}

/** The NetworkClient, for sending commands (verdicts, divine powers, settings). */
export function useNet(): NetworkClient {
  return useCtx().net;
}

/** The ClientStore, for reads beyond the slices (e.g. the live inspected entity). */
export function useStore(): ClientStore {
  return useCtx().store;
}

/** Subscribe to one store slice. */
function useSlice<T>(pick: (store: ClientStore) => { get: () => T; subscribe: (cb: () => void) => () => void }): T {
  const { store } = useCtx();
  const slice = pick(store);
  return useSyncExternalStore(slice.subscribe, slice.get);
}

export const useConnection = (): boolean => useSlice((s) => s.connection);
export const useEnv = (): ReturnType<ClientStore['env']['get']> => useSlice((s) => s.env);
export const useVillages = (): ReturnType<ClientStore['villages']['get']> => useSlice((s) => s.villages);
export const useVillagerOptions = (): ReturnType<ClientStore['villagerOptions']['get']> =>
  useSlice((s) => s.villagerOptions);
export const useEngine = (): ReturnType<ClientStore['engine']['get']> => useSlice((s) => s.engine);
export const useModel = (): ReturnType<ClientStore['model']['get']> => useSlice((s) => s.model);
export const useEffortSettings = (): ReturnType<ClientStore['effortSettings']['get']> =>
  useSlice((s) => s.effortSettings);
export const useSelection = (): ReturnType<ClientStore['selection']['get']> => useSlice((s) => s.selection);
