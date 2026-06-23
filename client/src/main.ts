/**
 * client/src/main.ts
 * ---------------------------------------------------------------------------
 * Client composition root: wire the network client to the Canvas renderer and
 * mount every HUD panel inside a draggable / minimizable WINDOW.
 *
 * Each panel is built into a throw-away host element and then handed to the
 * {@link WindowManager}, which wraps it in window chrome (titlebar, minimize,
 * resize) and registers it in the bottom dock. The panels themselves stay
 * exactly as transport-agnostic as before — only how they're mounted changed.
 * ---------------------------------------------------------------------------
 */

import { NetworkClient } from './NetworkClient';
import { Renderer } from './Renderer';
import { WindowManager, type WindowSpec } from './WindowManager';
import { InspectorPanel } from './InspectorPanel';
import { BuildingInspectorPanel } from './BuildingInspectorPanel';
import { RosterPanel } from './RosterPanel';
import { ConversationsPanel } from './ConversationsPanel';
import { DebugPanel } from './DebugPanel';
import { SupervisorPanel } from './SupervisorPanel';
import { LlmEnginePanel } from './LlmEnginePanel';
import { RelationshipsPanel, type VillagerBook } from './RelationshipsPanel';
import { GroupActivitiesPanel } from './GroupActivitiesPanel';
import { PrayersPanel } from './PrayersPanel';
import { simTimeFromTick, formatSimTimeOfDay } from '../../shared/simClock';
import type { BuildingEvent, Conversation, GroupPlan, VillagerActionRecord } from '../../shared/types';

// The WS endpoint is injected at build time (docker-compose), with a sensible
// localhost fallback for running the client outside Docker.
const WS_URL =
  import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8080`;

// The gateway's HTTP base is the same host/port as the WebSocket — it serves the
// action-history endpoint alongside the WS upgrade. Derive it from WS_URL by
// swapping the scheme (ws→http, wss→https).
const API_URL = WS_URL.replace(/^ws/, 'http');

async function fetchActions(villagerId: string): Promise<VillagerActionRecord[]> {
  const res = await fetch(`${API_URL}/villagers/${encodeURIComponent(villagerId)}/actions`);
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  return (await res.json()) as VillagerActionRecord[];
}

async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch(`${API_URL}/conversations`);
  if (!res.ok) throw new Error(`conversations fetch failed: ${res.status}`);
  return (await res.json()) as Conversation[];
}

async function fetchBuildingLog(buildingId: string): Promise<BuildingEvent[]> {
  const res = await fetch(`${API_URL}/buildings/${encodeURIComponent(buildingId)}/log`);
  if (!res.ok) throw new Error(`building log fetch failed: ${res.status}`);
  return (await res.json()) as BuildingEvent[];
}

async function fetchRelationships(): Promise<VillagerBook[]> {
  const res = await fetch(`${API_URL}/relationships`);
  if (!res.ok) throw new Error(`relationships fetch failed: ${res.status}`);
  return (await res.json()) as VillagerBook[];
}

async function fetchGroupPlans(): Promise<GroupPlan[]> {
  const res = await fetch(`${API_URL}/group-plans`);
  if (!res.ok) throw new Error(`group plans fetch failed: ${res.status}`);
  return (await res.json()) as GroupPlan[];
}

const canvas = document.getElementById('viewport');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#viewport canvas not found');
}
const statusEl = document.getElementById('status');

const net = new NetworkClient(WS_URL);
net.onStatusChange = (connected) => {
  if (statusEl) {
    statusEl.classList.toggle('topbar__status--on', connected);
    statusEl.classList.toggle('topbar__status--off', !connected);
    statusEl.textContent = connected ? 'connected' : 'reconnecting…';
  }
};

const renderer = new Renderer(canvas, net);

// ───────────────────────────────────────────────────────────────────────────
// Window system. Each panel is built into a host element, then wrapped.
// ───────────────────────────────────────────────────────────────────────────
const wm = new WindowManager();
const W = window.innerWidth;
const H = window.innerHeight;
/** Vertical room between the top app bar and the bottom dock. */
const colH = Math.max(260, H - 168);

/** Build a panel into a fresh host, wrap it in a window, return both. */
function mount<T>(make: (host: HTMLElement) => T, spec: WindowSpec): { panel: T; win: ReturnType<WindowManager['add']> } {
  const host = document.createElement('div');
  const panel = make(host);
  const win = wm.add(host, spec);
  return { panel, win };
}

// The left-dock roster: one card per villager, click-through to its action log.
const roster = mount(
  (host) => new RosterPanel(host, { onFetchActions: fetchActions }),
  { id: 'roster', title: 'Villagers', icon: '👥', x: 12, y: 56, w: 300, h: colH, minW: 240 },
).panel;

// The debug feed: one line per villager think, plus the live logical-tick clock.
const debug = mount(
  (host) => new DebugPanel(host),
  { id: 'debug', title: 'Debug feed', icon: '🐞', x: 324, y: 56, w: 372, h: 300 },
).panel;
net.onSimTick = (tick, acting, cooldown) => debug.setTick(tick, acting, cooldown);

// The live conversations list: seeded from history, updated as villagers talk.
const convos = mount(
  (host) => new ConversationsPanel(host, { onFetch: fetchConversations }),
  { id: 'conversations', title: 'Conversations', icon: '💬', synthBar: true, x: 324, y: 372, w: 372, h: Math.max(240, colH - 316) },
).panel;
net.onConversation = (conversation) => convos.ingest(conversation);

// The "Village Life" rail — three collapsible cards in one scrolling window:
//  - Relationships: who thinks what of whom (seeded from history, live nightly).
//  - Shared plans: the village's work crews and prayer rituals as they form.
//  - Prayers: the petitions offered at the Temple, as they are spoken.
const vlifeHost = document.createElement('div');
vlifeHost.className = 'village-life';
const relHost = document.createElement('div');
const grpHost = document.createElement('div');
const prayHost = document.createElement('div');
vlifeHost.append(relHost, grpHost, prayHost);

const relationships = new RelationshipsPanel(relHost, {
  onFetch: fetchRelationships,
  colorOf: (id) => net.getState().villagers.find((v) => v.id === id)?.color,
});
net.onRelationship = (message) => relationships.ingest(message);

const groupActivities = new GroupActivitiesPanel(grpHost, { onFetch: fetchGroupPlans });
net.onGroupPlan = (message) => groupActivities.ingest(message);

const prayers = new PrayersPanel(prayHost);

wm.add(vlifeHost, {
  id: 'village-life',
  title: 'Village Life',
  icon: '🌾',
  synthBar: true,
  x: 706,
  y: 56,
  w: 340,
  h: colH,
  minW: 280,
});

// The Supervisor console — the temple's god. Prayers stream in for the human to
// grant (choosing one to answer, dismissing the rest) or dismiss, and a Force Run
// makes the god weigh the pending prayers on demand; its acts come back here too.
const supervisor = mount(
  (host) =>
    new SupervisorPanel(host, {
      onVerdict: (prayer, verdict) => net.sendVerdict(prayer, verdict),
      onForceRun: () => net.forceRun(),
      onSetWeather: (weather) => net.setWeather(weather),
      onBless: (id) => net.bless(id),
      onSmite: (id) => net.smite(id),
      onSpawn: (entityType) => net.spawn(entityType),
    }),
  { id: 'supervisor', title: 'Supervisor', icon: '⛪', x: Math.max(360, W - 372), y: 56, w: 360, h: 460 },
).panel;
// Keep the god console's target picker + weather highlight in sync with the world.
net.onStateUpdate = (villagers, gatherings) => {
  roster.syncVillagers(villagers, gatherings);
  supervisor.setVillagers(villagers);
};
net.onWeather = (weather) => supervisor.setWeather(weather);
// Each prayer reaches the god's console (to grant/deny) AND the read-only prayer
// feed in the Village Life rail.
net.onPrayer = (prayer) => {
  supervisor.ingestPrayer(prayer);
  prayers.ingest(prayer);
};
net.onSupervisorAction = (action) => supervisor.ingestAction(action);

// The LLM-engine debug window: what's running on the shared engine right now,
// and the latency / result of recent round-trips. Diagnoses skipped turns.
const llmPanel = mount(
  (host) => new LlmEnginePanel(host),
  { id: 'llm-engine', title: 'LLM engine', icon: '⚙️', x: Math.max(380, W - 412), y: Math.max(300, H - 392), w: 400, h: 320 },
).panel;
// The engine LLM stream feeds the debug panel AND the renderer, which pulses the
// sense disc of whichever villager is currently running its mind.
net.onEngineCallStarted = (call) => {
  renderer.noteEngineCallStarted(call);
  llmPanel.ingestStart(call);
};
net.onEngineCallFinished = (call) => {
  renderer.noteEngineCallFinished(call);
  llmPanel.ingestFinish(call);
};

// Final Phase — the "Inception" inspector. Clicking a villager opens this window;
// it streams that villager's thoughts and whispers ideas back.
const inspectorMount = mount(
  (host) => new InspectorPanel(host, { onPlant: (villagerId, memory) => net.plantIdea(villagerId, memory) }),
  {
    id: 'inspector',
    title: 'Mind',
    icon: '🧠',
    x: Math.max(400, W - 402),
    y: 56,
    w: 390,
    h: colH,
    minW: 300,
    closable: true,
    startHidden: true,
    onClose: () => {
      inspector.markClosed();
      renderer.selectVillager(null);
    },
  },
);
const inspector = inspectorMount.panel;
inspector.setWindow(inspectorMount.win);

// Clicking a building opens its inspector (resources + rolling activity log).
const buildingMount = mount(
  (host) =>
    new BuildingInspectorPanel(host, {
      onFetch: fetchBuildingLog,
      getBuilding: (id) => net.getState().buildings.find((b) => b.id === id) ?? null,
    }),
  {
    id: 'building-inspector',
    title: 'Building',
    icon: '🏠',
    x: Math.max(380, W - 392),
    y: 96,
    w: 372,
    h: Math.max(260, colH - 60),
    minW: 280,
    closable: true,
    startHidden: true,
    onClose: () => {
      buildingInspector.markClosed();
      renderer.selectBuilding(null);
    },
  },
);
const buildingInspector = buildingMount.panel;
buildingInspector.setWindow(buildingMount.win);
net.onBuildingEvent = (event) => buildingInspector.ingest(event);

// The two inspectors are mutually exclusive — selecting one clears the other so
// only one place/person is highlighted and open at a time.
renderer.onSelectVillager = (id) => {
  buildingInspector.close();
  renderer.selectBuilding(null);
  inspector.open(id);
};
renderer.onSelectBuilding = (id) => {
  inspector.close();
  renderer.selectVillager(null);
  void buildingInspector.open(id);
};

// Fan every villager thought to all consumers: the map bubble, the inspector
// stream, the roster (names + live actions), the debug feed, and the reasoning tab.
net.onThought = (thought) => {
  renderer.noteThought(thought);
  inspector.ingest(thought);
  roster.ingest(thought);
  debug.ingest(thought);
  convos.ingestThought(thought);
};

// The in-world clock in the top app bar: turns the engine tick into a simulated
// date & time (one tick = 10 sim-seconds).
const clockEl = document.getElementById('clock');
if (clockEl) {
  net.onClock = (tick) => {
    const t = simTimeFromTick(tick);
    clockEl.hidden = false;
    clockEl.innerHTML =
      `<span class="clock__day">Day ${t.day}</span>` +
      `<span class="clock__time">${formatSimTimeOfDay(tick)}</span>` +
      `<span class="clock__part">${t.partOfDay}</span>`;
  };
}

// Top-bar "reset layout" tidies every window back to its default place.
document.getElementById('reset-layout')?.addEventListener('click', () => wm.resetLayout());

net.connect();
renderer.start();
