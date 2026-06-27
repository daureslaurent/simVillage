/**
 * client/src/react/App.tsx
 * ---------------------------------------------------------------------------
 * The React composition root. ONE React tree renders the fixed topbar and then
 * PORTALS each panel body into the matching WindowManager window — so the window
 * chrome (drag/resize/minimize/persistence) stays imperative while the contents
 * are React, sharing a single NetworkProvider + active-village selection.
 * ---------------------------------------------------------------------------
 */

import { createPortal } from 'react-dom';
import type { NetworkClient } from '../NetworkClient';
import type { ClientStore } from './store';
import { NetworkProvider } from './NetworkProvider';
import { ActiveVillageProvider } from './activeVillage';
import { Topbar } from './components/Topbar';
import { SupervisorConsole } from './components/SupervisorConsole';
import { EngineTelemetry } from './components/EngineTelemetry';
import { SettingsPanel } from './components/SettingsPanel';
import { Inspector } from './components/Inspector';

/** The windows React renders into, by stable id. */
export interface PanelHosts {
  supervisor: HTMLElement;
  'llm-engine': HTMLElement;
  settings: HTMLElement;
  inspector: HTMLElement;
}

function WindowPortals({ hosts }: { hosts: PanelHosts }): React.JSX.Element {
  return (
    <>
      {createPortal(<SupervisorConsole />, hosts.supervisor)}
      {createPortal(<EngineTelemetry />, hosts['llm-engine'])}
      {createPortal(<SettingsPanel />, hosts.settings)}
      {createPortal(<Inspector />, hosts.inspector)}
    </>
  );
}

export function App({
  net,
  store,
  hosts,
  onResetLayout,
}: {
  net: NetworkClient;
  store: ClientStore;
  hosts: PanelHosts;
  onResetLayout: () => void;
}): React.JSX.Element {
  return (
    <NetworkProvider net={net} store={store}>
      <ActiveVillageProvider>
        <Topbar onResetLayout={onResetLayout} />
        <WindowPortals hosts={hosts} />
      </ActiveVillageProvider>
    </NetworkProvider>
  );
}
