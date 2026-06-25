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

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type {
  DivineAct,
  UserCommandEvent,
  VillagerIntentEvent,
  VillageDailySummaryEvent,
  VillageDailySummaryPayload,
  SupervisorDailyReportPayload,
  VillageVision,
} from '../../shared/events';
import type { LlmMessage, VillageMilestone } from '../../shared/types';
import type { LLMProvider, LLMTurn } from '../../agent/src/llm/LLMProvider';
import type { Synthesizer } from '../../agent/src/memory/Synthesizer';
import { formatSimClock } from '../../shared/simClock';
import { MalformedToolCallError } from '../../agent/src/tools';
import { GOD_TOOLS, parseGodDecision, type GodDecision } from './tools';
import {
  buildCharterPrompt,
  buildChosenPrayerMessage,
  buildChronicleSystemPrompt,
  buildChronicleUserMessage,
  buildPetitionMessage,
  buildSummaryMessage,
  buildVisionSystemPrompt,
  buildVisionUserMessage,
  parseVisionAssessment,
  type PendingPrayer,
} from './prompt';

/** Cap on tracked prayers, so a long-running god never grows the list unbounded. */
const MAX_PENDING_PRAYERS = 50;

/**
 * Hard cap on assistant turns in the god's agentic deliberation loop (env-tunable
 * via `SUPERVISOR_MAX_STEPS`). The god has no read-only lookups — it already senses
 * a whole day at once — so this only bounds how many divine ACTS it may chain in one
 * deliberation before it must yield. Kept small (it acts on the scale of the world).
 */
const SUP_MAX_STEPS = supMaxSteps();
function supMaxSteps(): number {
  const n = Number(process.env.SUPERVISOR_MAX_STEPS);
  return Number.isFinite(n) && n >= 1 ? Math.min(12, Math.floor(n)) : 4;
}

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
}

/** The runtime-state key the supervisor stores its state under. */
const SUPERVISOR_STATE_KEY = 'supervisor';

/** The runtime-state key the village's shared VISION is persisted under. */
const VILLAGE_VISION_KEY = 'village-vision';

/** Most milestones to keep on the vision, so the record never grows unbounded. */
const MAX_MILESTONES = 60;

/** The stage a brand-new village starts at, before the god has judged any growth. */
const INITIAL_STAGE = 'a scattering of homesteads';

export interface SupervisorOptions {
  /** The village's standing narrative directive — the god's "goal". */
  charter?: string;
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
}

export class SupervisorService {
  private readonly system: string;
  private readonly minGap: number;
  /** Optional durable store for the god's state (cooldown, prayers, last summary). */
  private readonly state?: SupervisorStatePersistence;
  /** Optional free-text seam for authoring the nightly chronicle. */
  private readonly chronicler?: Synthesizer;
  /** The chronicle's stable system prompt (good cache prefix), built once. */
  private readonly chronicleSystem: string;
  /** The growth-assessment's stable system prompt (good cache prefix), built once. */
  private readonly visionSystem: string;
  /**
   * The village's shared VISION — its stage of growth toward a city and the milestones
   * reached. Reassessed each night, persisted across reboots, and broadcast to every
   * villager so the collective goal stays in front of them. Starts empty.
   */
  private vision: VillageVision = { stage: '', milestones: [], updatedDay: 0 };
  /** Day of the last intervention; the god cools off for `minGap` days after. */
  private lastActedDay = Number.NEGATIVE_INFINITY;
  /** Guards against overlapping thoughts (one god, one thought at a time). */
  private thinking = false;
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
    this.system = buildCharterPrompt(options.charter);
    this.minGap = options.minDaysBetweenActs ?? 1;
    this.state = options.state;
    this.chronicler = options.chronicler;
    this.chronicleSystem = buildChronicleSystemPrompt(options.charter);
    this.visionSystem = buildVisionSystemPrompt(options.charter);
  }

  async start(): Promise<void> {
    // Restore the god's memory of itself first, so a reboot doesn't reset the
    // cooldown or forget pending prayers. Best-effort: a fresh store yields null.
    await this.restoreState();

    // Durable, NAMED queue: the god must never miss a day's summary, even across
    // a restart (unlike a villager, who wants only fresh perception).
    await this.bus.subscribe<VillageDailySummaryEvent>(
      EXCHANGES.villageEvents,
      'village.daily_summary',
      (event) => this.onDailySummary(event.payload),
      { queue: 'supervisor.village.summaries', durable: true },
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

    console.log(
      `[supervisor] online via ${this.provider.name}; minDaysBetweenActs=${this.minGap}; ` +
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
      const saved = await this.state.get<PersistedSupervisorState>(SUPERVISOR_STATE_KEY);
      if (!saved) return;
      // null encodes "never acted", which can't be stored as -Infinity (not JSON).
      this.lastActedDay = saved.lastActedDay ?? Number.NEGATIVE_INFINITY;
      this.lastSummary = saved.lastSummary ?? null;
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
      const savedVision = await this.state.get<VillageVision>(VILLAGE_VISION_KEY);
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
  }

  /** Persist the god's state after a mutation (fire-and-forget; never blocks). */
  private async persistState(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.set<PersistedSupervisorState>(SUPERVISOR_STATE_KEY, {
        // -Infinity isn't JSON; persist "never acted" as null.
        lastActedDay: Number.isFinite(this.lastActedDay) ? this.lastActedDay : null,
        pending: this.pending.slice(),
        lastSummary: this.lastSummary,
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
    }
  }

  /**
   * Answer the ONE prayer the human chose, then clear every pending prayer — the
   * others go unheard this time. The queue is drained whether or not the god
   * actually called a tool: the choice has been made and the moment has passed.
   */
  private async answerChosen(chosen: PendingPrayer): Promise<void> {
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
    const userMessage =
      this.pending.length > 0
        ? buildPetitionMessage(this.pending)
        : this.lastSummary
          ? buildSummaryMessage(this.lastSummary)
          : 'The high temple bids you act now. Survey your village and, if it is ' +
            'wanting, take exactly one action — otherwise call no tool.';
    console.log(`[supervisor] FORCE RUN over ${this.pending.length} pending prayer(s)`);
    const acted = await this.deliberate(userMessage);
    // One prayer answered means the rest are dismissed; clear only once it acted,
    // so a no-op force-run (god declined) leaves the prayers for a later choice.
    if (acted && this.pending.length > 0) this.pending.length = 0;
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

    if (summary.day - this.lastActedDay < this.minGap) {
      void this.persistState();
      return; // still cooling off — chronicle written, but no intervention
    }

    // With prayers pending, the day's deliberation IS the god choosing one to
    // answer; otherwise it judges the day's vitals at large.
    const userMessage =
      this.pending.length > 0 ? buildPetitionMessage(this.pending) : buildSummaryMessage(summary);
    const acted = await this.deliberate(userMessage, `day ${summary.day}: `);
    if (acted) {
      this.lastActedDay = summary.day;
      // One prayer answered for the day — the rest go unheard, the slate resets.
      this.pending.length = 0;
    }
    void this.persistState();
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
      await this.state.set<VillageVision>(VILLAGE_VISION_KEY, this.vision);
    } catch (err) {
      console.warn('[supervisor] failed to persist vision:', errMsg(err));
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
  private async deliberate(userMessage: string, logPrefix = ''): Promise<boolean> {
    if (this.thinking) return false;
    this.thinking = true;
    try {
      const converse = this.provider.converse?.bind(this.provider);
      if (!converse) return await this.deliberateOnce(userMessage, logPrefix);

      const messages: LlmMessage[] = [
        { role: 'system', content: this.system },
        { role: 'user', content: userMessage },
      ];
      let acted = false;
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
            console.log(`[supervisor] ${logPrefix}${decision.kind} ${JSON.stringify(decision)}`);
            this.act(decision);
            acted = true;
            messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: `Done — ${decision.kind} carried out.` });
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
      console.log(`[supervisor] ${logPrefix}${decision.kind} ${JSON.stringify(decision)}`);
      this.act(decision);
      return true;
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

  private act(decision: GodDecision): void {
    switch (decision.kind) {
      case 'spawn_entity':
        this.bus.publish(
          EXCHANGES.supervisorCommands,
          makeEvent('supervisor.spawn_entity', {
            entityType: decision.entityType,
            x: decision.x,
            y: decision.y,
          }),
        );
        this.recordAct('spawn_entity', `spawned a ${decision.entityType} at (${decision.x}, ${decision.y})`);
        return;
      case 'change_weather':
        this.bus.publish(
          EXCHANGES.supervisorCommands,
          makeEvent('supervisor.change_weather', { weather: decision.weather }),
        );
        this.recordAct('change_weather', `turned the weather to ${decision.weather}`);
        return;
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
        return;
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
