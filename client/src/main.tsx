/**
 * client/src/main.tsx
 * ---------------------------------------------------------------------------
 * Client composition root (React era). It wires the imperative core — the Canvas
 * {@link Renderer}, the {@link NetworkClient}, the {@link WindowManager}, and the
 * two full-screen first-run surfaces — to a SINGLE React tree.
 *
 * The seam: WindowManager creates each floating window and owns its chrome; React
 * portals the window BODY (see {@link App}). All WS streams flow through the
 * {@link ClientStore}, which owns every `net.on*` callback and feeds React slices,
 * while a few imperative SINKS (the renderer's pulses, the setup + generation
 * overlays) are tapped straight off the same store.
 * ---------------------------------------------------------------------------
 */

import './index.css';
import { createRoot } from 'react-dom/client';
import { NetworkClient } from './NetworkClient';
import { Renderer } from './Renderer';
import { WindowManager, type ManagedWindow, type WindowSpec } from './WindowManager';
import { GenerationOverlay } from './GenerationOverlay';
import { SetupScreen } from './SetupScreen';
import { ClientStore, type StoreSinks } from './react/store';
import { App, type PanelHosts } from './react/App';

// The WS endpoint can be injected at build time (VITE_WS_URL); otherwise the
// browser talks to its OWN origin (nginx reverse-proxies WS/REST to the backend).
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const canvas = document.getElementById('viewport');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#viewport canvas not found');
}

const net = new NetworkClient(WS_URL);
const renderer = new Renderer(canvas, net);

// First-run surfaces stay imperative (large, self-contained, full-screen).
const genOverlayEl = document.getElementById('gen-overlay');
const overlay = genOverlayEl ? new GenerationOverlay(genOverlayEl) : null;
const setupEl = document.getElementById('setup-screen');
const setup = setupEl
  ? new SetupScreen(setupEl, {
      onGenerate: (opts) => net.generateWorld(opts),
      onPreview: (requestId, style) => net.previewStyle(requestId, style),
    })
  : null;

// The imperative sinks the store feeds alongside the React slices.
const sinks: StoreSinks = {
  onThought: (t) => renderer.noteThought(t),
  onEngineStarted: (c) => renderer.noteEngineCallStarted(c),
  onEngineFinished: (c) => renderer.noteEngineCallFinished(c),
  onNeedsSetup: (m) => setup?.show(m),
  onStylePreview: (m) => setup?.applyPreview(m),
  onGenerating: (m) => {
    setup?.hide();
    overlay?.update(m);
  },
  onWorldInit: () => {
    setup?.hide();
    overlay?.hide();
  },
};

const store = new ClientStore(net, sinks);

// ───────────────────────────────────────────────────────────────────────────
// Windows. Each kept panel gets an EMPTY body host (React portals into it). We
// use synthBar so WindowManager owns the titlebar and React owns only the body.
// ───────────────────────────────────────────────────────────────────────────
const wm = new WindowManager();
const W = window.innerWidth;
const H = window.innerHeight;
const colH = Math.max(280, H - 168);

function addWindow(spec: WindowSpec): { host: HTMLElement; win: ManagedWindow } {
  const host = document.createElement('div');
  const win = wm.add(host, { synthBar: true, ...spec });
  return { host, win };
}

const supervisorW = addWindow({
  id: 'supervisor',
  title: 'God Console',
  icon: '⛪',
  x: Math.max(360, W - 392),
  y: 64,
  w: 380,
  h: colH,
  minW: 320,
  minH: 320,
});
const engineW = addWindow({
  id: 'llm-engine',
  title: 'LLM engine',
  icon: '⚙️',
  x: 16,
  y: Math.max(320, H - 380),
  w: 440,
  h: 340,
  minW: 320,
  minH: 220,
});
const settingsW = addWindow({
  id: 'settings',
  title: 'Settings',
  icon: '🛠',
  x: Math.max(120, Math.floor(W / 2) - 200),
  y: Math.max(72, Math.floor(H / 2) - 260),
  w: 400,
  h: 560,
  minW: 320,
  minH: 320,
  closable: true,
  startHidden: true,
});
// The map INSPECTOR — opens when the operator clicks a villager/building; closing it
// clears the selection + the map highlight.
const inspectorW = addWindow({
  id: 'inspector',
  title: 'Inspector',
  icon: '🔍',
  x: Math.max(360, W - 392),
  y: 64,
  w: 360,
  h: Math.max(280, Math.floor(colH * 0.7)),
  minW: 300,
  minH: 240,
  closable: true,
  startHidden: true,
  onClose: () => {
    store.clearSelection();
    renderer.selectVillager(null);
    renderer.selectBuilding(null);
  },
});

const hosts: PanelHosts = {
  supervisor: supervisorW.host,
  'llm-engine': engineW.host,
  settings: settingsW.host,
  inspector: inspectorW.host,
};

// Map clicks → the inspector. The Renderer sets its own highlight on the clicked
// entity; here we clear the OTHER highlight (mutually exclusive), record the selection
// for the React inspector, and pop the window to the front.
renderer.onSelectVillager = (id) => {
  renderer.selectBuilding(null);
  store.select({ kind: 'villager', id });
  inspectorW.win.open();
};
renderer.onSelectBuilding = (id) => {
  renderer.selectVillager(null);
  store.select({ kind: 'building', id });
  inspectorW.win.open();
};

// Mount the single React tree (topbar + portals into the window bodies).
const reactRoot = document.createElement('div');
reactRoot.id = 'react-root';
document.body.appendChild(reactRoot);
createRoot(reactRoot).render(
  <App net={net} store={store} hosts={hosts} onResetLayout={() => wm.resetLayout()} />,
);

renderer.start();
net.connect();
