/**
 * supervisor/src/SupervisorService.ts
 * ---------------------------------------------------------------------------
 * Final Phase — "The God Agent". The macro-mind over the whole village.
 *
 * Where an AgentService senses a 5-tile radius and acts every few seconds, the
 * Supervisor senses one DAY at a time and acts on the scale of the whole world.
 * It is a pure consumer/producer on the nervous system and holds no world state:
 *
 *   SENSE  — subscribes to `village.events` (`village.daily_summary`); each
 *            summary is one "what happened in the village today".
 *   THINK  — asks the injected LLMProvider, given the day's vitals + the village
 *            charter, whether the village needs a CHALLENGE, a REWARD, or
 *            nothing — and which single god-tool to use.
 *   ACT    — validates the chosen tool and publishes a `supervisor.*` envelope
 *            (spawn_entity / change_weather -> engine; plant_idea -> a villager).
 *
 * Like the villagers, the LLM has no direct line to the engine or the vector
 * stores: a malformed or absent tool call is logged and dropped, and the god
 * simply waits for tomorrow.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type {
  DivineAct,
  UserCommandEvent,
  VillagerIntentEvent,
  VillageAlertEvent,
  VillagePulseEvent,
  VillageDailySummaryEvent,
  VillageDailySummaryPayload,
  VillageQueryResultEvent,
  SupervisorQueryKind,
  SupervisorDailyReportPayload,
  VillageVision,
} from '../../shared/events';
import type { CompetitionIntensity, DigestEvent, LlmMessage, VillageMilestone, VillagePolicy, VillageOrder } from '../../shared/types';
import { DEFAULT_VILLAGE_ID } from '../../shared/types';
import type { LLMProvider, LLMTurn } from '../../agent/src/llm/LLMProvider';
import type { Synthesizer } from '../../agent/src/memory/Synthesizer';
import { formatSimClock } from '../../shared/simClock';
import { MalformedToolCallError } from '../../agent/src/tools';
import { GOD_TOOLS, isReadGodTool, parseGodDecision, type GodDecision } from './tools';
import {
  buildAlertMessage,
  buildCharterPrompt,
  buildChosenPrayerMessage,
  buildChronicleSystemPrompt,
  buildChronicleUserMessage,
  buildDeliberationRecord,
  buildPetitionMessage,
  buildStrategyReflectionSystem,
  buildStrategyReflectionUser,
  buildSummaryMessage,
  buildSupervisorMemoryBlock,
  buildVisionSystemPrompt,
  buildVisionUserMessage,
  parseVisionAssessment,
  type PendingPrayer,
} from './prompt';
import type { SupervisorMemory } from './SupervisorMemory';

/** Cap on tracked prayers, so a long-running god never grows the list unbounded. */
const MAX_PENDING_PRAYERS = 50;

/** Min gap (ms) between alert-driven out-of-cadence deliberations, so crises can't spam the god. */
const ALERT_COOLDOWN_MS = supEnvMs('SUPERVISOR_ALERT_COOLDOWN_MS', 45_000);
function supEnvMs(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function supEnvInt(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
}

/**
 * Hard cap on assistant turns in the god's agentic deliberation loop (env-tunable via
 * `SUPERVISOR_MAX_STEPS`). The god is now a ReAct agent — it INVESTIGATES with read tools
 * before it acts — so the loop must be roomy enough for several lookups plus a couple of
 * acts. Bounded by the read + action budgets below, which the loop enforces directly.
 */
const SUP_MAX_STEPS = supEnvInt('SUPERVISOR_MAX_STEPS', 14, 1, 24);

/**
 * How many read-only LOOKUPS the god may run in one deliberation before it is told to act on
 * what it already knows. Generous (investigation is free and is the whole point), but capped
 * so a model that only ever looks can't deliberate forever (env `SUPERVISOR_MAX_READS`).
 */
const SUP_MAX_READS = supEnvInt('SUPERVISOR_MAX_READS', 8, 0, 20);

/**
 * How many world-changing ACTS the god may chain in one deliberation before further action
 * tools are withheld and it is pushed to yield. Kept small — the god acts on the scale of the
 * world (env `SUPERVISOR_MAX_ACTIONS`).
 */
const SUP_MAX_ACTIONS = supEnvInt('SUPERVISOR_MAX_ACTIONS', 3, 1, 8);

/** How long the god waits for the read-model to answer a live lookup before giving up (ms). */
const SUP_QUERY_TIMEOUT_MS = supEnvMs('SUPERVISOR_QUERY_TIMEOUT_MS', 4_000);

/**
 * A minimal key/value persistence seam (structurally satisfied by the server's
 * `RuntimeStateStore`). Declared locally so the supervisor stays decoupled from
 * the server package while still being able to remember its state across reboots.
 */
export interface SupervisorStatePersistence {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

/** What a night's growth assessment newly judged, handed to the chronicle to narrate. */
interface GrowthOutcome {
  /** The stage named this night, if the god judged one (else the stage held steady). */
  stage?: string;
  /** Milestones newly recorded this day (objective builds + the god's readings). */
  newMilestones: VillageMilestone[];
}

/** The slice of supervisor state persisted across restarts. */
interface PersistedSupervisorState {
  /** Day of the last intervention; null encodes "never acted" (no finite day). */
  lastActedDay: number | null;
  pending: PendingPrayer[];
  lastSummary: VillageDailySummaryPayload | null;
  /** Whether the human has paused the autonomous LLM supervisor (v3 §8 override). */
  paused?: boolean;
}

/** The runtime-state key the supervisor stores its state under. */
const SUPERVISOR_STATE_KEY = 'supervisor';

/** The runtime-state key the village's shared VISION is persisted under. */
const VILLAGE_VISION_KEY = 'village-vision';

/** The runtime-state key the village's standing POLICY (priority weights) is persisted under. */
const VILLAGE_POLICY_KEY = 'village-policy';

/** Most milestones to keep on the vision, so the record never grows unbounded. */
const MAX_MILESTONES = 60;

/** The stage a brand-new village starts at, before the god has judged any growth. */
const INITIAL_STAGE = 'a scattering of homesteads';

export interface SupervisorOptions {
  /**
   * Which village this god governs (v3 rival-village seam, design §10). It reads only
   * THIS village's daily summaries + alerts, namespaces its persisted state + durable
   * queue by it, and tags every steer (policy / order / vision) with it so only its own
   * villagers obey. Defaults to {@link DEFAULT_VILLAGE_ID} — the single-village god, whose
   * state + queue keep the original un-namespaced names so existing saves resume.
   */
  villageId?: string;
  /** The village's standing narrative directive — the god's "goal". */
  charter?: string;
  /**
   * v3 — this side's RAID STANCE, chosen at setup in a two-village world (peaceful /
   * balanced / aggressive). A soft nudge folded into the charter so the god raids more
   * or less readily; ignored without a rival. Omit for the even-handed default.
   */
  competitionIntensity?: CompetitionIntensity;
  /** Don't intervene more than once every N days (anti-thrash). Default 1. */
  minDaysBetweenActs?: number;
  /** Optional durable store so the god's cooldown + pending prayers survive a reboot. */
  state?: SupervisorStatePersistence;
  /**
   * Optional free-text seam the god uses to AUTHOR the nightly chronicle. When
   * supplied, every day's summary yields a `village.daily_report` for the UI,
   * independent of whether the god intervenes. Omit to skip the chronicle.
   */
  chronicler?: Synthesizer;
  /**
   * v3 P4 — the god's LONG-TERM MEMORY. When supplied, the god records each day's
   * deliberation, recalls similar past days before deliberating, and distils a
   * standing strategic lesson each night. Omit for a god that reasons only from the
   * day in front of it (the pre-P4 behaviour).
   */
  memory?: SupervisorMemory;
}

export class SupervisorService {
  /** The village this god governs (v3 rival-village seam). */
  private readonly villageId: string;
  private readonly system: string;
  private readonly minGap: number;
  /** Optional durable store for the god's state (cooldown, prayers, last summary). */
  private readonly state?: SupervisorStatePersistence;
  /** Optional free-text seam for authoring the nightly chronicle. */
  private readonly chronicler?: Synthesizer;
  /**
   * v3 P4 — the god's long-term memory, or undefined when it reasons day-to-day only.
   * Not readonly: if the vector store is unreachable at startup we drop to memory-less
   * mode rather than failing the supervisor (see {@link start}).
   */
  private memory?: SupervisorMemory;
  /** The chronicle's stable system prompt (good cache prefix), built once. */
  private readonly chronicleSystem: string;
  /** The growth-assessment's stable system prompt (good cache prefix), built once. */
  private readonly visionSystem: string;
  /** The strategy-reflection's stable system prompt (good cache prefix), built once. */
  private readonly strategySystem: string;
  /**
   * The village's shared VISION — its stage of growth toward a city and the milestones
   * reached. Reassessed each night, persisted across reboots, and broadcast to every
   * villager so the collective goal stays in front of them. Starts empty.
   */
  private vision: VillageVision = { stage: '', milestones: [], updatedDay: 0 };
  /**
   * v3 — the village's standing POLICY: the priority weights the supervisor steers with.
   * Updated by the `set_priorities` tool, broadcast to every villager (the utility brain
   * reads it), and persisted across reboots. Starts empty (the village runs neutral).
   */
  private policy: VillagePolicy = { weights: {} };
  /**
   * Whether DRAMA (spawn/weather/plant) is permitted in the current deliberation. The
   * everyday `set_priorities` lever is always allowed; the dramatic tools are gated by
   * the daily cool-off (a force-run / chosen prayer lifts the gate). Set before each
   * deliberation, read by {@link act}.
   */
  private dramaAllowed = true;
  /** Whether a DRAMATIC tool actually fired in the current deliberation (advances the cool-off). */
  private dramaUsed = false;
  /** Day of the last DRAMATIC intervention; the god cools off for `minGap` days after. */
  private lastActedDay = Number.NEGATIVE_INFINITY;
  /**
   * v3 §8 — when true the human has SEIZED the wheel: the autonomous daily deliberation is
   * skipped (no policy/drama on its own), though the chronicle still runs and the human's
   * own force-runs + divine powers still work. Persisted across reboots.
   */
  private paused = false;
  /** Monotonic counter for stamping a unique id onto each order the god issues. */
  private orderSeq = 0;
  /**
   * v3 P4 — wall-clock ms of the last alert-driven (out-of-cadence) deliberation, to
   * throttle interrupts: even though the engine's hysteresis fires each crisis once, two
   * distinct crises in quick succession shouldn't both wake the god. One interrupt per
   * {@link ALERT_COOLDOWN_MS} window.
   */
  private lastAlertAt = 0;
  /** Guards against overlapping thoughts (one god, one thought at a time). */
  private thinking = false;
  /**
   * In-flight live LOOKUPS, keyed by the query's correlation id. The agentic loop publishes a
   * `supervisor.query`, parks a resolver here, and the `village.query_result` handler wakes it
   * when the read-model answers (or a timeout resolves it with a "no answer" note). The map is
   * the only state the request/reply seam needs over the otherwise fire-and-forget bus.
   */
  private readonly pendingQueries = new Map<string, (summary: string) => void>();
  /** The most recent daily summary, so a force-run has context even with no prayers. */
  private lastSummary: VillageDailySummaryPayload | null = null;
  /** Divine acts taken during the CURRENT day, for the next chronicle's ledger. */
  private actsToday: DivineAct[] = [];
  /**
   * Every prayer still awaiting an answer, oldest first — fed live from the
   * temple. Both paths draw on this: the human picks ONE to grant (the rest are
   * dismissed), and an autonomous run weighs them all and answers at most one.
   * Whenever a prayer IS answered the whole list is cleared — only one is heard.
   */
  private readonly pending: PendingPrayer[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly provider: LLMProvider,
    options: SupervisorOptions = {},
  ) {
    this.villageId = options.villageId ?? DEFAULT_VILLAGE_ID;
    this.system = buildCharterPrompt(options.charter, options.competitionIntensity);
    this.minGap = options.minDaysBetweenActs ?? 1;
    this.state = options.state;
    this.chronicler = options.chronicler;
    this.memory = options.memory;
    this.chronicleSystem = buildChronicleSystemPrompt(options.charter);
    this.visionSystem = buildVisionSystemPrompt(options.charter);
    this.strategySystem = buildStrategyReflectionSystem(options.charter);
  }

  /**
   * Namespace a persistence key / queue name by village. The single-village god
   * ({@link DEFAULT_VILLAGE_ID}) keeps the original un-namespaced name, so an existing
   * deployment's persisted state + durable queue resume untouched; a rival appends its id.
   */
  private keyFor(base: string): string {
    return this.villageId === DEFAULT_VILLAGE_ID ? base : `${base}:${this.villageId}`;
  }

  /**
   * Whether a village-tagged event belongs to THIS god. An untagged event (no villageId)
   * is treated as the {@link DEFAULT_VILLAGE_ID}, so a pre-seam producer still reaches the
   * single-village god.
   */
  private ownVillage(villageId?: string): boolean {
    return (villageId ?? DEFAULT_VILLAGE_ID) === this.villageId;
  }

  async start(): Promise<void> {
    // Restore the god's memory of itself first, so a reboot doesn't reset the
    // cooldown or forget pending prayers. Best-effort: a fresh store yields null.
    await this.restoreState();

    // v3 P4 — make the god's long-term memory ready before any recall/ingest. If the
    // vector store is unreachable, don't take the supervisor down: log it and run the
    // god WITHOUT memory (it still steers from each day's vitals), exactly as a villager
    // degrades to amnesiac when Qdrant is down.
    if (this.memory) {
      try {
        await this.memory.init();
        console.log(`[supervisor] long-term memory ready (${this.memory.name})`);
      } catch (err) {
        console.warn('[supervisor] long-term memory unavailable, reasoning day-to-day only:', errMsg(err));
        this.memory = undefined;
      }
    }

    // Durable, NAMED queue: the god must never miss a day's summary, even across
    // a restart (unlike a villager, who wants only fresh perception).
    await this.bus.subscribe<VillageDailySummaryEvent>(
      EXCHANGES.villageEvents,
      'village.daily_summary',
      (event) => {
        // The aggregator emits one summary per village; read only this god's own.
        if (!this.ownVillage(event.payload.villageId)) return;
        void this.onDailySummary(event.payload);
      },
      { queue: this.keyFor('supervisor.village.summaries'), durable: true },
    );

    // v3 P4 (design §8) — a high-salience world event interrupts the daily cadence. The
    // engine fires `village.alert` the moment a crisis sets in; the god wakes and answers
    // it out of turn. Exclusive queue — a crisis is acted on live, not replayed from a
    // backlog after a restart (the next daily summary will reflect the standing state).
    await this.bus.subscribe<VillageAlertEvent>(
      EXCHANGES.villageEvents,
      'village.alert',
      (event) => {
        // A crisis wakes only the god of the village it struck.
        if (!this.ownVillage(event.payload.villageId)) return;
        void this.onAlert(event.payload);
      },
    );

    // v3 — the real-time HEARTBEAT: a live digest several times an hour so the god keeps
    // the village in motion between the ~40-minute day rollovers. A pure policy/order nudge
    // (no chronicle, vision or memory bookkeeping — that stays daily). Exclusive queue:
    // a pulse is acted on live, never replayed from a backlog after a restart.
    await this.bus.subscribe<VillagePulseEvent>(
      EXCHANGES.villageEvents,
      'village.pulse',
      (event) => {
        if (!this.ownVillage(event.payload.villageId)) return;
        void this.onPulse(event.payload);
      },
    );

    // The agentic loop's live LOOKUPS come back here: the read-model (aggregator) answers a
    // `supervisor.query` with a `village.query_result` keyed by the request's correlation id.
    // Exclusive queue — a result is awaited live by the in-flight deliberation, never replayed.
    await this.bus.subscribe<VillageQueryResultEvent>(
      EXCHANGES.villageEvents,
      'village.query_result',
      (event) => {
        const resolver = this.pendingQueries.get(event.payload.queryId);
        if (!resolver) return; // not ours, or already timed out
        this.pendingQueries.delete(event.payload.queryId);
        resolver(event.payload.summary);
      },
    );

    // The temple-console control channel: the human god's per-prayer verdicts and
    // force-run nudges. Multi-word keys the engine's `user.*` binding skips. An
    // exclusive queue — these are live control inputs, no backlog wanted.
    await this.bus.subscribe<UserCommandEvent>(
      EXCHANGES.userCommands,
      'user.supervisor.*',
      (event) => this.onConsoleCommand(event),
    );

    // The live PRAYER stream: every petition offered at the temple, so the god
    // (and the human at the console) has the full set of pending prayers to
    // choose ONE from. Exclusive queue — only fresh prayers, no backlog.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.pray',
      (event) => this.onPrayer(event),
    );

    // Announce the restored (or empty) vision now that the village stream is bound, so
    // villagers already running pick up the collective goal + progress immediately,
    // rather than waiting for the first night's reassessment.
    this.broadcastVision();

    // Likewise re-announce the restored standing policy, so a reboot resumes steering the
    // village from where it left off rather than snapping back to neutral until the next day.
    this.broadcastPolicy();

    console.log(
      `[supervisor:${this.villageId}] online via ${this.provider.name}; minDaysBetweenActs=${this.minGap}; ` +
        `village stage: "${this.vision.stage || INITIAL_STAGE}"`,
    );
  }

  // -------------------------------------------------------------------------
  // Durable state: the god remembers its cooldown + pending prayers across reboot
  // -------------------------------------------------------------------------

  /** Reload persisted state on boot (best-effort; a fresh store yields nothing). */
  private async restoreState(): Promise<void> {
    if (!this.state) return;
    try {
      const saved = await this.state.get<PersistedSupervisorState>(this.keyFor(SUPERVISOR_STATE_KEY));
      if (!saved) return;
      // null encodes "never acted", which can't be stored as -Infinity (not JSON).
      this.lastActedDay = saved.lastActedDay ?? Number.NEGATIVE_INFINITY;
      this.lastSummary = saved.lastSummary ?? null;
      this.paused = saved.paused ?? false;
      this.pending.length = 0;
      this.pending.push(...(saved.pending ?? []));
      console.log(
        `[supervisor] restored state: lastActedDay=${saved.lastActedDay ?? 'never'}, ` +
          `${this.pending.length} pending prayer(s)`,
      );
    } catch (err) {
      console.warn('[supervisor] failed to restore state:', errMsg(err));
    }
    // The shared vision lives under its own key (it is broadcast to villagers, not just
    // the god's private bookkeeping), so a reboot resumes the settlement's growth.
    try {
      const savedVision = await this.state.get<VillageVision>(this.keyFor(VILLAGE_VISION_KEY));
      if (savedVision) {
        this.vision = {
          stage: savedVision.stage ?? '',
          milestones: savedVision.milestones ?? [],
          updatedDay: savedVision.updatedDay ?? 0,
        };
        console.log(
          `[supervisor] restored vision: stage="${this.vision.stage}", ` +
            `${this.vision.milestones.length} milestone(s)`,
        );
      }
    } catch (err) {
      console.warn('[supervisor] failed to restore vision:', errMsg(err));
    }
    // The standing policy lives under its own key (it is broadcast to villagers, not the
    // god's private bookkeeping), so a reboot resumes steering rather than reverting to neutral.
    try {
      const savedPolicy = await this.state.get<VillagePolicy>(this.keyFor(VILLAGE_POLICY_KEY));
      if (savedPolicy?.weights) {
        this.policy = {
          weights: savedPolicy.weights,
          ...(savedPolicy.rationale ? { rationale: savedPolicy.rationale } : {}),
          ...(savedPolicy.day !== undefined ? { day: savedPolicy.day } : {}),
        };
        console.log(
          `[supervisor] restored policy: ${Object.keys(this.policy.weights).length} priority weight(s)`,
        );
      }
    } catch (err) {
      console.warn('[supervisor] failed to restore policy:', errMsg(err));
    }
  }

  /** Persist the god's state after a mutation (fire-and-forget; never blocks). */
  private async persistState(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.set<PersistedSupervisorState>(this.keyFor(SUPERVISOR_STATE_KEY), {
        // -Infinity isn't JSON; persist "never acted" as null.
        lastActedDay: Number.isFinite(this.lastActedDay) ? this.lastActedDay : null,
        pending: this.pending.slice(),
        lastSummary: this.lastSummary,
        paused: this.paused,
      });
    } catch (err) {
      console.warn('[supervisor] failed to persist state:', errMsg(err));
    }
  }

  // -------------------------------------------------------------------------
  // The human temple console: curate petitions, force the god to act now
  // -------------------------------------------------------------------------

  /** Track one freshly-offered prayer so both paths can choose from the full set. */
  private onPrayer(event: VillagerIntentEvent): void {
    if (event.type !== 'villager.pray') return;
    const p = event.payload;
    if (this.pending.some((q) => q.id === event.eventId)) return; // de-dupe re-delivery
    this.pending.push({
      id: event.eventId,
      villagerName: p.villagerName ?? p.villagerId,
      message: p.message,
    });
    if (this.pending.length > MAX_PENDING_PRAYERS) this.pending.shift();
    void this.persistState();
  }

  private onConsoleCommand(event: UserCommandEvent): void {
    // Route to the addressed village's god (v3 rival seam). The console stamps a
    // `villageId` on each console command; an untagged command (single-village world)
    // defaults to {@link DEFAULT_VILLAGE_ID}, which only the home god owns — so legacy
    // behaviour is unchanged and a rival god never answers the other village's prayers.
    if (
      (event.type === 'user.supervisor.verdict' ||
        event.type === 'user.supervisor.force_run' ||
        event.type === 'user.supervisor.pause') &&
      !this.ownVillage(event.payload.villageId)
    ) {
      return;
    }
    if (event.type === 'user.supervisor.verdict') {
      const p = event.payload;
      if (p.verdict === 'choose') {
        // The human god GRANTS this one prayer: answer it, and dismiss the rest —
        // only one prayer is ever heard. Use the live entry if we have it (its
        // tracked name), else fall back to the verdict's own fields.
        const chosen: PendingPrayer = this.pending.find((q) => q.id === p.prayerId) ?? {
          id: p.prayerId,
          villagerName: p.villagerName,
          message: p.message,
        };
        console.log(
          `[supervisor] prayer CHOSEN from ${chosen.villagerName}: "${chosen.message}" ` +
            `(${this.pending.length - 1} other(s) dismissed)`,
        );
        void this.answerChosen(chosen);
      } else {
        // A lone rejection: drop just this prayer, leave the rest pending.
        const before = this.pending.length;
        const idx = this.pending.findIndex((q) => q.id === p.prayerId);
        if (idx >= 0) this.pending.splice(idx, 1);
        console.log(
          `[supervisor] prayer REJECTED from ${p.villagerName}: "${p.message}" ` +
            `(${before - this.pending.length} dropped, ${this.pending.length} still pending)`,
        );
        void this.persistState();
      }
      return;
    }
    if (event.type === 'user.supervisor.force_run') {
      void this.forceRun();
      return;
    }
    if (event.type === 'user.supervisor.pause') {
      // The human seizes (or releases) the wheel — pause/resume the autonomous god.
      this.paused = event.payload.paused;
      console.log(`[supervisor] ${this.paused ? 'PAUSED by the human — autonomous god is at rest' : 'RESUMED — autonomous god is back'}`);
      void this.persistState();
    }
  }

  /**
   * Answer the ONE prayer the human chose, then clear every pending prayer — the
   * others go unheard this time. The queue is drained whether or not the god
   * actually called a tool: the choice has been made and the moment has passed.
   */
  private async answerChosen(chosen: PendingPrayer): Promise<void> {
    // A human-chosen prayer is granted now, cool-off be damned — lift the drama gate.
    this.dramaAllowed = true;
    this.dramaUsed = false;
    await this.deliberate(buildChosenPrayerMessage(chosen), 'chosen prayer: ');
    this.pending.length = 0;
    void this.persistState();
  }

  /**
   * Deliberate NOW, ignoring the daily cool-off. With prayers pending, the god
   * weighs them all and answers at most one; the whole queue is then cleared so
   * only a single prayer is ever granted. With none, it surveys the last summary.
   */
  private async forceRun(): Promise<void> {
    // A force-run ignores the cool-off — every tool is on the table.
    this.dramaAllowed = true;
    this.dramaUsed = false;
    const userMessage =
      this.pending.length > 0
        ? buildPetitionMessage(this.pending)
        : this.lastSummary
          ? buildSummaryMessage(this.lastSummary, { policy: this.policy, dramaAllowed: true })
          : 'The high temple bids you act now. Survey your village and, if it is ' +
            'wanting, take exactly one action — otherwise call no tool.';
    console.log(`[supervisor] FORCE RUN over ${this.pending.length} pending prayer(s)`);
    await this.deliberate(userMessage);
    // A granted prayer (a dramatic act) dismisses the rest; a policy-only run leaves them.
    if (this.dramaUsed && this.pending.length > 0) this.pending.length = 0;
    void this.persistState();
  }

  // -------------------------------------------------------------------------
  // v3 P4 — the interrupt: a crisis wakes the god mid-day (design §8)
  // -------------------------------------------------------------------------

  /**
   * A high-salience world event (a famine setting in, the larder run dry) reached the
   * god mid-day. Deliberate on it NOW rather than waiting for the nightly survey — this
   * is the "+ on events" half of the periodic-plus-events cadence. Skipped while the
   * human holds the wheel (paused) or within the interrupt cool-off; drama is unlocked
   * because a crisis is exactly when the god may need more than a priority nudge.
   */
  private async onAlert(event: DigestEvent): Promise<void> {
    if (this.paused) return; // the human is steering; their console still force-runs
    if (this.thinking) return; // already mid-thought — the crisis is in front of it anyway
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_COOLDOWN_MS) {
      console.log(`[supervisor] alert ignored (cool-off): ${event.text}`);
      return;
    }
    this.lastAlertAt = now;
    // A crisis lifts the drama gate: the god may stage drama if a priority shift won't do.
    this.dramaAllowed = true;
    this.dramaUsed = false;
    console.log(`[supervisor] ALERT — waking to "${event.text}"`);
    await this.deliberate(
      buildAlertMessage(event, this.lastSummary ?? undefined, { policy: this.policy, dramaAllowed: true }),
      'alert: ',
    );
    // An alert deliberation is OUT of the daily cadence: it does NOT advance `lastActedDay`
    // (the daily cool-off), so the nightly survey still happens. Persist any policy change.
    void this.persistState();
  }

  /**
   * v3 — the real-time HEARTBEAT. A live digest arrived between day rollovers; re-tune the
   * standing policy and issue any standing ORDERS the current vitals call for, so the god
   * keeps directing the village several times an hour. DRAMA stays day-gated (a pulse never
   * lifts the cool-off — that is for the daily survey and true crises), and no day bookkeeping
   * runs. Skipped while paused or mid-thought; the freshest digest is always cached for recall.
   */
  private async onPulse(summary: VillageDailySummaryPayload): Promise<void> {
    this.lastSummary = summary; // keep recall + force-run working off the freshest vitals
    if (this.paused || this.thinking) return;
    this.dramaAllowed = false; // a heartbeat is the everyday steer — priorities + orders only
    this.dramaUsed = false;
    await this.deliberate(
      buildSummaryMessage(summary, { policy: this.policy, dramaAllowed: false }),
      'pulse: ',
    );
    void this.persistState();
  }

  // -------------------------------------------------------------------------
  // SENSE + THINK
  // -------------------------------------------------------------------------

  private async onDailySummary(summary: VillageDailySummaryPayload): Promise<void> {
    this.lastSummary = summary;

    // FIRST, reassess how city-like the village has become: append any milestones it
    // reached today, name its stage anew, persist + broadcast the updated vision so
    // every villager carries the fresh collective goal into tomorrow.
    const growth = await this.assessGrowth(summary);

    // THEN author the day's chronicle for the UI — every day, independent of the
    // intervention cool-off. It reads the day's vitals + the acts the god took during
    // it + the freshly-judged stage; then the day's slate of acts resets.
    await this.publishChronicle(summary, growth);
    this.actsToday = [];

    // v3 §8 — while the human holds the wheel the autonomous god does not deliberate; the
    // chronicle still ran above, and the human can still force-run / wield divine powers.
    if (this.paused) {
      void this.persistState();
      return;
    }

    // v3 — the god now surveys EVERY day to tune the standing policy (the cheap, everyday
    // steer). DRAMA (spawn/weather/plant) stays gated by the cool-off: while at rest the
    // god may only adjust priorities. The prompt reflects what is permitted today.
    this.dramaAllowed = summary.day - this.lastActedDay >= this.minGap;
    this.dramaUsed = false;

    // With prayers pending AND free to act, the day's deliberation IS the god choosing one
    // to answer; otherwise (or while at rest) it judges the day's vitals and tunes policy.
    const userMessage =
      this.dramaAllowed && this.pending.length > 0
        ? buildPetitionMessage(this.pending)
        : buildSummaryMessage(summary, { policy: this.policy, dramaAllowed: this.dramaAllowed });
    await this.deliberate(userMessage, `day ${summary.day}: `);
    if (this.dramaUsed) {
      this.lastActedDay = summary.day;
      // One prayer answered for the day — the rest go unheard, the slate resets.
      this.pending.length = 0;
    }

    // v3 P4 — commit this day's deliberation to long-term memory (the situation + what
    // the god decided, read off `actsToday`, which holds exactly this deliberation's
    // acts now the chronicle reset it above), then distil the recent days into a fresh
    // standing strategy. Both are best-effort and never block the day's bookkeeping.
    void this.rememberDay(summary);

    void this.persistState();
  }

  /**
   * Record the day's deliberation and refresh the standing strategy in long-term
   * memory. Fire-and-forget: a memory hiccup must never stall the daily loop, so all
   * failures are swallowed inside the memory layer and we only await sequentially here
   * so the record lands before the reflection reads it.
   */
  private async rememberDay(summary: VillageDailySummaryPayload): Promise<void> {
    if (!this.memory) return;
    const meta = { tick: summary.tick, day: summary.day };
    try {
      const record = buildDeliberationRecord(summary, this.actsToday, this.policy);
      await this.memory.rememberDeliberation(record, meta);
      const lesson = await this.memory.reflect(
        { system: this.strategySystem, build: buildStrategyReflectionUser },
        meta,
      );
      if (lesson) console.log(`[supervisor] day ${summary.day} strategy: "${lesson}"`);
    } catch (err) {
      console.warn('[supervisor] failed to update long-term memory:', errMsg(err));
    }
  }

  // -------------------------------------------------------------------------
  // The nightly CHRONICLE — a beautiful, human-facing report of the day
  // -------------------------------------------------------------------------

  /**
   * Author the day's mythic chronicle (if a chronicler is configured) and publish
   * it as a `village.daily_report` for the UI. Best-effort: a failed or absent
   * synthesis still publishes a report with an empty narrative, so the window
   * always has the day's ledger even when the LLM is unavailable.
   */
  private async publishChronicle(
    summary: VillageDailySummaryPayload,
    growth: GrowthOutcome,
  ): Promise<void> {
    const narrative = await this.writeNarrative(summary, growth);
    const report: SupervisorDailyReportPayload = {
      day: summary.day,
      tick: summary.tick,
      dateLabel: formatSimClock(summary.tick),
      narrative,
      metrics: {
        population: summary.population,
        conversations: summary.conversations,
        movements: summary.movements,
        idleVillagers: summary.idleVillagers,
        weather: summary.weather,
      },
      quotes: summary.notableQuotes ?? [],
      prayers: summary.notablePrayers ?? [],
      divineActs: this.actsToday.slice(),
      ...(growth.stage ? { villageStage: growth.stage } : {}),
      ...(growth.newMilestones.length > 0 ? { newMilestones: growth.newMilestones } : {}),
    };
    this.bus.publish(EXCHANGES.villageEvents, makeEvent('village.daily_report', report));
    console.log(`[supervisor] chronicle for day ${summary.day} published`);
  }

  /** Ask the chronicler for the day's prose; empty string if none/failed. */
  private async writeNarrative(
    summary: VillageDailySummaryPayload,
    growth: GrowthOutcome,
  ): Promise<string> {
    if (!this.chronicler) return '';
    try {
      const text = await this.chronicler.synthesize({
        system: this.chronicleSystem,
        user: buildChronicleUserMessage(summary, this.actsToday, {
          ...(growth.stage ? { stage: growth.stage } : {}),
          newMilestones: growth.newMilestones,
        }),
        agent: 'God Agent',
        purpose: 'reflect',
      });
      return text.trim();
    } catch (err) {
      console.warn('[supervisor] chronicle synthesis failed:', errMsg(err));
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // The nightly GROWTH ASSESSMENT — the village's road from huts to a city
  // -------------------------------------------------------------------------

  /**
   * Reassess the village's growth for the day: record the structures it finished as
   * objective `build` milestones, then (if a chronicler is configured) ask the god to
   * NAME the settlement's current stage and call out any cultural/economic turning
   * point. The new stage + milestones are folded into the shared {@link vision},
   * persisted, and broadcast to every villager. Best-effort — a failed LLM call leaves
   * the stage unchanged and only the objective build milestones are added.
   *
   * Returns what was newly judged this day, for the chronicle to narrate.
   */
  private async assessGrowth(summary: VillageDailySummaryPayload): Promise<GrowthOutcome> {
    const newMilestones: VillageMilestone[] = [];

    // Objective first: every finished structure is a concrete step toward a city.
    for (const text of summary.completedBuilds ?? []) {
      newMilestones.push({ day: summary.day, pillar: 'build', text });
    }

    // Then the god's reading of the day — the stage, and any custom/trade turning point.
    let stage: string | undefined;
    if (this.chronicler) {
      // Seed the assessment with the current stage so the god judges against it (and
      // an empty stage reads as the village's humble beginning).
      const current: VillageVision = {
        stage: this.vision.stage || INITIAL_STAGE,
        milestones: this.vision.milestones,
        updatedDay: this.vision.updatedDay,
      };
      try {
        const text = await this.chronicler.synthesize({
          system: this.visionSystem,
          user: buildVisionUserMessage(summary, current),
          agent: 'God Agent',
          purpose: 'reflect',
        });
        const parsed = parseVisionAssessment(text);
        if (parsed.stage) stage = parsed.stage;
        for (const m of parsed.milestones) {
          // The god is told builds are recorded for it, but guard against a stray
          // duplicate by skipping a build-pillar milestone here.
          if (m.pillar === 'build') continue;
          newMilestones.push({ day: summary.day, pillar: m.pillar, text: m.text });
        }
      } catch (err) {
        console.warn('[supervisor] growth assessment failed:', errMsg(err));
      }
    }

    // Fold the result into the shared vision: advance the stage if one was judged
    // (otherwise hold steady), append the day's milestones, and cap the record.
    if (stage) this.vision.stage = stage;
    else if (!this.vision.stage) this.vision.stage = INITIAL_STAGE;
    if (newMilestones.length > 0) {
      this.vision.milestones.push(...newMilestones);
      if (this.vision.milestones.length > MAX_MILESTONES) {
        this.vision.milestones.splice(0, this.vision.milestones.length - MAX_MILESTONES);
      }
    }
    this.vision.updatedDay = summary.day;
    this.broadcastVision();
    void this.persistVision();
    if (stage || newMilestones.length > 0) {
      console.log(
        `[supervisor] day ${summary.day} growth: stage="${this.vision.stage}", ` +
          `+${newMilestones.length} milestone(s)`,
      );
    }
    return { stage, newMilestones };
  }

  /** Broadcast the current shared vision to every villager (and any observer). */
  private broadcastVision(): void {
    this.bus.publish(
      EXCHANGES.villageEvents,
      makeEvent('village.vision', {
        villageId: this.villageId,
        stage: this.vision.stage,
        milestones: this.vision.milestones.slice(),
        updatedDay: this.vision.updatedDay,
      }),
    );
  }

  /** Persist the shared vision after a change (fire-and-forget; never blocks). */
  private async persistVision(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.set<VillageVision>(this.keyFor(VILLAGE_VISION_KEY), this.vision);
    } catch (err) {
      console.warn('[supervisor] failed to persist vision:', errMsg(err));
    }
  }

  /** Broadcast the current standing policy to every villager (the utility brain reads it). */
  private broadcastPolicy(): void {
    this.bus.publish(
      EXCHANGES.supervisorCommands,
      makeEvent('supervisor.set_priorities', {
        villageId: this.villageId,
        weights: { ...this.policy.weights },
        ...(this.policy.rationale ? { rationale: this.policy.rationale } : {}),
        ...(this.policy.day !== undefined ? { day: this.policy.day } : {}),
      }),
    );
  }

  /** Persist the standing policy after a change (fire-and-forget; never blocks). */
  private async persistPolicy(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.set<VillagePolicy>(this.keyFor(VILLAGE_POLICY_KEY), this.policy);
    } catch (err) {
      console.warn('[supervisor] failed to persist policy:', errMsg(err));
    }
  }

  /**
   * Run one god deliberation as an AGENTIC LOOP over a transcript: the god may take
   * one or more divine acts, each one's outcome fed back so it can weigh the next,
   * until it yields (no tool call) or the step cap is hit. Guards against overlap
   * (one god, one thought). Returns true when at least one tool was published — the
   * caller decides what that means (advance the cool-off, drain the petition queue,
   * …). `logPrefix` tags the log lines. A provider without `converse` degrades to a
   * single decision.
   */
  /**
   * Prepend the god's recalled experience (its standing strategic lesson + the most
   * similar past days) to a deliberation's user message. The message itself is the
   * situation query — the day's vitals prose — so a recall surfaces days that looked
   * like this one. Returns the message unchanged when no memory is configured or it
   * has nothing relevant, so the prompt is identical to pre-P4 in that case.
   */
  private async recallSituation(userMessage: string): Promise<string> {
    if (!this.memory) return userMessage;
    const [recalled, strategy] = await Promise.all([
      this.memory.recall(userMessage),
      this.memory.latestStrategy(),
    ]);
    const block = buildSupervisorMemoryBlock(recalled, strategy);
    return block ? `${block}\n${userMessage}` : userMessage;
  }

  // -------------------------------------------------------------------------
  // INVESTIGATE — the god's read-only lookups (the ReAct half of the loop)
  // -------------------------------------------------------------------------

  /**
   * Ask the live village read-model (the aggregator) a question over the bus and await its
   * answer. A correlated request/reply atop the fire-and-forget bus: publish `supervisor.query`,
   * park a resolver under the query id, and let the `village.query_result` handler wake it. A
   * timeout resolves with a graceful "no answer" note so a missing/slow read-model never hangs
   * the deliberation — the god simply reasons on what it already has.
   */
  private query(kind: SupervisorQueryKind, args?: { villagerId?: string; buildingKind?: string }): Promise<string> {
    return new Promise((resolve) => {
      const queryId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingQueries.delete(queryId);
        resolve('(the village did not answer your gaze in time — decide on what you already know)');
      }, SUP_QUERY_TIMEOUT_MS);
      this.pendingQueries.set(queryId, (summary) => {
        clearTimeout(timer);
        resolve(summary);
      });
      this.bus.publish(
        EXCHANGES.supervisorCommands,
        makeEvent('supervisor.query', {
          queryId,
          villageId: this.villageId,
          kind,
          ...(args ? { args } : {}),
        }),
      );
    });
  }

  /**
   * Resolve one read-only lookup to the prose the god reads back into its deliberation. Local
   * lookups (memory, plan, prayers) are answered from state the god already holds; the rest are
   * LIVE world queries answered by the read-model via {@link query}. Pure investigation — it
   * never touches the world or the drama cool-off.
   */
  private async answerRead(decision: GodDecision): Promise<string> {
    switch (decision.kind) {
      case 'recall_memory': {
        if (!this.memory) return 'You hold no long memory of this village yet.';
        const [recalled, strategy] = await Promise.all([
          this.memory.recall(decision.query),
          this.memory.latestStrategy(),
        ]);
        const lines: string[] = [];
        if (strategy) lines.push(`Your standing lesson: ${strategy}`);
        if (recalled.length > 0) {
          lines.push('What you recall:');
          for (const r of recalled) lines.push(`- ${r.text}`);
        }
        return lines.length > 0 ? lines.join('\n') : `Nothing comes to memory about "${decision.query}".`;
      }
      case 'review_plan': {
        const lines = [`The village stands as: ${this.vision.stage || INITIAL_STAGE}.`];
        const recent = this.vision.milestones.slice(-8);
        if (recent.length > 0) {
          lines.push('Milestones reached so far:');
          for (const m of recent) lines.push(`- [${m.pillar}] ${m.text}`);
        }
        const w = this.policy.weights;
        const set = Object.keys(w);
        lines.push(
          set.length > 0
            ? 'Your standing priorities: ' + set.map((p) => `${p} ${w[p as keyof typeof w]!.toFixed(2)}`).join(', ') + '.'
            : 'You have set no priorities yet — the village runs neutral.',
        );
        if (this.policy.rationale) lines.push(`(Your last reason: ${this.policy.rationale})`);
        return lines.join('\n');
      }
      case 'list_prayers': {
        if (this.pending.length === 0) return 'No prayers await your judgement.';
        return [
          'Prayers awaiting your judgement:',
          ...this.pending.map((p) => `- ${p.villagerName}: "${p.message}"`),
        ].join('\n');
      }
      case 'inspect_villager':
        return this.query('inspect_villager', { villagerId: decision.villagerId });
      case 'list_villagers':
        return this.query('list_villagers');
      case 'list_buildings':
        return this.query('list_buildings', decision.buildingKind ? { buildingKind: decision.buildingKind } : undefined);
      case 'scan_rival':
        return this.query('scan_rival');
      default:
        return 'Nothing to report.';
    }
  }

  private async deliberate(userMessage: string, logPrefix = ''): Promise<boolean> {
    if (this.thinking) return false;
    this.thinking = true;
    try {
      // v3 P4 — lead the deliberation with the god's recalled experience of similar
      // past days + its standing strategy, so it reasons from what has worked here
      // before. Best-effort: with no memory (or an empty one) this is a no-op prefix.
      const situation = await this.recallSituation(userMessage);

      const converse = this.provider.converse?.bind(this.provider);
      if (!converse) return await this.deliberateOnce(situation, logPrefix);

      const messages: LlmMessage[] = [
        { role: 'system', content: this.system },
        { role: 'user', content: situation },
      ];
      let acted = false;
      let reads = 0;
      let actions = 0;
      for (let step = 0; step < SUP_MAX_STEPS; step++) {
        let turn: LLMTurn;
        try {
          turn = await converse({ messages, tools: GOD_TOOLS, agent: 'God Agent', purpose: 'supervisor' });
        } catch (err) {
          console.warn(`[supervisor] think failed:`, errMsg(err));
          break;
        }
        messages.push(godAssistantMessage(turn));
        if (turn.toolCalls.length === 0) break; // the god has said its piece

        for (const call of turn.toolCalls) {
          const callId = call.id ?? call.name;
          try {
            const decision = parseGodDecision(call.name, call.input);

            // READ tools INVESTIGATE: feed the answer back without touching the world or the
            // drama cool-off. Budget-capped so a god that only ever looks still moves on.
            if (isReadGodTool(call.name)) {
              let content: string;
              if (reads >= SUP_MAX_READS) {
                content = 'You have looked into enough for now — act on what you already know, or call no tool.';
              } else {
                reads++;
                content = await this.answerRead(decision);
              }
              console.log(`[supervisor] ${logPrefix}read ${decision.kind}`);
              messages.push({ role: 'tool', toolCallId: callId, name: call.name, content });
              continue;
            }

            // ACTION tools shape the world. Once the small action budget is spent, withhold
            // further acts and push the god to yield rather than chain on stale reasoning.
            if (actions >= SUP_MAX_ACTIONS) {
              messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: 'You have acted enough this deliberation — stop now (call no tool).' });
              continue;
            }
            console.log(`[supervisor] ${logPrefix}${decision.kind} ${JSON.stringify(decision)}`);
            const applied = this.act(decision);
            if (applied) {
              acted = true;
              actions++;
              messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: `Done — ${decision.kind} carried out.` });
            } else {
              messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: `Not now — you are at rest and may only call set_priorities today. ${decision.kind} was held back.` });
            }
          } catch (err) {
            const msg = err instanceof MalformedToolCallError ? err.message : errMsg(err);
            console.warn(`[supervisor] malformed god-tool call: ${msg}`, call.input);
            messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: `That couldn't be done: ${msg}. Try another, or call no tool.` });
          }
        }
      }
      if (!acted) console.log(`[supervisor] ${logPrefix}the village is left to its own devices`);
      return acted;
    } finally {
      this.thinking = false;
    }
  }

  /** Legacy single-decision deliberation, for a provider that can't run the loop. */
  private async deliberateOnce(userMessage: string, logPrefix: string): Promise<boolean> {
    try {
      const { call } = await this.provider.decide({
        system: this.system,
        userMessage,
        tools: GOD_TOOLS,
        agent: 'God Agent',
        purpose: 'supervisor',
      });
      if (!call) {
        console.log(`[supervisor] ${logPrefix}the village is left to its own devices`);
        return false;
      }
      const decision = parseGodDecision(call.name, call.input);
      // Without a `converse` loop the stub provider gets a single shot: a lone read lookup
      // can't lead anywhere, so just answer it for the log and take no action this turn.
      if (isReadGodTool(call.name)) {
        console.log(`[supervisor] ${logPrefix}read ${decision.kind} (single-shot — no follow-up)`);
        return false;
      }
      console.log(`[supervisor] ${logPrefix}${decision.kind} ${JSON.stringify(decision)}`);
      return this.act(decision);
    } catch (err) {
      if (err instanceof MalformedToolCallError) {
        console.warn(`[supervisor] malformed god-tool call: ${err.message}`, err.raw);
      } else {
        console.warn(`[supervisor] think failed:`, errMsg(err));
      }
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // ACT — validated god-decision -> supervisor.* envelope on the bus
  // -------------------------------------------------------------------------

  /**
   * Carry out a validated god-decision. Returns whether it was APPLIED — false when a
   * dramatic act is held back by the cool-off — so the deliberation loop can feed the
   * model accurate truth instead of a false "done".
   */
  private act(decision: GodDecision): boolean {
    // READ lookups are investigations, never acts — the deliberation loop answers them via
    // `answerRead` and never routes them here. Guard defensively (and narrow the union so the
    // dramatic switch below stays exhaustive over the action kinds).
    if (
      decision.kind === 'recall_memory' ||
      decision.kind === 'review_plan' ||
      decision.kind === 'list_prayers' ||
      decision.kind === 'list_villagers' ||
      decision.kind === 'inspect_villager' ||
      decision.kind === 'list_buildings' ||
      decision.kind === 'scan_rival'
    ) {
      return false;
    }

    // set_priorities is the everyday steer — always allowed, and it is NOT "drama", so it
    // never advances the cool-off. Merge the new weights over the standing policy, then
    // broadcast + persist so villagers pick them up and a reboot resumes them.
    if (decision.kind === 'set_priorities') {
      this.policy = {
        weights: { ...this.policy.weights, ...decision.weights },
        ...(decision.rationale ? { rationale: decision.rationale } : {}),
        day: this.lastSummary?.day ?? this.policy.day ?? 0,
      };
      this.broadcastPolicy();
      void this.persistPolicy();
      const summary = Object.entries(decision.weights)
        .map(([p, w]) => `${p}=${w.toFixed(2)}`)
        .join(', ');
      this.recordAct('set_priorities', `set the village to focus on ${summary}`);
      return true;
    }

    // issue_order is also a soft steer (not drama): stamp it with a fresh id and broadcast
    // it. The utility brain folds it in as a large, expiring bonus; it never advances the
    // cool-off. The villagers themselves enforce the TTL from when they receive it.
    if (decision.kind === 'issue_order') {
      const order: VillageOrder = {
        id: `order-${Date.now()}-${++this.orderSeq}`,
        villageId: this.villageId,
        target: decision.target,
        task: decision.task,
        params: decision.params,
        ...(decision.ttlTicks ? { ttlTicks: decision.ttlTicks } : {}),
        ...(decision.rationale ? { rationale: decision.rationale } : {}),
      };
      this.bus.publish(EXCHANGES.supervisorCommands, makeEvent('supervisor.issue_order', order));
      const who = order.target.villagerIds?.length
        ? order.target.villagerIds.join(', ')
        : order.target.role
          ? `the ${order.target.role}s`
          : 'the village';
      this.recordAct('issue_order', `ordered ${who} to ${order.task}`);
      return true;
    }

    // The three DRAMATIC tools below are gated by the daily cool-off: while at rest the
    // god may only tune the policy, so a drama call here is refused and fed back.
    if (!this.dramaAllowed) {
      console.log(`[supervisor] ${decision.kind} held back — the god is at rest (cool-off)`);
      return false;
    }
    this.dramaUsed = true;
    switch (decision.kind) {
      case 'spawn_entity':
        this.bus.publish(
          EXCHANGES.supervisorCommands,
          makeEvent('supervisor.spawn_entity', {
            entityType: decision.entityType,
            x: decision.x,
            y: decision.y,
            ...(decision.length !== undefined ? { length: decision.length } : {}),
            ...(decision.orientation !== undefined ? { orientation: decision.orientation } : {}),
          }),
        );
        this.recordAct('spawn_entity', `spawned a ${decision.entityType} at (${decision.x}, ${decision.y})`);
        return true;
      case 'change_weather':
        this.bus.publish(
          EXCHANGES.supervisorCommands,
          makeEvent('supervisor.change_weather', { weather: decision.weather }),
        );
        this.recordAct('change_weather', `turned the weather to ${decision.weather}`);
        return true;
      case 'plant_idea':
        this.bus.publish(
          EXCHANGES.supervisorCommands,
          makeEvent('supervisor.plant_idea', {
            villagerId: decision.villagerId,
            memory: decision.memory,
            source: 'supervisor',
          }),
        );
        this.recordAct('plant_idea', `whispered to a villager: "${decision.memory}"`);
        return true;
    }
  }

  /** Remember a divine act for the current day, so it shows in tonight's chronicle. */
  private recordAct(action: string, summary: string): void {
    this.actsToday.push({ action, summary });
  }
}

/** Record one assistant {@link LLMTurn} as the transcript message that produced it. */
function godAssistantMessage(turn: LLMTurn): LlmMessage {
  return {
    role: 'assistant',
    ...(turn.content ? { content: turn.content } : {}),
    ...(turn.toolCalls.length > 0
      ? {
          toolCalls: turn.toolCalls.map((c) => ({
            id: c.id ?? c.name,
            name: c.name,
            arguments: JSON.stringify(c.input ?? {}),
          })),
        }
      : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
