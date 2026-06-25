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
import { LiveLlmPanel } from './LiveLlmPanel';
import { RelationshipsPanel, type VillagerBook } from './RelationshipsPanel';
import { GroupActivitiesPanel } from './GroupActivitiesPanel';
import { AgendaPanel } from './AgendaPanel';
import { PrayersPanel } from './PrayersPanel';
import { SummaryPanel } from './SummaryPanel';
import { SettingsPanel } from './SettingsPanel';
import { EnvironmentHud } from './EnvironmentHud';
import { GenerationOverlay } from './GenerationOverlay';
import { SetupScreen } from './SetupScreen';
import type {
  AgendaItem,
  BuildingEvent,
  Conversation,
  GroupPlan,
  SupervisorDailyReportPayload,
  VillagerActionRecord,
  VillagerMemory,
  VillagerPersona,
} from '../../shared/types';

// Stamp the version badge in the topbar.
(document.getElementById('app-version') as HTMLElement).textContent = `v${__APP_VERSION__}`;

// The WS endpoint can be injected at build time (VITE_WS_URL), but by default
// the browser talks to its OWN origin — nginx serving this bundle reverse-proxies
// the WS/REST to the backend, which is not exposed to the host. (`||` so an empty
// build arg falls through to the same-origin default.)
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// The gateway's HTTP base is the same host/port as the WebSocket — it serves the
// action-history endpoint alongside the WS upgrade. Derive it from WS_URL by
// swapping the scheme (ws→http, wss→https).
const API_URL = WS_URL.replace(/^ws/, 'http');

async function fetchActions(villagerId: string): Promise<VillagerActionRecord[]> {
  const res = await fetch(`${API_URL}/villagers/${encodeURIComponent(villagerId)}/actions`);
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  return (await res.json()) as VillagerActionRecord[];
}

async function fetchPersona(villagerId: string): Promise<VillagerPersona | null> {
  const res = await fetch(`${API_URL}/villagers/${encodeURIComponent(villagerId)}/persona`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`persona fetch failed: ${res.status}`);
  return (await res.json()) as VillagerPersona;
}

async function fetchMemories(villagerId: string): Promise<VillagerMemory[]> {
  const res = await fetch(`${API_URL}/villagers/${encodeURIComponent(villagerId)}/memories`);
  if (!res.ok) throw new Error(`memories fetch failed: ${res.status}`);
  return (await res.json()) as VillagerMemory[];
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

async function fetchDailyReports(): Promise<SupervisorDailyReportPayload[]> {
  const res = await fetch(`${API_URL}/daily-reports`);
  if (!res.ok) throw new Error(`daily reports fetch failed: ${res.status}`);
  return (await res.json()) as SupervisorDailyReportPayload[];
}

async function fetchAgenda(): Promise<AgendaItem[]> {
  const res = await fetch(`${API_URL}/agenda`);
  if (!res.ok) throw new Error(`agenda fetch failed: ${res.status}`);
  return (await res.json()) as AgendaItem[];
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
  (host) => new RosterPanel(host, { onFetchActions: fetchActions, onFetchMemories: fetchMemories, onFetchPersona: fetchPersona }),
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
const agendaHost = document.createElement('div');
const prayHost = document.createElement('div');
vlifeHost.append(relHost, grpHost, agendaHost, prayHost);

const relationships = new RelationshipsPanel(relHost, {
  onFetch: fetchRelationships,
  colorOf: (id) => net.getState().villagers.find((v) => v.id === id)?.color,
});
net.onRelationship = (message) => relationships.ingest(message);

const groupActivities = new GroupActivitiesPanel(grpHost, { onFetch: fetchGroupPlans });
net.onGroupPlan = (message) => groupActivities.ingest(message);

// The Agenda card: every villager's notes + scheduled events, as a village-wide
// timeline or broken out per villager. Seeded from /agenda, live via agenda.updated.
const agenda = new AgendaPanel(agendaHost, {
  onFetch: fetchAgenda,
  colorOf: (id) => net.getState().villagers.find((v) => v.id === id)?.color,
  getTick: () => net.getState().tick,
});
net.onAgendaUpdate = (item) => agenda.ingest(item);
net.onAgendaRemoved = (itemId) => agenda.remove(itemId);

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

// The Chronicle window — the god's beautiful end-of-day summary. It pops to the
// front each time a new day's chronicle arrives, and keeps the whole run's
// history (seeded from GET /daily-reports) revisitable via its day selector.
const summaryMount = mount(
  (host) => new SummaryPanel(host),
  {
    id: 'chronicle',
    title: 'Chronicle',
    icon: '📜',
    x: Math.max(120, Math.floor(W / 2) - 320),
    y: Math.max(80, Math.floor(H / 2) - 220),
    w: 640,
    h: 440,
    minW: 460,
    minH: 300,
    closable: true,
    startHidden: true,
  },
);
const summary = summaryMount.panel;
net.onDailyReport = (message) => {
  const isNewLatest = summary.ingest(message.report);
  // Auto-popup only when a genuinely new day arrives (not on a late re-broadcast).
  if (isNewLatest) summaryMount.win.open();
};
// Seed the history on load; show the latest without stealing focus on first paint.
void fetchDailyReports()
  .then((reports) => {
    if (reports.length > 0) summary.loadHistory(reports);
  })
  .catch((err) => console.warn('[chronicle] history fetch failed:', err));

// The LLM-engine debug window: what's running on the shared engine right now,
// and the latency / result of recent round-trips. Diagnoses skipped turns.
const llmPanel = mount(
  (host) => new LlmEnginePanel(host),
  { id: 'llm-engine', title: 'LLM engine', icon: '⚙️', x: Math.max(380, W - 412), y: Math.max(300, H - 392), w: 400, h: 320 },
).panel;
// The engine LLM stream feeds the debug panel AND the renderer, which pulses the
// sense disc of whichever villager is currently running its mind.
// The Live LLM window: watch each `/decide` call think and answer token-by-token,
// then collapse into an Input · Think · Output · Tool card (last 10 kept).
const liveLlm = mount(
  (host) => new LiveLlmPanel(host),
  { id: 'live-llm', title: 'Live LLM', icon: '🔮', x: Math.max(20, Math.floor(W / 2) - 280), y: Math.max(60, H - 460), w: 460, h: 400, minW: 340, minH: 260 },
).panel;
net.onEngineCallStarted = (call) => {
  renderer.noteEngineCallStarted(call);
  llmPanel.ingestStart(call);
  liveLlm.ingestStart(call);
};
net.onEngineCallDelta = (call) => {
  liveLlm.ingestDelta(call);
  llmPanel.ingestDelta(call); // accumulate think text for the engine's reasoning badge
};
net.onLlmPool = (cfg) => llmPanel.setPool(cfg);
net.onEngineCallFinished = (call) => {
  renderer.noteEngineCallFinished(call);
  llmPanel.ingestFinish(call);
  liveLlm.ingestFinish(call);
};

// The Settings window: operator controls for the LLM engine — today, the
// per-purpose reasoning effort. Opened from its ⚙️ dock chip; the backend owns
// the truth, so the controls mirror whatever the server last broadcast.
const settings = mount(
  (host) =>
    new SettingsPanel(host, {
      onSetEffort: (purpose, level) => net.setReasoningEffort(purpose, level),
      onSetModel: (model) => net.setLlmModel(model),
      onRefreshModels: () => net.refreshLlmModels(),
      onResetWorld: () => net.resetWorld(),
    }),
  {
    id: 'settings',
    title: 'Settings',
    icon: '⚙️',
    x: Math.max(120, Math.floor(W / 2) - 220),
    y: Math.max(80, Math.floor(H / 2) - 260),
    w: 400,
    h: 560,
    minW: 340,
    minH: 320,
    closable: true,
    startHidden: true,
  },
).panel;
net.onReasoningEffort = (cfg) => {
  settings.setSettings(cfg);
  llmPanel.setEffort(cfg); // tag each engine-call row with its purpose's effort
};
net.onLlmModel = (cfg) => settings.setModelConfig(cfg);

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
      getCarts: () => net.getState().carts,
      onFocusCart: (id) => renderer.focusCart(id),
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

// The environment HUD in the top app bar: season · weather · temperature · time,
// all DERIVED from the engine tick + current weather (see EnvironmentHud).
const clockEl = document.getElementById('clock');
if (clockEl) {
  const envHud = new EnvironmentHud(clockEl);
  net.onClock = (tick) => envHud.render(tick);
  // Weather changes the temperature too, so re-render the whole HUD on it.
  const priorOnWeather = net.onWeather;
  net.onWeather = (weather) => {
    priorOnWeather?.(weather);
    envHud.setWeather(weather);
  };
  // An LLM-generated village announces its theme on world.init; show it in the HUD.
  net.onTheme = (theme, setting) => envHud.setTheme(theme, setting);
}

// The first-run flow: the SETUP screen (no world yet) → the loading OVERLAY (build
// in progress) → the live world. The backend signals each transition, so the client
// just shows/hides these two full-screen surfaces in response.
const genOverlayEl = document.getElementById('gen-overlay');
const overlay = genOverlayEl ? new GenerationOverlay(genOverlayEl) : null;

const setupEl = document.getElementById('setup-screen');
const setup = setupEl
  ? new SetupScreen(setupEl, {
      onGenerate: (opts) => net.generateWorld(opts),
      onPreview: (requestId, style) => net.previewStyle(requestId, style),
    })
  : null;

net.onNeedsSetup = (msg) => setup?.show(msg);
net.onStylePreview = (msg) => setup?.applyPreview(msg);
net.onGenerating = (msg) => {
  setup?.hide(); // the build has begun; replace the form with the progress overlay
  overlay?.update(msg);
};
net.onWorldInit = () => {
  setup?.hide();
  overlay?.hide();
};

// Top-bar "reset layout" tidies every window back to its default place.
document.getElementById('reset-layout')?.addEventListener('click', () => wm.resetLayout());

net.connect();
renderer.start();
