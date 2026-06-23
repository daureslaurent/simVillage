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
  UserCommandEvent,
  VillagerIntentEvent,
  VillageDailySummaryEvent,
  VillageDailySummaryPayload,
} from '../../shared/events';
import type { LLMProvider } from '../../agent/src/llm/LLMProvider';
import { MalformedToolCallError } from '../../agent/src/tools';
import { GOD_TOOLS, parseGodDecision, type GodDecision } from './tools';
import {
  buildCharterPrompt,
  buildChosenPrayerMessage,
  buildPetitionMessage,
  buildSummaryMessage,
  type PendingPrayer,
} from './prompt';

/** Cap on tracked prayers, so a long-running god never grows the list unbounded. */
const MAX_PENDING_PRAYERS = 50;

export interface SupervisorOptions {
  /** The village's standing narrative directive — the god's "goal". */
  charter?: string;
  /** Don't intervene more than once every N days (anti-thrash). Default 1. */
  minDaysBetweenActs?: number;
}

export class SupervisorService {
  private readonly system: string;
  private readonly minGap: number;
  /** Day of the last intervention; the god cools off for `minGap` days after. */
  private lastActedDay = Number.NEGATIVE_INFINITY;
  /** Guards against overlapping thoughts (one god, one thought at a time). */
  private thinking = false;
  /** The most recent daily summary, so a force-run has context even with no prayers. */
  private lastSummary: VillageDailySummaryPayload | null = null;
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
  }

  async start(): Promise<void> {
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

    console.log(
      `[supervisor] online via ${this.provider.name}; minDaysBetweenActs=${this.minGap}`,
    );
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
  }

  // -------------------------------------------------------------------------
  // SENSE + THINK
  // -------------------------------------------------------------------------

  private async onDailySummary(summary: VillageDailySummaryPayload): Promise<void> {
    this.lastSummary = summary;
    if (summary.day - this.lastActedDay < this.minGap) return; // still cooling off

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
  }

  /**
   * Run one god deliberation: ask the LLM for a single tool over `userMessage`,
   * validate it, and act. Guards against overlap (one god, one thought). Returns
   * true when a tool was actually published — the caller decides what that means
   * (advance the cool-off, drain the petition queue, …). `logPrefix` tags the line.
   */
  private async deliberate(userMessage: string, logPrefix = ''): Promise<boolean> {
    if (this.thinking) return false;
    this.thinking = true;
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
    } finally {
      this.thinking = false;
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
        return;
      case 'change_weather':
        this.bus.publish(
          EXCHANGES.supervisorCommands,
          makeEvent('supervisor.change_weather', { weather: decision.weather }),
        );
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
        return;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
