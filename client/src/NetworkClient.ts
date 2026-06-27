/**
 * client/src/NetworkClient.ts
 * ---------------------------------------------------------------------------
 * The browser's view of the world over WebSockets. It is the mirror image of
 * the server transport:
 *   - Parses inbound `ServerMessage`s and caches the latest world view.
 *   - Sends outbound `ClientCommand`s (the God Hand).
 *
 * It exposes a tiny, render-friendly surface (`getState`) and stays oblivious to
 * Canvas — the Renderer simply polls it each animation frame.
 * ---------------------------------------------------------------------------
 */

import type {
  Conversation,
  BuildingEvent,
  Gathering,
  Villager,
  VillagerThoughtMessage,
  BrowserCommand,
  Building,
  Cart,
  LlmCallStartedMessage,
  LlmCallDeltaMessage,
  LlmCallFinishedMessage,
  ServerMessage,
  WorldGeneratingMessage,
  WorldNeedsSetupMessage,
  WorldStylePreviewMessage,
  VillageSize,
  RivalSetupParams,
  SupervisorActionMessage,
  SupervisorDailyReportMessage,
  VillageScoreboard,
  VillageCensus,
  DigestEvent,
  SupervisorPrayerMessage,
  RelationshipUpdateMessage,
  GroupPlanMessage,
  AgendaItem,
  Tree,
  TerrainPalette,
  WeatherKind,
  ReasoningEffortSettings,
  EffortPurpose,
  ReasoningEffort,
  LlmModelConfig,
  LlmPoolConfig,
  BuildingStock,
} from '../../shared/types';

/** A flattened, latest-known snapshot the renderer can draw directly. */
export interface WorldView {
  connected: boolean;
  width: number;
  height: number;
  tickRate: number;
  tick: number;
  trees: Tree[];
  buildings: Building[];
  villagers: Villager[];
  /** Mobile robot-carts this tick (position, cargo, order, phase). */
  carts: Cart[];
  weather: WeatherKind;
  /** Social clusters of 2+ nearby villagers this tick. */
  gatherings: Gathering[];
  /** Themed ground colours from world.init (null until the first init; default if the world has none). */
  palette: TerrainPalette | null;
  /** Second ground palette for the rival (east) side of a two-village world; null otherwise. */
  rivalPalette: TerrainPalette | null;
  /** Tile x where the ground switches from `palette` (west) to `rivalPalette` (east); null in single-village worlds. */
  paletteSplitX: number | null;
}

export class NetworkClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly view: WorldView = {
    connected: false,
    width: 0,
    height: 0,
    tickRate: 0,
    tick: 0,
    trees: [],
    buildings: [],
    villagers: [],
    carts: [],
    weather: 'clear',
    gatherings: [],
    palette: null,
    rivalPalette: null,
    paletteSplitX: null,
  };

  /** Optional hook so the UI can react to connection state changes. */
  onStatusChange: ((connected: boolean) => void) | null = null;
  /** Optional hook fed every incoming villager thought (the "Inception" feed). */
  onThought: ((thought: VillagerThoughtMessage) => void) | null = null;
  /** Optional hook fired each tick with the latest villager list + gatherings (for the roster). */
  onStateUpdate: ((villagers: Villager[], gatherings: Gathering[]) => void) | null = null;
  /** Optional hook fed the engine tick each world update, for the in-world clock. */
  onClock: ((tick: number) => void) | null = null;
  /** Optional hook fed every conversation update (opened or extended). */
  onConversation: ((conversation: Conversation) => void) | null = null;
  /** Optional hook fed each building activity event (for the inspector panel). */
  onBuildingEvent: ((event: BuildingEvent) => void) | null = null;
  /** Optional hook fed each logical-tick announcement from the turn coordinator. */
  onSimTick: ((tick: number, acting: string[], cooldown: Record<string, number>) => void) | null = null;
  /** Optional hook fired when an LLM-engine round-trip starts (debug window). */
  onEngineCallStarted: ((call: LlmCallStartedMessage) => void) | null = null;
  /** Optional hook fed each streamed slice of an in-flight `/decide` call (Live LLM window). */
  onEngineCallDelta: ((call: LlmCallDeltaMessage) => void) | null = null;
  /** Optional hook fired when an LLM-engine round-trip finishes (debug window). */
  onEngineCallFinished: ((call: LlmCallFinishedMessage) => void) | null = null;
  /** Optional hook fed each villager prayer, for the Supervisor (temple) console. */
  onPrayer: ((prayer: SupervisorPrayerMessage) => void) | null = null;
  /** Optional hook fed each divine act the Supervisor took, for the console's log. */
  onSupervisorAction: ((action: SupervisorActionMessage) => void) | null = null;
  /** Optional hook fed the god's nightly chronicle, for the summary window. */
  onDailyReport: ((message: SupervisorDailyReportMessage) => void) | null = null;
  /** Optional hook fed the village competition scoreboard, for the HUD chip + supervisor panel. */
  onScoreboard: ((scoreboard: VillageScoreboard) => void) | null = null;
  /** Optional hook fed the per-village census (population/resources/structures/forts). */
  onVillageCensus: ((villages: VillageCensus[], day: number, tick: number) => void) | null = null;
  /** Optional hook fed each tagged world alert (raid/famine/surplus/…), for the per-village ticker. */
  onVillageAlert: ((villageId: string, event: DigestEvent) => void) | null = null;
  /** Optional hook fed each villager's revised social book, for the relationships view. */
  onRelationship: ((message: RelationshipUpdateMessage) => void) | null = null;
  /** Optional hook fed each opened/joined group plan, for the shared-plans view. */
  onGroupPlan: ((message: GroupPlanMessage) => void) | null = null;
  /** Optional hook fed each created/changed agenda item, for the Agenda view. */
  onAgendaUpdate: ((item: AgendaItem) => void) | null = null;
  /** Optional hook fed the id of each dropped agenda item (expired event / stale note). */
  onAgendaRemoved: ((itemId: string) => void) | null = null;
  /** Optional hook fed the current village weather (on connect and on every change). */
  onWeather: ((weather: WeatherKind) => void) | null = null;
  /**
   * Optional hook fed an LLM-generated village's flavour (theme label + a sentence)
   * on `world.init`. Fires with empty strings for the classic hand-authored village,
   * so a listener can hide the theme chip when there is none.
   */
  onTheme: ((theme: string, setting: string) => void) | null = null;
  /** Optional hook fed each world-generation progress step, for the loading overlay. */
  onGenerating: ((message: WorldGeneratingMessage) => void) | null = null;
  /** Optional hook fired once `world.init` arrives, so the loading overlay can dismiss. */
  onWorldInit: (() => void) | null = null;
  /** Optional hook fired when the backend is awaiting the first-run setup choice. */
  onNeedsSetup: ((message: WorldNeedsSetupMessage) => void) | null = null;
  /** Optional hook fed a style colour preview answer, for the setup screen's swatch. */
  onStylePreview: ((message: WorldStylePreviewMessage) => void) | null = null;
  /** Optional hook fed the current reasoning-effort config (on connect and on every change). */
  onReasoningEffort: ((settings: ReasoningEffortSettings) => void) | null = null;
  /** Optional hook fed the current chat-model config (on connect and on every change/refresh). */
  onLlmModel: ((config: LlmModelConfig) => void) | null = null;
  /** Optional hook fed the LLM pool shape (endpoints + busy), on connect and on each poll. */
  onLlmPool: ((config: LlmPoolConfig) => void) | null = null;

  constructor(private readonly url: string) {}

  connect(): void {
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('open', () => {
      this.view.connected = true;
      this.onStatusChange?.(true);
    });

    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener('close', () => {
      this.view.connected = false;
      this.onStatusChange?.(false);
      this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      // Errors are followed by a close event; reconnection is handled there.
      this.socket?.close();
    });
  }

  /** The latest world view. Returned live (not copied) for cheap per-frame reads. */
  getState(): WorldView {
    return this.view;
  }

  /** Send a browser command (God Hand or Inception) if the socket is open. */
  sendCommand(command: BrowserCommand): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
    }
  }

  /** The "Inception": force a synthetic memory into the given villager's mind. */
  plantIdea(targetId: string, memory: string): void {
    this.sendCommand({ command: 'plant_idea', targetId, memory });
  }

  /** The temple console: grant or deny one villager prayer. Routes to the prayer's
   *  own village's god (v3 rival seam). */
  sendVerdict(prayer: SupervisorPrayerMessage, verdict: 'choose' | 'reject'): void {
    this.sendCommand({
      command: 'supervisor_verdict',
      prayerId: prayer.id,
      villagerId: prayer.villagerId,
      villagerName: prayer.villagerName,
      message: prayer.message,
      verdict,
      villageId: prayer.villageId,
    });
  }

  /** The temple console: force a village's god to weigh its pending prayers now (answers at most one). */
  forceRun(villageId?: string): void {
    this.sendCommand({ command: 'supervisor_force_run', ...(villageId ? { villageId } : {}) });
  }

  /** The temple console: pause (seize the wheel) or resume a village's autonomous LLM supervisor. */
  pauseSupervisor(paused: boolean, villageId?: string): void {
    this.sendCommand({ command: 'supervisor_pause', paused, ...(villageId ? { villageId } : {}) });
  }

  /** Divine power: set the village-wide weather directly. */
  setWeather(weather: WeatherKind): void {
    this.sendCommand({ command: 'god_set_weather', weather });
  }

  /** Divine power: bless a villager — ease every need, wake a sleeper. */
  bless(villagerId: string): void {
    this.sendCommand({ command: 'god_bless', targetId: villagerId });
  }

  /** Divine power: smite a villager — visit hardship on every need. */
  smite(villagerId: string): void {
    this.sendCommand({ command: 'god_smite', targetId: villagerId });
  }

  /**
   * Divine power: conjure a newcomer or a tree. With no tile given it lands near
   * the middle of the map (the engine snaps it to the nearest free, in-bounds tile).
   */
  spawn(entityType: 'villager' | 'tree', at?: { x: number; y: number }): void {
    const x = at?.x ?? Math.floor(this.view.width / 2) + Math.floor((Math.random() - 0.5) * 12);
    const y = at?.y ?? Math.floor(this.view.height / 2) + Math.floor((Math.random() - 0.5) * 12);
    this.sendCommand({ command: 'god_spawn', entityType, x, y });
  }

  /** Settings: set how hard the model thinks for one call purpose. */
  setReasoningEffort(purpose: EffortPurpose, level: ReasoningEffort): void {
    this.sendCommand({ command: 'set_reasoning_effort', purpose, level });
  }

  /** Settings: switch the engine's global chat model. */
  setLlmModel(model: string): void {
    this.sendCommand({ command: 'set_llm_model', model });
  }

  /** Settings: ask the backend to re-discover available models from the engine. */
  refreshLlmModels(): void {
    this.sendCommand({ command: 'refresh_llm_models' });
  }

  /** Setup screen: create the village (auto-generate with a style, or the static village). */
  generateWorld(opts: {
    mode: 'auto' | 'static';
    style?: string;
    villagers?: number;
    size?: VillageSize;
    rival?: RivalSetupParams;
  }): void {
    this.sendCommand({ command: 'generate_world', ...opts });
  }

  /** Setup screen: ask for a fast colour preview of a style (debounced by the caller). */
  previewStyle(requestId: number, style: string): void {
    this.sendCommand({ command: 'preview_style', requestId, style });
  }

  /** Settings: wipe the world and return to the setup screen ("New Village"). */
  resetWorld(): void {
    this.sendCommand({ command: 'reset_world' });
  }

  // -------------------------------------------------------------------------

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (message.kind) {
      case 'world.init':
        this.view.width = message.width;
        this.view.height = message.height;
        this.view.tickRate = message.tickRate;
        this.view.trees = message.trees;
        this.view.buildings = message.buildings;
        this.view.weather = message.weather;
        this.view.palette = message.palette ?? null;
        this.view.rivalPalette = message.rivalPalette ?? null;
        this.view.paletteSplitX = message.paletteSplitX ?? null;
        this.onWeather?.(message.weather);
        this.onTheme?.(message.theme ?? '', message.setting ?? '');
        // The world exists now: dismiss any generation overlay.
        this.onWorldInit?.();
        break;
      case 'world.generating':
        this.onGenerating?.(message);
        break;
      case 'world.needs_setup':
        this.onNeedsSetup?.(message);
        break;
      case 'world.style_preview':
        this.onStylePreview?.(message);
        break;
      case 'world.state_update':
        this.view.tick = message.tick;
        this.view.villagers = message.villagers;
        this.view.carts = message.carts ?? [];
        this.view.gatherings = message.gatherings ?? [];
        // Buildings are static (cached from world.init), but their stock drifts
        // every tick — overlay the per-tick stock onto the cached buildings so the
        // renderer can draw live resource levels and "empty" states.
        this.applyBuildingStocks(message.buildingStocks ?? []);
        this.onStateUpdate?.(message.villagers, this.view.gatherings);
        this.onClock?.(message.tick);
        break;
      case 'world.weather':
        this.view.weather = message.weather;
        this.onWeather?.(message.weather);
        break;
      case 'villager.thought':
        this.onThought?.(message);
        break;
      case 'conversation.updated':
        this.onConversation?.(message.conversation);
        break;
      case 'building.event':
        this.onBuildingEvent?.(message.event);
        break;
      case 'sim.tick':
        this.onSimTick?.(message.tick, message.acting, message.cooldown);
        break;
      case 'engine.llm.started':
        this.onEngineCallStarted?.(message);
        break;
      case 'engine.llm.delta':
        this.onEngineCallDelta?.(message);
        break;
      case 'engine.llm.finished':
        this.onEngineCallFinished?.(message);
        break;
      case 'supervisor.prayer':
        this.onPrayer?.(message);
        break;
      case 'supervisor.action':
        this.onSupervisorAction?.(message);
        break;
      case 'supervisor.daily_report':
        this.onDailyReport?.(message);
        break;
      case 'village.score':
        this.onScoreboard?.(message.scoreboard);
        break;
      case 'village.census':
        this.onVillageCensus?.(message.villages, message.day, message.tick);
        break;
      case 'village.alert':
        this.onVillageAlert?.(message.villageId, message.event);
        break;
      case 'relationship.updated':
        this.onRelationship?.(message);
        break;
      case 'group_plan.updated':
        this.onGroupPlan?.(message);
        break;
      case 'agenda.updated':
        this.onAgendaUpdate?.(message.item);
        break;
      case 'agenda.removed':
        this.onAgendaRemoved?.(message.itemId);
        break;
      case 'reasoning.effort':
        this.onReasoningEffort?.(message.settings);
        break;
      case 'llm.pool':
        this.onLlmPool?.(message.config);
        break;
      case 'llm.model':
        this.onLlmModel?.(message.config);
        break;
      // No default needed: ServerMessage is a closed union.
    }
  }

  /**
   * Overlay the per-tick building stream onto the cached static buildings: the live
   * resource stock, plus the war-layer state (structural `life`, gate `open`/held, and
   * `siegeProgress`) so damage bars, breaches and barred gates show live.
   */
  private applyBuildingStocks(stocks: BuildingStock[]): void {
    if (stocks.length === 0) return;
    const byId = new Map(stocks.map((s) => [s.id, s]));
    for (const b of this.view.buildings) {
      const upd = byId.get(b.id);
      if (!upd) continue;
      b.stock = upd.stock;
      if (upd.life !== undefined) b.life = upd.life;
      // `open` / `siegeProgress` are only sent while relevant; mirror absence as cleared
      // so a gate that is re-held, or a wall no longer besieged, drops its overlay.
      b.open = upd.open;
      b.siegeProgress = upd.siegeProgress;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }
}
