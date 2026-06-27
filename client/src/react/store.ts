/**
 * client/src/react/store.ts
 * ---------------------------------------------------------------------------
 * The CLIENT STORE — the single owner of every `NetworkClient` callback and the
 * bridge from the imperative WS stream into React.
 *
 * Why an external store (not bare component state): `NetworkClient` exposes
 * SINGLE-ASSIGNMENT `on*` callbacks, so exactly one thing may own each. The store
 * owns them all, accumulates into immutable per-slice snapshots, and lets React
 * read each slice through {@link useSyncExternalStore}. Components subscribe only
 * to the slices they use, so a token-rate engine delta never re-renders the
 * topbar, and a per-tick world update never re-renders the LLM telemetry.
 *
 * A few imperative SINKS (the Canvas Renderer's thought/engine pulses, the setup +
 * generation overlays) are fed straight through, because those surfaces stay
 * outside React. They're passed in once at construction.
 * ---------------------------------------------------------------------------
 */

import type { NetworkClient } from '../NetworkClient';
import type {
  EffortPurpose,
  LlmCallFinishedMessage,
  LlmCallPurpose,
  LlmCallStartedMessage,
  LlmModelConfig,
  LlmPoolConfig,
  ReasoningEffort,
  ReasoningEffortSettings,
  SupervisorActionMessage,
  SupervisorPrayerMessage,
  Villager,
  VillageCensus,
  VillageScoreboard,
  WeatherKind,
  WorldGeneratingMessage,
  WorldNeedsSetupMessage,
  WorldStylePreviewMessage,
  VillagerThoughtMessage,
} from '../../../shared/types';
import { selectVillages, type AlertVM, type VillageVM } from './villageModel';
import { splitThink, joinThink, estimateThinkTokens } from '../llmThink';

/** Imperative surfaces kept outside React, fed straight off the stream. */
export interface StoreSinks {
  onThought?: (t: VillagerThoughtMessage) => void;
  onEngineStarted?: (c: LlmCallStartedMessage) => void;
  onEngineFinished?: (c: LlmCallFinishedMessage) => void;
  onNeedsSetup?: (m: WorldNeedsSetupMessage) => void;
  onStylePreview?: (m: WorldStylePreviewMessage) => void;
  onGenerating?: (m: WorldGeneratingMessage) => void;
  onWorldInit?: () => void;
}

/** A finished engine call enriched with the start event's context + a think estimate. */
export interface FinishedCall extends LlmCallFinishedMessage {
  agent: string;
  request: string;
  thinkTokensEst?: number;
  effort?: ReasoningEffort;
}

/** Header tally for the engine telemetry window. */
export interface EngineTally {
  live: number;
  ok: number;
  err: number;
  avgMs: number;
  tokIn: number;
  tokOut: number;
  tokThink: number;
}

/** Per-purpose call stats for the telemetry filter chips. */
export type PurposeStats = Partial<Record<LlmCallPurpose, { count: number; totalMs: number; err: number }>>;

/** The engine telemetry slice. */
export interface EngineSnapshot {
  running: LlmCallStartedMessage[];
  recent: FinishedCall[];
  stats: PurposeStats;
  pool: LlmPoolConfig | null;
  effort: ReasoningEffortSettings | null;
  tally: EngineTally;
}

/** The top-bar environment slice. */
export interface EnvSnapshot {
  tick: number;
  weather: WeatherKind;
  theme: string;
  setting: string;
}

/** A villager option for the god console's bless/smite target picker. */
export interface VillagerOption {
  id: string;
  name: string;
  villageId: string;
}

/** What the map inspector is currently focused on (a clicked villager or building). */
export type Selection = { kind: 'villager' | 'building'; id: string };

const MAX_RECENT = 40;
const MAX_PRAYERS = 60;
const MAX_ACTS = 40;
const MAX_ALERTS = 40;

/** A typed slice: an immutable snapshot + a listener set, read via useSyncExternalStore. */
class Slice<T> {
  private listeners = new Set<() => void>();
  constructor(private snapshot: T) {}
  get = (): T => this.snapshot;
  set = (next: T): void => {
    this.snapshot = next;
    for (const l of this.listeners) l();
  };
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
}

export class ClientStore {
  // ---- React-visible slices ----
  readonly connection = new Slice<boolean>(false);
  readonly env = new Slice<EnvSnapshot>({ tick: 0, weather: 'clear', theme: '', setting: '' });
  readonly villages = new Slice<VillageVM[]>([]);
  readonly villagerOptions = new Slice<VillagerOption[]>([]);
  readonly engine = new Slice<EngineSnapshot>({
    running: [],
    recent: [],
    stats: {},
    pool: null,
    effort: null,
    tally: { live: 0, ok: 0, err: 0, avgMs: 0, tokIn: 0, tokOut: 0, tokThink: 0 },
  });
  readonly model = new Slice<LlmModelConfig | null>(null);
  readonly effortSettings = new Slice<ReasoningEffortSettings | null>(null);
  /** The map inspector's current target (a clicked villager/building), or null. */
  readonly selection = new Slice<Selection | null>(null);

  // ---- Mutable accumulators behind the village slice ----
  private scoreboard: VillageScoreboard | null = null;
  private census: VillageCensus[] = [];
  private prayers: SupervisorPrayerMessage[] = [];
  private actions: SupervisorActionMessage[] = [];
  private alerts: AlertVM[] = [];
  private prayerSeen = new Set<string>();
  private alertSeq = 0;
  private villageDirty = false;
  private villageTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Engine accumulators ----
  private running = new Map<number, LlmCallStartedMessage>();
  private streams = new Map<number, { content: string; reasoning: string }>();
  private recent: FinishedCall[] = [];
  private stats: PurposeStats = {};
  private pool: LlmPoolConfig | null = null;
  private engineEffort: ReasoningEffortSettings | null = null;
  private okCount = 0;
  private errCount = 0;
  private totalMs = 0;
  private finishedCount = 0;
  private tokIn = 0;
  private tokOut = 0;
  private tokThink = 0;

  constructor(
    private readonly net: NetworkClient,
    private readonly sinks: StoreSinks = {},
  ) {
    this.wire();
  }

  /** Focus the map inspector on a clicked villager or building. */
  select(sel: Selection): void {
    this.selection.set(sel);
  }

  /** Clear the map inspector's focus. */
  clearSelection(): void {
    this.selection.set(null);
  }

  /** The live entity behind the current selection, read fresh from the world view. */
  inspected(): { villager?: Villager; building?: import('../../../shared/types').Building } {
    const sel = this.selection.get();
    if (!sel) return {};
    const view = this.net.getState();
    if (sel.kind === 'villager') return { villager: view.villagers.find((v) => v.id === sel.id) };
    return { building: view.buildings.find((b) => b.id === sel.id) };
  }

  /** Assign every `net.on*` callback. The store is the SOLE owner of each. */
  private wire(): void {
    const net = this.net;

    net.onStatusChange = (connected) => this.connection.set(connected);

    net.onClock = (tick) => this.env.set({ ...this.env.get(), tick });
    net.onWeather = (weather) => this.env.set({ ...this.env.get(), weather });
    net.onTheme = (theme, setting) => this.env.set({ ...this.env.get(), theme, setting });

    // World state: feed nothing villager-array-shaped into React; just mark the village
    // model dirty + refresh the (small) target options, both throttled.
    net.onStateUpdate = (villagers) => {
      this.refreshVillagerOptions(villagers);
      this.markVillagesDirty();
    };
    net.onWorldInit = () => {
      this.markVillagesDirty(true);
      this.sinks.onWorldInit?.();
    };

    net.onScoreboard = (scoreboard) => {
      this.scoreboard = scoreboard;
      this.recomputeVillages();
    };
    net.onVillageCensus = (villages) => {
      this.census = villages;
      this.recomputeVillages();
    };
    net.onVillageAlert = (villageId, event) => {
      this.alerts = [{ id: `${villageId}:${event.tick}:${this.alertSeq++}`, villageId, event }, ...this.alerts].slice(
        0,
        MAX_ALERTS,
      );
      this.recomputeVillages();
    };
    net.onPrayer = (prayer) => {
      if (this.prayerSeen.has(prayer.id)) return;
      this.prayerSeen.add(prayer.id);
      this.prayers = [prayer, ...this.prayers].slice(0, MAX_PRAYERS);
      this.recomputeVillages();
    };
    net.onSupervisorAction = (action) => {
      this.actions = [action, ...this.actions].slice(0, MAX_ACTS);
      this.recomputeVillages();
    };

    // Settings echoes.
    net.onLlmModel = (config) => this.model.set(config);
    net.onReasoningEffort = (settings) => {
      this.effortSettings.set(settings);
      this.engineEffort = settings;
      this.pushEngine();
    };

    // Engine telemetry.
    net.onLlmPool = (config) => {
      this.pool = config;
      this.pushEngine();
    };
    net.onEngineCallStarted = (call) => {
      this.running.set(call.id, call);
      this.sinks.onEngineStarted?.(call);
      this.pushEngine();
    };
    net.onEngineCallDelta = (call) => {
      // Accumulate streamed text for a think estimate; deltas never re-render React.
      const buf = this.streams.get(call.id) ?? { content: '', reasoning: '' };
      if (call.content) buf.content += call.content;
      if (call.reasoning) buf.reasoning += call.reasoning;
      this.streams.set(call.id, buf);
    };
    net.onEngineCallFinished = (call) => {
      this.ingestFinish(call);
      this.sinks.onEngineFinished?.(call);
      this.pushEngine();
    };

    // Imperative-only surfaces.
    net.onThought = (t) => this.sinks.onThought?.(t);
    net.onNeedsSetup = (m) => this.sinks.onNeedsSetup?.(m);
    net.onStylePreview = (m) => this.sinks.onStylePreview?.(m);
    net.onGenerating = (m) => this.sinks.onGenerating?.(m);
  }

  // ---- Villages ----

  private refreshVillagerOptions(villagers: Villager[]): void {
    const next: VillagerOption[] = villagers.map((v) => ({
      id: v.id,
      name: v.name || v.id,
      villageId: v.villageId ?? 'village_0',
    }));
    const prev = this.villagerOptions.get();
    // Only push when the id/name/village set actually changed (cheap stable-ish check).
    if (prev.length !== next.length || next.some((o, i) => prev[i]?.id !== o.id || prev[i]?.name !== o.name)) {
      this.villagerOptions.set(next);
    }
  }

  /** Per-tick world updates are frequent; coalesce village recompute onto a short timer. */
  private markVillagesDirty(immediate = false): void {
    this.villageDirty = true;
    if (immediate) {
      this.recomputeVillages();
      return;
    }
    if (this.villageTimer) return;
    this.villageTimer = setTimeout(() => {
      this.villageTimer = null;
      if (this.villageDirty) this.recomputeVillages();
    }, 600);
  }

  private recomputeVillages(): void {
    this.villageDirty = false;
    this.villages.set(
      selectVillages({
        view: this.net.getState(),
        scoreboard: this.scoreboard,
        census: this.census,
        prayers: this.prayers,
        actions: this.actions,
        alerts: this.alerts,
      }),
    );
  }

  // ---- Engine ----

  private ingestFinish(call: LlmCallFinishedMessage): void {
    const started = this.running.get(call.id);
    this.running.delete(call.id);
    const buf = this.streams.get(call.id);
    this.streams.delete(call.id);
    const thinkEst = buf
      ? estimateThinkTokens(joinThink(buf.reasoning, splitThink(buf.content).think))
      : 0;
    const purpose = started?.purpose ?? call.purpose;

    if (call.ok) this.okCount++;
    else this.errCount++;
    this.totalMs += call.durationMs;
    this.finishedCount++;
    if (call.usage) {
      this.tokIn += call.usage.inputTokens;
      this.tokOut += call.usage.outputTokens;
      this.tokThink += call.usage.thinkTokens ?? 0;
    }

    const stat = this.stats[purpose] ?? { count: 0, totalMs: 0, err: 0 };
    stat.count++;
    stat.totalMs += call.durationMs;
    if (!call.ok) stat.err++;
    this.stats = { ...this.stats, [purpose]: stat };

    const effort = this.effortFor(purpose);
    const finished: FinishedCall = {
      ...call,
      purpose,
      label: started?.label ?? call.label,
      agent: started?.agent ?? 'unknown',
      request: started?.request ?? '',
      ...(thinkEst > 0 ? { thinkTokensEst: thinkEst } : {}),
      ...(effort ? { effort } : {}),
    };
    this.recent = [finished, ...this.recent].slice(0, MAX_RECENT);
  }

  private effortFor(purpose: LlmCallPurpose): ReasoningEffort | null {
    if (!this.engineEffort) return null;
    return purpose === 'embed' ? null : this.engineEffort[purpose as EffortPurpose] ?? null;
  }

  /** Publish the engine snapshot (immutable copy) to the slice. */
  private pushEngine(): void {
    this.engine.set({
      running: [...this.running.values()],
      recent: this.recent,
      stats: this.stats,
      pool: this.pool,
      effort: this.engineEffort,
      tally: {
        live: this.running.size,
        ok: this.okCount,
        err: this.errCount,
        avgMs: this.finishedCount > 0 ? Math.round(this.totalMs / this.finishedCount) : 0,
        tokIn: this.tokIn,
        tokOut: this.tokOut,
        tokThink: this.tokThink,
      },
    });
  }
}
