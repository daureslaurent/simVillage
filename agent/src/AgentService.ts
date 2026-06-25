/**
 * agent/src/AgentService.ts
 * ---------------------------------------------------------------------------
 * Phase 3 — "The Brains". The mind of a single villager.
 *
 * One `AgentService` is the autonomous brain behind one body in the world. It
 * is a pure consumer/producer on the nervous system — it owns no world state of
 * record, exactly like the gateway:
 *
 *   SENSE  — subscribes to `world.events`, folds each snapshot through a
 *            `WorldView` into a local `Perception` (5-tile radius).
 *   THINK  — on a throttled cadence, asks the injected `LLMProvider` to choose
 *            one action given the profile + current perception.
 *   ACT    — validates the chosen tool call and publishes the matching intent
 *            (`villager.move` / `villager.speak` / `villager.interact`) to the
 *            `villager.intents` exchange for the World Engine to adjudicate.
 *
 * The LLM has NO direct line to the engine: its only outlet is a validated
 * intent envelope on the bus. A malformed or unknown tool call is logged and
 * dropped; the mind simply thinks again next cadence.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type {
  VillagerSpeakEvent,
  PlantIdeaPayload,
  SupervisorPlantIdeaEvent,
  UserPlantIdeaEvent,
  SimTurnGrantedEvent,
  VillagerGroupPlanEvent,
  VillagerAgendaEvent,
  VillagerAgendaRemovedEvent,
  VillageVisionEvent,
  WorldEvent,
} from '../../shared/events';
import type { AgendaEvent, AgendaItem, AgendaNote, AgentTraceStep, BuildingEvent, GroupPlan, LlmMessage, LlmRouteHint, Relationship, VillageVision } from '../../shared/types';
import { BUILDING_LOG_WINDOW_TICKS, SERVICE_REACH, buildableFor } from '../../shared/buildings';
import type { CharacterProfile } from './profile';
import { WorldView, type Perception } from './sensory';
import { PromptAssembler } from './prompt/PromptAssembler';
import { AT_BUILDING_REACH, type HeardUtterance, type SocialHub } from './prompt/blocks';
import type { MapEntry } from './sensory';
import { DailyPlanner } from './planning/DailyPlanner';
import type { Synthesizer } from './memory/Synthesizer';
import type { LLMProvider, LLMToolCall, LLMTurn } from './llm/LLMProvider';
import {
  ACTION_TOOLS,
  READ_TOOLS,
  COMMAND_CART_TOOL,
  isReadTool,
  isSoftAction,
  MalformedToolCallError,
  parseDecision,
  type AgentDecision,
} from './tools';
import { executeReadTool, type ReadToolContext } from './readTools';
import type { KnownPerson, MemoryStream } from './memory/MemoryStream';
import type { RecalledMemory } from './memory/MemoryStore';
import { ReflectionLoop } from './memory/ReflectionLoop';
import { RelationshipBook } from './social/RelationshipBook';
import {
  narrateHeardSpeech,
  narrateImplant,
  narrateObservation,
  narrateOwnSpeech,
  narrateReasoning,
} from './memory/narrative';

/**
 * The agentic-loop budgets, both operator-tunable by env var.
 *
 *   MIND_MAX_READS — how many READ-ONLY lookups (map/memories/guide/…) a mind may
 *     make in one turn before it is told to act on what it knows. Bounds the LLM
 *     cost of deliberation across many parallel minds (default 3).
 *   MIND_MAX_STEPS — a hard cap on TOTAL assistant turns in the loop (reads +
 *     actions + the final yield), a safety net so a confused model can't loop
 *     forever (default 8). Must comfortably exceed MIND_MAX_READS.
 */
const MIND_MAX_READS = clampInt(process.env.MIND_MAX_READS, 3, 0, 20);
const MIND_MAX_STEPS = clampInt(process.env.MIND_MAX_STEPS, 8, 1, 40);
/**
 * MIND_MAX_SOFT — how many SOFT actions (a private `reason`, an agenda note, a
 * plan/event proposal — see {@link isSoftAction}) a mind may commit in one turn
 * before it is told to take a PHYSICAL action instead. Soft actions don't end the
 * turn (the body must still do something), so without this cap a weak model could
 * `reason` step after step until MIND_MAX_STEPS and never move — the very stall
 * this guards against. Kept low; must leave room under MIND_MAX_STEPS for the
 * physical action that follows (default 2).
 */
const MIND_MAX_SOFT = clampInt(process.env.MIND_MAX_SOFT, 2, 0, 20);

/** Parse a positive integer env value within [min,max], falling back to `def`. */
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface AgentServiceOptions {
  /**
   * Minimum gap between LLM decisions, in ms. World ticks arrive far faster
   * than we want (or can afford) to think, so decisions are rate-limited to at
   * most one per interval. Defaults to 4000ms.
   */
  thinkIntervalMs?: number;
  /**
   * Phase 4 — the villager's long-term memory (RAG). When supplied, the villager
   * ingests conversations + first sightings, recalls relevant memories before
   * each decision, and reflects nightly. Omit it for a Phase-3 amnesiac mind.
   */
  memory?: MemoryStream;
  /**
   * Run under the {@link MindScheduler}: instead of self-pacing on a wall-clock
   * interval, the mind thinks only when GRANTED a turn (`sim.turn_granted`), acks
   * when done (`sim.turn_done`), and ASKS for an out-of-turn window (`mind.wants_turn`)
   * when something around it changes (it was spoken to, a neighbour came near, a
   * need turned urgent). This is what makes the village reactive. Defaults to false
   * (legacy self-pace).
   */
  coordinated?: boolean;
  /**
   * Pool ROUTING for this villager's LLM calls — which endpoint/model its mind runs
   * on. Omit to let the pool pick a free endpoint and its default model (the "shared"
   * case); set it to pin this villager to a specific endpoint/model (the "assigned
   * independently" case). Forwarded on every decision + reflection.
   */
  route?: LlmRouteHint;
  /**
   * The shared WORLD BIBLE (`agent/villagers.md`) — the common grounding handed,
   * unchanged, to every villager. Prepended to the system prompt as its stable,
   * cache-friendly prefix. Omit for a persona-only mind.
   */
  bible?: string;
  /**
   * Enable the DAILY PLANNER: when supplied, the villager sketches a loose agenda
   * each morning (via this free-text seam) and is gently guided by it. Reuse the
   * same client the minds already hold (it implements {@link Synthesizer}). Omit
   * for a purely reactive mind with no day-shape.
   */
  planner?: Synthesizer;
  /**
   * This villager's SOCIAL BOOK — what it thinks of each neighbour — seeded from
   * whatever was persisted. Revised each night by the reflection and fed into the
   * prompt so opinions steer behaviour. Omit for a mind that keeps no relations.
   */
  relationships?: RelationshipBook;
  /**
   * The whole roster (every villager's id + name, this one included), resolved
   * fresh so newcomers are picked up. Used to list canonical names for the nightly
   * relation pass and to resolve its RELATION lines back to ids.
   */
  roster?: () => KnownPerson[];
  /**
   * The last day this villager already reflected on, restored from persistence, so
   * a reboot during the night doesn't trigger a duplicate nightly reflection.
   */
  initialReflectedDay?: number;
  /**
   * Called when the villager advances to a new reflected day, so the caller can
   * persist the watermark for the next restart.
   */
  onReflectedDay?: (day: number) => void;
}

export class AgentService {
  private readonly world: WorldView;
  /** Composes this villager's system + per-turn user prompts from the shared blocks. */
  private readonly prompts: PromptAssembler;
  private readonly thinkIntervalMs: number;

  /**
   * Phase 4 — long-term memory, or null for an amnesiac (Phase 3) mind. Not
   * readonly: if the vector store is unreachable at startup we drop to amnesiac
   * mode rather than taking the whole village down (see {@link start}).
   */
  private memory: MemoryStream | null;
  /** Phase 4 — nightly reflection driver, present only when memory is. */
  private readonly reflection: ReflectionLoop | null;
  /** Daily-agenda planner, or null for a purely reactive mind (no day-shape). */
  private readonly planner: DailyPlanner | null;
  /** This villager's evolving view of its neighbours, or null when it keeps none. */
  private readonly relationships: RelationshipBook | null;
  /** Resolves the full roster (id + name) for the nightly relation pass. */
  private readonly roster: () => KnownPerson[];

  /**
   * Recent SHARED PLANS the village is forming, kept latest-per-id and pruned. Fed
   * by the GroupCoordinator over `villager.group_plan.updated`; each turn the mind
   * reads off whichever plan it is a member of (its part to carry out) or one its
   * current company is forming (which it may join), so a gathering becomes
   * coordinated work instead of milling chatter.
   */
  private readonly groupPlans: GroupPlan[] = [];
  /** Most recent plans to retain, so a busy village can't grow the list unbounded. */
  private static readonly GROUP_PLAN_MAX = 12;

  /**
   * The village's live AGENDA items (notes + scheduled events), kept by id from the
   * {@link AgendaCoordinator}'s `villager.agenda.updated` / `.removed` broadcasts. Each
   * turn the mind reads off its OWN slice — its notes, the events it attends, and the
   * events it has been invited to — so an agenda steers what it does (and it is reminded
   * to head to an event as the hour nears). Holding every villager's items (not just its
   * own) is cheap and keeps the read model identical to the server's.
   */
  private readonly agendaItems = new Map<string, AgendaItem>();
  /**
   * The villager's most recent nightly belief, if any. Fed to the planner so each
   * morning's agenda carries yesterday's insight forward. Null until first reflection.
   */
  private lastBelief: string | null = null;
  /** Ids we have already laid down a "first sighting" memory for, to avoid re-ingesting. */
  private readonly seen = new Set<string>();
  /** The member-set key of the gathering we last remembered, so we record each new one once. */
  private lastGatheringKey: string | null = null;

  /**
   * Per-building rolling ACTIVITY LOG (buildingId -> recent events, oldest first),
   * fed by `world.building_event` and pruned to the recent window. When we stand
   * near a building, its log is summarised into the prompt so we coordinate over
   * what's been done there (and see WHY a work attempt was refused).
   */
  private readonly buildingLog = new Map<string, BuildingEvent[]>();

  /**
   * Short-term "earshot" buffer of recently-heard utterances, oldest first. This
   * is the villager's WORKING conversational memory — injected straight into every
   * think prompt so a mind can actually reply to what was just said, independent
   * of (and far more immediate than) the Phase-4 vector store. Pruned by WALL-CLOCK
   * age each think; bounded in size on push.
   */
  private readonly recentSpeech: HeardUtterance[] = [];
  /**
   * How long (ms) a heard line stays in the earshot buffer. It MUST outlast the
   * think cadence by a comfortable margin: villagers only act once per
   * `thinkIntervalMs`, so a reply heard just after a thought has to survive until
   * the next one — otherwise it ages out unseen and the villager re-greets blindly
   * forever. We hold several think-cycles' worth (and at least a minute). Computed
   * in the constructor from the configured cadence; see issue: speech expiring
   * faster than the think interval.
   */
  private readonly speechRetentionMs: number;
  /** Hard cap on buffered utterances, so a chatty crowd can't grow it unboundedly. */
  private static readonly SPEECH_MEMORY_MAX = 8;

  /** True when driven by the {@link MindScheduler} (think on grant, not on a timer). */
  private readonly coordinated: boolean;
  /** Pool routing for this mind's LLM calls (endpoint/model), or undefined for "any free endpoint". */
  private readonly route: LlmRouteHint | undefined;

  /**
   * What happened AROUND this villager since its last thought, accumulated across
   * the many world ticks between thoughts and rendered into the next prompt's
   * "Since you last acted" block, then cleared. This is how a mind reacts to a
   * neighbour it crossed, someone coming within earshot, or a need turning urgent —
   * things a single think-time snapshot would miss. Bounded on push.
   */
  private readonly sinceLastThink: string[] = [];
  /** Most recent inter-think events to retain, so a busy stretch can't grow it unbounded. */
  private static readonly RECENT_EVENTS_MAX = 12;
  /** Wall-clock time of our last `mind.wants_turn`, to throttle interrupt requests. */
  private lastWantsAt = 0;
  /** The urgency of our last `mind.wants_turn`, so we only re-ask when it rises. */
  private lastWantsUrgency = 0;

  /** A need at or above this 0..100 level is "urgent" — crossing it interrupts the mind. */
  private static readonly NEED_DISTRESS = 70;
  /** Don't fire two interrupts within this window unless the urgency climbs. */
  private static readonly WANTS_THROTTLE_MS = 1_000;

  /**
   * The village's shared gathering place (tavern / market / town hall), resolved
   * once the building layout is known. A lone villager is steered here so the
   * villagers actually converge and can talk, instead of each idling at its
   * own workplace forever out of earshot. Null until `world.init` arrives.
   */
  private socialHub: SocialHub | null = null;

  /**
   * The village's shared VISION — the collective ambition to grow into a city, the
   * god's current name for the settlement's stage, and the milestones reached so far.
   * Fed by the god over `village.vision` (daily, and once on its boot) and folded into
   * every think prompt so the long-horizon goal stays in front of the mind. Null until
   * the first broadcast.
   */
  private villageVision: VillageVision | null = null;

  /** Latest perception, refreshed every world snapshot; null until we spawn. */
  private latest: Perception | null = null;
  /** Guards against overlapping LLM calls (one mind, one thought at a time). */
  private thinking = false;
  /** Timestamp of the last decision, for cadence throttling. */
  private lastThoughtAt = 0;
  /** The logical (coordinator) tick of the turn currently being thought, if any. */
  private roundTick: number | undefined;
  /** Whether the most recent think produced a real action (drives our cooldown). */
  private lastTurnActed = false;
  /**
   * The KIND of action chosen this turn (e.g. 'work_at'), or null when the turn was
   * skipped. Reported in `sim.turn_done` so the coordinator can size the cooldown by
   * action — starting work earns a longer rest, since the engine keeps us at it.
   */
  private lastTurnKind: AgentDecision['kind'] | null = null;

  /**
   * A short, neutral note on why the PREVIOUS turn's action did not land in the world
   * (a speech no one was near to hear, a no-op move, an unparsed call). Surfaced as a
   * FACT in the next turn's prompt — not a correction — so the mind can decide afresh
   * with that knowledge. Captured-and-cleared at the top of each think.
   */
  private lastSkippedReason: string | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly profile: CharacterProfile,
    private readonly provider: LLMProvider,
    options: AgentServiceOptions = {},
  ) {
    this.world = new WorldView(profile.id);
    this.prompts = new PromptAssembler(profile, options.bible ?? '');
    this.coordinated = options.coordinated ?? false;
    this.route = options.route;
    this.thinkIntervalMs = options.thinkIntervalMs ?? 4000;
    // Keep heard speech alive for several think-cycles so a reply is still in the
    // buffer when this mind next gets to act (floor of 60s for slow cadences).
    this.speechRetentionMs = Math.max(60_000, this.thinkIntervalMs * 4);
    this.memory = options.memory ?? null;
    this.relationships = options.relationships ?? null;
    this.roster = options.roster ?? (() => []);
    this.planner = options.planner
      ? new DailyPlanner(options.planner, {
          profile,
          bible: options.bible ?? '',
          // Carry the latest nightly belief into tomorrow's plan.
          recentBelief: () => this.lastBelief,
          // The shared hub (known after world.init) so the agenda schedules social
          // time where the village actually converges.
          hub: () => this.socialHub,
          // This villager's view of its neighbours, so the day is shaped around the
          // people it cares about (seek out a friend, mend a rift, share a chore).
          relationships: () => this.relationships?.all() ?? [],
        })
      : null;
    this.reflection = this.memory
      ? new ReflectionLoop(this.memory, {
          profile,
          // The roster minus this villager — the people it may re-judge tonight.
          knownPeople: () => this.roster().filter((p) => p.id !== this.profile.id),
          // Resume + persist the reflected-day watermark so a reboot during the
          // night doesn't fire a duplicate reflection for the current day.
          ...(options.initialReflectedDay !== undefined
            ? { initialReflectedDay: options.initialReflectedDay }
            : {}),
          ...(options.onReflectedDay ? { onReflectedDay: options.onReflectedDay } : {}),
          // A night's synthesis becomes the villager's new standing goal, so the
          // belief it forms actually steers tomorrow's behaviour — and the planner
          // re-plans around it, rather than steering by a stale purpose all day.
          onReflection: (r) => {
            this.profile.goal = r.synthesis;
            this.lastBelief = r.synthesis;
            this.planner?.invalidate();
            // Fold the night's re-judgements into the social book, then persist +
            // stream the updated ties so opinions carry into tomorrow and to the UI.
            if (this.relationships && r.relations.length > 0) {
              const updated = this.relationships.apply(r.relations, this.latest?.tick ?? 0);
              this.publishRelationships(updated);
              console.log(
                `[villager:${this.profile.id}] revised ${r.relations.length} relationship(s)`,
              );
            }
            console.log(`[villager:${this.profile.id}] updated goal from reflection`);
          },
        })
      : null;
  }

  /** Begin sensing the world. The think loop is driven by incoming snapshots. */
  async start(): Promise<void> {
    // Phase 4 — make sure the vector store exists before any ingest/recall. If it is
    // unreachable (e.g. Qdrant down or out of file descriptors), don't take the whole
    // village down: log it and run this mind WITHOUT long-term memory. It can still
    // sense, think and act — it just won't recall or reflect until memory is restored.
    if (this.memory) {
      try {
        await this.memory.init();
      } catch (err) {
        console.warn(
          `[villager:${this.profile.id}] long-term memory unavailable, running amnesiac:`,
          err instanceof Error ? err.message : err,
        );
        this.memory = null;
      }
    }

    // Unnamed (exclusive, auto-delete) queue: a mind wants only fresh world
    // state, never a backlog of stale snapshots after a restart.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.#', (event) =>
      this.onWorldEvent(event),
    );

    // Hear speech within earshot. `villager.speak` rides the villager.intents
    // exchange (see shared/events). Every villager subscribes — short-term
    // conversational awareness does NOT depend on Phase-4 memory; the handler
    // buffers what it hears for the next think and (when memory is present) also
    // lays down a long-term record.
    await this.bus.subscribe<VillagerSpeakEvent>(EXCHANGES.villagerIntents, 'villager.speak', (event) =>
      this.onHeardSpeech(event),
    );

    // Hear about the village's shared plans, so a gathering this mind is in can act
    // as one (carry out my part, or join what my company is forming). Exclusive
    // queue — a mind wants the live agenda, not a backlog.
    await this.bus.subscribe<VillagerGroupPlanEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.group_plan.updated',
      (event) => this.onGroupPlan(event.payload),
    );

    // Keep our view of the village's AGENDA current: items the coordinator opens or
    // changes, and the ones it expires. Exclusive queues — a mind wants the live
    // agenda, not a backlog of stale items after a restart.
    await this.bus.subscribe<VillagerAgendaEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.agenda.updated',
      (event) => this.onAgendaItem(event.payload),
    );
    await this.bus.subscribe<VillagerAgendaRemovedEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.agenda.removed',
      (event) => this.onAgendaRemoved(event.payload.itemId),
    );

    // The village's shared VISION (the collective city-growth goal + its progress),
    // broadcast by the god each day and once on its boot. Exclusive queue — a mind
    // wants the latest reading, not a backlog of stale ones after a restart.
    await this.bus.subscribe<VillageVisionEvent>(
      EXCHANGES.villageEvents,
      'village.vision',
      (event) => {
        this.villageVision = event.payload;
      },
    );

    // Coordinated mode: the turn clock grants our LLM windows. We think only when
    // granted and ack when done — no self-paced loop.
    if (this.coordinated) {
      await this.bus.subscribe<SimTurnGrantedEvent>(EXCHANGES.simulation, 'sim.turn_granted', (event) =>
        this.onTurnGranted(event.payload),
      );
    }

    // Phase 4 — interventions only make sense for a mind that can store them.
    if (this.memory) {
      // Final Phase — the "Inception". A synthetic memory can be forced into us
      // from two sources, both converging on onPlantIdea(): the God Agent
      // (`supervisor.plant_idea`) and a human via the UI inspector
      // (`user.intervention.plant_idea`). Only wired when we have somewhere to
      // store the memory; each uses an exclusive queue (an intervention is for
      // the live mind, not replayed from a backlog).
      await this.bus.subscribe<SupervisorPlantIdeaEvent>(
        EXCHANGES.supervisorCommands,
        'supervisor.plant_idea',
        (event) => this.onPlantIdea(event.payload),
      );
      await this.bus.subscribe<UserPlantIdeaEvent>(
        EXCHANGES.userCommands,
        'user.intervention.*',
        (event) => this.onPlantIdea(event.payload),
      );
    }

    console.log(
      `[villager:${this.profile.id}] "${this.profile.name}" online via ${this.provider.name}` +
        `${this.memory ? ` + memory (${this.memory.constructor.name})` : ''}; goal: ${this.profile.goal}`,
    );
  }

  // -------------------------------------------------------------------------
  // SENSE
  // -------------------------------------------------------------------------

  private onWorldEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'world.init':
        this.world.applyInit(event.payload);
        // Resolve the shared gathering place now the buildings are known. Every
        // mind picks the SAME hub (deterministic by kind), so they converge on one
        // spot rather than scattering.
        this.socialHub = pickSocialHub(this.world.villageMap());
        return;
      case 'world.map_updated': {
        const perception = this.world.perceive(event.payload);
        if (!perception) return; // our body isn't in the world (yet)
        const prev = this.latest;
        this.latest = perception;
        // Fold what changed around us since the previous tick into the inter-think
        // log + an urgency signal, so a reactive mind notices encounters/arrivals/
        // needs it would miss by only seeing a snapshot when it finally thinks.
        if (this.coordinated && !perception.self.asleep) this.observeChange(prev, perception);
        this.ingestObservations(perception);
        // Let the daily planner and the nightly reflection cron see the world clock
        // tick by. Both are fire-and-forget and short-circuit cheaply. Reflection
        // fires each night and is fine while ASLEEP — it's the villager "sleeping on
        // it", a pure memory/goal synthesis that never touches the body. The morning
        // PLAN, though, is deferred until the villager is actually awake: a sleeper
        // wakes at dawn (the day rollover), and only then sketches the day ahead, so
        // planning never coincides with — or appears to interrupt — its sleep.
        if (!perception.self.asleep) this.planner?.onTick(perception.tick);
        this.reflection?.onTick(perception.tick);
        // Coordinated minds think on a granted turn, not off the world clock.
        if (!this.coordinated) this.maybeThink();
        return;
      }
      case 'world.building_event':
        this.ingestBuildingEvent(event.payload);
        return;
      case 'world.weather_changed':
        // Fold the new weather into our world view so the next perception (and the
        // body block of the prompt) reflects the skies overhead.
        this.world.applyWeather(event.payload.weather);
        return;
    }
  }

  /**
   * Remember one thing that happened at a building, in a per-building rolling buffer
   * pruned to the recent window. When we later stand near that building, its recent
   * activity is folded into the prompt so we can reason over it (don't re-haul water
   * someone just brought, notice the farm has been dry a while, etc.).
   */
  private ingestBuildingEvent(event: BuildingEvent): void {
    const list = this.buildingLog.get(event.buildingId) ?? [];
    list.push(event);
    const cutoff = event.tick - BUILDING_LOG_WINDOW_TICKS;
    let drop = 0;
    while (drop < list.length && list[drop].tick < cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    this.buildingLog.set(event.buildingId, list);
  }

  /**
   * The recent activity of every building currently within sensing range, keyed by
   * building id and pruned to the recent window relative to now. Empty when nothing
   * relevant is nearby — so the prompt block is omitted entirely.
   */
  private nearbyBuildingActivity(perception: Perception): Record<string, BuildingEvent[]> {
    const out: Record<string, BuildingEvent[]> = {};
    const cutoff = perception.tick - BUILDING_LOG_WINDOW_TICKS;
    for (const b of perception.nearbyBuildings) {
      const events = (this.buildingLog.get(b.id) ?? []).filter((e) => e.tick >= cutoff);
      if (events.length > 0) out[b.id] = events;
    }
    return out;
  }

  /**
   * Phase 4 (ingest) — lay down a memory the FIRST time we sense each villager or
   * object. We dedupe on id via `this.seen` so a neighbour standing next to us
   * for 100 ticks produces one "I noticed ..." memory, not a hundred. Storing
   * is fire-and-forget so a slow embed never stalls the sensory stream.
   */
  private ingestObservations(perception: Perception): void {
    if (!this.memory) return;
    const { tick, self } = perception;

    for (const a of perception.nearbyVillagers) {
      if (!a.canSee) continue; // only lay eyes on those actually within sight
      if (this.seen.has(a.id)) continue;
      this.seen.add(a.id);
      this.store(
        narrateObservation(
          { description: `${a.name}, a fellow villager, nearby`, tick, subjectId: a.id, location: self.position },
          this.memory.clock,
        ),
      );
    }

    for (const o of perception.nearbyObjects) {
      if (this.seen.has(o.id)) continue;
      this.seen.add(o.id);
      this.store(
        narrateObservation(
          { description: `a ${o.type} (${o.id})`, tick, subjectId: o.id, location: self.position },
          this.memory.clock,
        ),
      );
    }

    // Remember each new gathering once: when the set of companions changes to a
    // fresh group, lay down a "I gathered with ..." memory. Dispersing clears the
    // key so a later reunion is remembered afresh.
    const g = self.gathering;
    const key = g ? g.withIds.slice().sort().join(',') : null;
    if (key && key !== this.lastGatheringKey) {
      const where = g!.place ? ` at the ${g!.place}` : '';
      this.store(
        narrateObservation(
          {
            description: `gathered in a group${where} with ${g!.withNames.join(', ')}`,
            tick,
            subjectId: g!.withIds[0] ?? this.profile.id,
            location: self.position,
          },
          this.memory.clock,
        ),
      );
    }
    this.lastGatheringKey = key;
  }

  /**
   * Hear an utterance on the bus. Two things happen, both essential:
   *   1. SHORT-TERM — buffer it in `recentSpeech` so the very next think prompt
   *      shows the running chat and the mind can join in.
   *   2. LONG-TERM (Phase 4) — record what was said in the vector store, so it
   *      survives beyond the earshot window.
   *
   * STRICT PROXIMITY: speech is BROADCAST, not directed — there is no target. We
   * hear a line only if the speaker is within our sensing radius RIGHT NOW; speech
   * does not carry across the village. (The speaker enforces the same rule before
   * publishing, so in practice only in-earshot lines are ever sent; this is the
   * matching receiver-side guard.) Everyone nearby hears the same line, which is
   * what lets several villagers hold one conversation together.
   */
  private onHeardSpeech(event: VillagerSpeakEvent): void {
    const { villagerId: speakerId, message } = event.payload;
    if (speakerId === this.profile.id) return; // our own utterance (stored in act())

    const withinEarshot =
      this.latest?.nearbyVillagers.some((a) => a.id === speakerId && a.canHear) ?? false;
    if (!withinEarshot) return; // out of earshot — speech doesn't carry across the village

    this.recentSpeech.push({
      speakerId,
      speakerName: this.world.nameOf(speakerId),
      message,
      tick: this.latest?.tick ?? 0,
      heardAt: Date.now(),
    });
    if (this.recentSpeech.length > AgentService.SPEECH_MEMORY_MAX) this.recentSpeech.shift();

    // Being spoken to nearby is the most pressing interrupt of all: ask for a window
    // now so the mind can REPLY promptly instead of waiting for its idle heartbeat —
    // this is what lets a real conversation flow.
    this.requestTurn(0.95, `${this.world.nameOf(speakerId)} spoke nearby`);

    // Commit anything we hear in the group to long-term memory — in a shared
    // conversation every line is spoken in our presence, not fleeting chatter
    // aimed elsewhere.
    if (this.memory) {
      this.store(
        narrateHeardSpeech(
          {
            speakerId,
            speakerName: this.world.nameOf(speakerId),
            message,
            tick: this.latest?.tick ?? 0,
            location: this.latest?.self.position,
          },
          this.memory.clock,
        ),
      );
    }
  }

  /** Record/refresh a shared plan, latest-per-id, pruned to the recent window. */
  private onGroupPlan(plan: GroupPlan): void {
    const idx = this.groupPlans.findIndex((p) => p.id === plan.id);
    if (idx >= 0) this.groupPlans[idx] = plan;
    else this.groupPlans.push(plan);
    // Keep the most recently-touched plans only.
    this.groupPlans.sort((a, b) => b.lastTick - a.lastTick);
    if (this.groupPlans.length > AgentService.GROUP_PLAN_MAX) {
      this.groupPlans.length = AgentService.GROUP_PLAN_MAX;
    }
  }

  /** The plan this villager is already a member of (most recent), or null. */
  private myGroupPlan(): GroupPlan | null {
    return this.groupPlans.find((p) => p.members.some((m) => m.villagerId === this.profile.id)) ?? null;
  }

  /**
   * A plan this villager could JOIN: one it is not yet in, whose members are among
   * the company it is gathered with right now. Null when nothing is forming nearby.
   */
  private joinableGroupPlan(perception: Perception): GroupPlan | null {
    const circle = new Set(perception.self.gathering?.withIds ?? []);
    if (circle.size === 0) return null;
    return (
      this.groupPlans.find(
        (p) =>
          !p.members.some((m) => m.villagerId === this.profile.id) &&
          p.members.some((m) => circle.has(m.villagerId)),
      ) ?? null
    );
  }

  /** Record/refresh one agenda item by id (a note, or a personal/shared event). */
  private onAgendaItem(item: AgendaItem): void {
    this.agendaItems.set(item.id, item);
  }

  /**
   * An agenda item was dropped by the coordinator. If it was a SCHEDULED EVENT we
   * attended whose time has now passed, lay down a memory of it before forgetting it —
   * so the day we shared (or meant to) survives in long-term memory and the nightly
   * reflection can draw on it. Stale notes and events we had no part in just fall away.
   */
  private onAgendaRemoved(itemId: string): void {
    const item = this.agendaItems.get(itemId);
    this.agendaItems.delete(itemId);
    if (!item || item.type !== 'event' || !this.memory) return;
    const attended = item.participants.some((m) => m.villagerId === this.profile.id);
    const passed = (this.latest?.tick ?? 0) >= item.scheduledTick;
    if (!attended || !passed) return;
    const where = item.placeName ? ` at the ${item.placeName}` : '';
    const others = item.participants
      .filter((m) => m.villagerId !== this.profile.id)
      .map((m) => m.villagerName);
    const company = others.length > 0 ? ` with ${others.join(', ')}` : '';
    this.store(
      narrateObservation(
        {
          description: `the time came for "${item.title}"${where}${company}`,
          tick: this.latest?.tick ?? item.scheduledTick,
          subjectId: item.organizerId,
          location: this.latest?.self.position,
        },
        this.memory.clock,
      ),
    );
  }

  /** My untimed notes, newest first. */
  private myNotes(): AgendaNote[] {
    return [...this.agendaItems.values()]
      .filter((i): i is AgendaNote => i.type === 'note' && i.ownerId === this.profile.id)
      .sort((a, b) => b.createdTick - a.createdTick);
  }

  /** Events I am attending (personal or shared), soonest first. */
  private myEvents(): AgendaEvent[] {
    return [...this.agendaItems.values()]
      .filter(
        (i): i is AgendaEvent =>
          i.type === 'event' && i.participants.some((m) => m.villagerId === this.profile.id),
      )
      .sort((a, b) => a.scheduledTick - b.scheduledTick);
  }

  /** Events I have been invited to but not yet accepted, soonest first. */
  private myInvitedEvents(): AgendaEvent[] {
    return [...this.agendaItems.values()]
      .filter(
        (i): i is AgendaEvent =>
          i.type === 'event' &&
          i.invited.some((m) => m.villagerId === this.profile.id) &&
          !i.participants.some((m) => m.villagerId === this.profile.id),
      )
      .sort((a, b) => a.scheduledTick - b.scheduledTick);
  }

  /** Drop utterances older than the earshot window (wall-clock). */
  private pruneSpeech(now: number): void {
    const cutoff = now - this.speechRetentionMs;
    while (this.recentSpeech.length > 0 && this.recentSpeech[0].heardAt < cutoff) {
      this.recentSpeech.shift();
    }
  }

  // -------------------------------------------------------------------------
  // REACT — fold each tick's change into the inter-think log + an urgency signal
  // -------------------------------------------------------------------------

  /**
   * Compare the previous tick's perception with this one and record what changed
   * around the villager: neighbours coming within earshot or sight (or passing by),
   * neighbours leaving earshot, arriving where it was headed, and any need crossing
   * into distress. Each notable change is appended to {@link sinceLastThink} (shown
   * next think) and, when pressing enough, raises an INTERRUPT so the scheduler grants
   * an out-of-turn window instead of waiting for the idle heartbeat.
   */
  private observeChange(prev: Perception | null, curr: Perception): void {
    if (!prev) return;
    let urgency = 0;
    let topReason: string | undefined;
    const raise = (u: number, note: string): void => {
      this.pushSinceLastThink(note);
      if (u > urgency) {
        urgency = u;
        topReason = note;
      }
    };

    // Arrived: we were walking somewhere last tick and are now standing still.
    if (!prev.self.idle && curr.self.idle) raise(0.6, 'you arrived where you were headed');

    // A need crossing into distress is pressing — the mind should act on it now.
    const D = AgentService.NEED_DISTRESS;
    for (const k of ['hunger', 'thirst', 'fatigue', 'boredom'] as const) {
      if ((prev.self.needs[k] ?? 0) < D && (curr.self.needs[k] ?? 0) >= D) {
        raise(0.8, `your ${k} has grown urgent`);
      }
    }

    // Neighbours coming within earshot (a chance to talk) or just into sight.
    const prevHear = new Set(prev.nearbyVillagers.filter((v) => v.canHear).map((v) => v.id));
    const prevSeeOrHear = new Set(
      prev.nearbyVillagers.filter((v) => v.canSee || v.canHear).map((v) => v.id),
    );
    for (const v of curr.nearbyVillagers) {
      if (v.canHear && !prevHear.has(v.id)) raise(0.5, `${v.name} came within earshot`);
      else if (v.canSee && !prevSeeOrHear.has(v.id)) raise(0.3, `you caught sight of ${v.name}`);
    }
    // Someone we could hear has moved out of earshot — worth noting, not urgent.
    const currHear = new Set(curr.nearbyVillagers.filter((v) => v.canHear).map((v) => v.id));
    for (const v of prev.nearbyVillagers) {
      if (v.canHear && !currHear.has(v.id)) this.pushSinceLastThink(`${v.name} moved out of earshot`);
    }

    if (urgency > 0) this.requestTurn(urgency, topReason);
  }

  /** Append one inter-think note, de-duping the immediate repeat and bounding the buffer. */
  private pushSinceLastThink(note: string): void {
    if (this.sinceLastThink[this.sinceLastThink.length - 1] === note) return;
    this.sinceLastThink.push(note);
    if (this.sinceLastThink.length > AgentService.RECENT_EVENTS_MAX) this.sinceLastThink.shift();
  }

  /**
   * Ask the {@link MindScheduler} for an out-of-turn LLM window (the "interrupt" half
   * of the trigger). Throttled: we don't re-ask within {@link WANTS_THROTTLE_MS} unless
   * the urgency has climbed, and never while mid-thought (the scheduler already knows
   * we're busy). A no-op for a self-paced mind.
   */
  private requestTurn(urgency: number, reason?: string): void {
    if (!this.coordinated || this.thinking) return;
    const now = Date.now();
    if (now - this.lastWantsAt < AgentService.WANTS_THROTTLE_MS && urgency <= this.lastWantsUrgency) {
      return;
    }
    this.lastWantsAt = now;
    this.lastWantsUrgency = urgency;
    this.bus.publish(
      EXCHANGES.simulation,
      makeEvent('mind.wants_turn', {
        villagerId: this.profile.id,
        urgency,
        ...(reason ? { reason } : {}),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // THINK
  // -------------------------------------------------------------------------

  /**
   * The coordinator granted us this round's LLM window. Think once, then ack on
   * `sim.turn_done` with whether we acted (the coordinator uses that to start our
   * cooldown). We ALWAYS ack — even if we couldn't think (no perception yet) — so
   * the round clock never stalls waiting on us.
   */
  private async onTurnGranted(payload: { villagerId: string; tick: number }): Promise<void> {
    if (payload.villagerId !== this.profile.id) return; // someone else's turn
    this.roundTick = payload.tick;
    this.lastTurnActed = false;
    this.lastTurnKind = null;
    try {
      await this.think();
    } finally {
      this.bus.publish(
        EXCHANGES.simulation,
        makeEvent('sim.turn_done', {
          villagerId: this.profile.id,
          tick: payload.tick,
          acted: this.lastTurnActed,
          ...(this.lastTurnKind ? { decisionKind: this.lastTurnKind } : {}),
        }),
      );
    }
  }

  /**
   * True when a `move_to (x, y)` would not actually take the villager anywhere —
   * a wasted, no-op step we should drop so the mind does something useful instead.
   * Two cases:
   *   1. the target IS the tile we already stand on; or
   *   2. the target is the CENTRE of a building we have already reached (within
   *      {@link AT_BUILDING_REACH}). Minds are told to `move_to` a place's centre
   *      to "go there", but the engine snaps a footprint tile to the spot beside
   *      it — which, once we are there, is where we already stand. Without this we
   *      re-issue the same move_to our own workplace every single turn (the
   *      observed "keeps trying to move to its current position" loop).
   */
  private isRedundantMove(x: number, y: number, perception: Perception): boolean {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (Math.round(perception.self.position.x) === rx && Math.round(perception.self.position.y) === ry) {
      return true;
    }
    return perception.nearbyBuildings.some(
      (b) => b.distance <= AT_BUILDING_REACH && Math.round(b.position.x) === rx && Math.round(b.position.y) === ry,
    );
  }

  /**
   * STRICT PROXIMITY gate on speech: there must be at least one villager within
   * earshot for `say` to mean anything — speech is broadcast to whoever is near, so
   * talking with nobody around is just talking to the air. This is the sender-side
   * half of the earshot rule (listeners enforce the matching guard in
   * {@link onHeardSpeech}); together they keep speech local to a cluster.
   */
  private hasAudience(perception: Perception): boolean {
    return perception.nearbyVillagers.some((a) => a.canHear);
  }

  /** Trigger a decision if we're idle (not mid-thought) and the cadence elapsed. */
  private maybeThink(): void {
    if (this.thinking) return;
    if (Date.now() - this.lastThoughtAt < this.thinkIntervalMs) return;
    // Fire-and-forget: a slow model must never block the sensory stream.
    void this.think();
  }

  private async think(): Promise<void> {
    const perception = this.latest;
    if (!perception) return;

    this.thinking = true;
    this.lastThoughtAt = Date.now();

    // Feedback from last turn (a fumble we couldn't carry out) — read once and clear,
    // so this turn's prompt explains it and we don't repeat the mistake. Anything set
    // below is for the NEXT turn.
    const skipReason = this.lastSkippedReason;
    this.lastSkippedReason = null;

    // Phase 4 (retrieve) — embed the current situation and pull the most
    // relevant memories. We keep the `recalled` array itself (not just the
    // composed string) so the telemetry stream can show exactly what RAG fed in.
    // With no memory configured this is [] and we prompt exactly as in Phase 3.
    const recalled = this.memory
      ? await this.memory.recall(this.prompts.situationQuery(perception))
      : [];
    const system = this.prompts.system(
      recalled.map((m) => m.text),
      this.relationships?.all() ?? [],
    );
    this.pruneSpeech(Date.now());

    // The full tool set is always offered — in an emergent sim the villager's own
    // choice stands, even when it chooses to talk or think; we no longer withhold
    // deliberation tools to force action. Offer the operate-cart tool when a cart is
    // commandable this turn — within reach, OR (from the technical depot) any cart in
    // the village — so the choice appears exactly when there is a cart to command (the
    // engine re-checks the same rule) rather than cluttering the menu otherwise.
    const canCommandCart = perception.nearbyCarts.some((c) => c.canCommand);
    // The mind is offered the read-only LOOKUPS first, then the world ACTIONS — plus
    // operate-cart only when a cart is commandable this turn. The agentic loop below
    // lets it look things up, act, look again, and act more before it yields.
    const actionTools = canCommandCart ? [...ACTION_TOOLS, COMMAND_CART_TOOL] : ACTION_TOOLS;
    const tools = [...READ_TOOLS, ...actionTools];

    // Recent activity of the buildings we can sense right now, so we reason over
    // what's been done there (and see why a work attempt was refused).
    const buildingActivity = this.nearbyBuildingActivity(perception);

    // Fold in today's agenda (the block for this part of day) so the per-turn
    // decision is nudged by the morning's plan, not chosen in isolation.
    const plan = this.planner?.current() ?? null;
    let userMessage = this.prompts.user(perception, {
      recentSpeech: this.recentSpeech,
      planBlock: this.planner?.blockFor(perception.tick) ?? null,
      planTheme: plan?.theme ?? null,
      socialHub: this.socialHub,
      villageMap: this.world.villageMap(),
      buildingActivity,
      lastSkippedReason: skipReason,
      groupPlan: this.myGroupPlan(),
      joinablePlan: this.joinableGroupPlan(perception),
      agendaNotes: this.myNotes(),
      agendaEvents: this.myEvents(),
      agendaInvited: this.myInvitedEvents(),
      villageVision: this.villageVision,
      recentEvents: [...this.sinceLastThink],
    });
    // The inter-think log has now been folded into this prompt; start a fresh recap
    // for whatever happens before the next thought.
    this.sinceLastThink.length = 0;

    // THE AGENTIC LOOP. One granted turn runs a multi-step loop over a growing
    // transcript: the mind may LOOK things up (read tools, results fed back) as many
    // times as its budget allows, then take ONE WORLD ACTION — which ends the turn,
    // since acting makes the turn's perception stale (the engine resolves the intent
    // over later ticks). A rejected action feeds its reason back so the mind can
    // correct itself and act this same turn. Read lookups are budget-capped
    // (MIND_MAX_READS) and the whole loop by MIND_MAX_STEPS, so it always terminates.
    const { decision, rawOutput, steps } = await this.runAgenticTurn(perception, system, userMessage, tools);

    // Final Phase ("Inception" feed) — broadcast the full thought process every turn,
    // whether we acted or skipped, so the UI can watch the mind work. Fire-and-forget:
    // telemetry must never stall the think loop.
    this.publishTelemetry(perception, recalled, system, userMessage, rawOutput, decision, steps);
    this.thinking = false;
  }

  /**
   * Drive one mind's agentic turn to completion over a message transcript, returning
   * the full step trace, the committed action (the one world action the turn ends on,
   * for the action log / cooldown), and the raw model output across all steps.
   *
   * A provider with no `converse` (a minimal stub / test) degrades to a single
   * decision so the mind still works without the loop.
   */
  private async runAgenticTurn(
    perception: Perception,
    system: string,
    userMessage: string,
    tools: typeof ACTION_TOOLS,
  ): Promise<{ decision: AgentDecision | null; rawOutput: string; steps: AgentTraceStep[] }> {
    const steps: AgentTraceStep[] = [];
    let rawOutput = '';
    let lastDecision: AgentDecision | null = null;
    const note = (raw: string): void => {
      if (raw) rawOutput = rawOutput ? `${rawOutput}\n---\n${raw}` : raw;
    };

    const converse = this.provider.converse?.bind(this.provider);
    if (!converse) {
      // Legacy single-shot fallback for a provider without the loop.
      try {
        const result = await this.provider.decide({
          system, userMessage, tools, agent: this.profile.name ?? this.profile.id, purpose: 'decide',
          ...(this.route ? { route: this.route } : {}),
        });
        note(result.raw);
        if (result.call) {
          const outcome = this.executeAction(result.call.name, result.call.input, perception);
          if (outcome.decision) lastDecision = outcome.decision;
          steps.push({ kind: 'action', tool: result.call.name, result: outcome.result, committed: outcome.committed });
        }
      } catch (err) {
        console.warn(`[villager:${this.profile.id}] think failed:`, errMsg(err));
      }
      return { decision: lastDecision, rawOutput, steps };
    }

    const readCtx: ReadToolContext = {
      perception,
      villageMap: this.world.villageMap(),
      ...(this.memory ? { recall: (q: string) => this.memory!.recall(q) } : {}),
    };
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ];
    let reads = 0;
    let softs = 0;

    for (let step = 0; step < MIND_MAX_STEPS; step++) {
      let turn: LLMTurn;
      try {
        turn = await converse({
          messages,
          tools,
          agent: this.profile.name ?? this.profile.id,
          purpose: 'decide',
          ...(this.route ? { route: this.route } : {}),
        });
      } catch (err) {
        console.warn(`[villager:${this.profile.id}] converse failed:`, errMsg(err));
        break;
      }
      note(turn.raw);
      messages.push(assistantMessage(turn));

      // No tool call → the model is done deliberating for this turn.
      if (turn.toolCalls.length === 0) {
        steps.push({ kind: 'yield', ...(turn.content ? { thought: turn.content } : {}) });
        break;
      }

      // The model's visible text is attached to the FIRST step of this round only.
      let thought = turn.content || '';
      // Set once a world action LANDS, to end the turn after this round (see below).
      let committedAction = false;
      for (const call of turn.toolCalls) {
        const callId = call.id ?? call.name;
        const input = previewInput(call.input);
        if (isReadTool(call.name)) {
          let result: string;
          if (reads >= MIND_MAX_READS) {
            result = "You've looked into enough for now — act on what you already know.";
          } else {
            reads++;
            result = await executeReadTool(call.name, call.input, readCtx);
          }
          steps.push({ kind: 'read', tool: call.name, ...(input ? { input } : {}), result, ...(thought ? { thought } : {}) });
          messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: result });
        } else if (isSoftAction(call.name) && softs >= MIND_MAX_SOFT) {
          // Out of soft-action budget: a mind that keeps thinking/jotting but never
          // acts is the stall we guard against. Withhold this commit and push it
          // toward a PHYSICAL action so the body actually does something this turn.
          const result =
            "You've deliberated enough — now take a real action in the world (move, speak, work, take, or give).";
          steps.push({ kind: 'action', tool: call.name, ...(input ? { input } : {}), result, committed: false, ...(thought ? { thought } : {}) });
          messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: result });
        } else {
          const soft = isSoftAction(call.name);
          const outcome = this.executeAction(call.name, call.input, perception);
          if (outcome.decision) lastDecision = outcome.decision;
          steps.push({ kind: 'action', tool: call.name, ...(input ? { input } : {}), result: outcome.result, committed: outcome.committed, ...(thought ? { thought } : {}) });
          messages.push({ role: 'tool', toolCallId: callId, name: call.name, content: outcome.result });
          if (outcome.committed) {
            if (soft) {
              // A SOFT action (a private thought, an agenda note, a plan/event
              // proposal) commits but does NOT end the turn: it neither moves the
              // body nor touches a building, so `perception` is still valid and the
              // mind keeps going — it must still take a physical action this turn
              // rather than yielding on a no-op. Counted against MIND_MAX_SOFT.
              softs++;
            } else {
              // A committed PHYSICAL action ENDS the turn. The body hasn't actually
              // moved or acted yet — the engine resolves the intent over the ticks
              // that follow — so `perception` is now stale and any further action
              // this round would reason on outdated state and self-reject (the
              // move_to→work_at-rejected loop). It also stops one turn firing several
              // conflicting intents.
              committedAction = true;
              break;
            }
          }
          // A REJECTED action does NOT end the turn either: its feedback falls through
          // so the mind can correct itself in-turn (e.g. walk up to the building first).
        }
        thought = ''; // only the first step of the round carries the round's content
      }
      if (committedAction) break;
    }

    return { decision: lastDecision, rawOutput, steps };
  }

  /**
   * Execute ONE world-action tool call from the loop: parse + validate it, and either
   * commit it (publishing its intent) with a success acknowledgement, or reject it with
   * an explanation that is fed back so the mind can try something else in the SAME turn.
   *
   * Validation is the same honest, perception-local set the single-decision path used —
   * speech needs an audience, a move must go somewhere, a building action must be within
   * reach. We never reach into the engine's books (a backpack/stock shortfall is left to
   * the engine to refuse, surfacing next turn as before); we only reject what is plainly
   * void from where the villager stands.
   */
  private executeAction(
    name: string,
    input: unknown,
    perception: Perception,
  ): { decision?: AgentDecision; result: string; committed: boolean } {
    let parsed: AgentDecision;
    try {
      parsed = parseDecision(name, input);
    } catch (err) {
      const msg = err instanceof MalformedToolCallError ? err.message : errMsg(err);
      console.warn(`[villager:${this.profile.id}] malformed tool call: ${msg}`, input);
      return { result: `That action couldn't be carried out: ${msg}. Try a different one.`, committed: false };
    }

    const reject = (result: string): { result: string; committed: boolean } => {
      console.log(`[villager:${this.profile.id}] ${parsed.kind} rejected: ${result}`);
      return { result, committed: false };
    };

    switch (parsed.kind) {
      case 'say':
        if (!this.hasAudience(perception)) {
          return reject('No one is within earshot, so your words would reach no one. Move next to someone before you speak.');
        }
        break;
      case 'move_to':
        if (this.isRedundantMove(parsed.x, parsed.y, perception)) {
          return reject(`You are already standing at (${parsed.x}, ${parsed.y}); moving there would change nothing.`);
        }
        break;
      case 'work_at':
      case 'take_from':
      case 'give_to':
      case 'pray_at':
        if (!this.withinReach(parsed.buildingId, perception)) {
          return reject(`You are not close enough to ${parsed.buildingId} to do that — walk up to it first (move_to its tile).`);
        }
        break;
      case 'interact_with':
        if (!perception.nearbyObjects.some((o) => o.id === parsed.objectId)) {
          return reject(`You can't sense ${parsed.objectId} from here, so you can't interact with it.`);
        }
        break;
      case 'command_cart':
        if (!perception.nearbyCarts.some((c) => c.id === parsed.cartId && c.canCommand)) {
          return reject(`You can't command ${parsed.cartId} from here — stand beside it or at the depot.`);
        }
        break;
      default:
        break; // social / agenda / build actions carry no proximity precondition
    }

    this.commit(parsed);
    return { decision: parsed, result: ackFor(parsed), committed: true };
  }

  /** True when a building is close enough (within {@link SERVICE_REACH}) to work/take/give/pray at. */
  private withinReach(buildingId: string, perception: Perception): boolean {
    return perception.nearbyBuildings.some((b) => b.id === buildingId && b.distance <= SERVICE_REACH);
  }

  /**
   * Commit a chosen action: record it as this turn's act (so the scheduler sizes our
   * cooldown by the action) and apply it. Minds now think in PARALLEL across the
   * endpoint pool with no lockstep round boundary, so each acts the moment it decides
   * — which is what makes the village feel reactive (a reply lands right after it's
   * thought, not at some shared end-of-tick).
   */
  private commit(decision: AgentDecision): void {
    this.lastTurnActed = true;
    this.lastTurnKind = decision.kind;
    console.log(`[villager:${this.profile.id}] decided ${decision.kind}: ${JSON.stringify(decision)}`);
    this.act(decision);
  }

  /** Publish one `villager.telemetry.thought_process` envelope for this turn. */
  private publishTelemetry(
    perception: Perception,
    recalled: RecalledMemory[],
    system: string,
    user: string,
    rawOutput: string,
    decision: AgentDecision | null,
    steps: AgentTraceStep[],
  ): void {
    this.bus.publish(
      EXCHANGES.villagerTelemetry,
      makeEvent('villager.telemetry.thought_process', {
        villagerId: this.profile.id,
        villagerName: this.profile.name,
        tick: perception.tick,
        ...(this.roundTick !== undefined ? { roundTick: this.roundTick } : {}),
        recalledMemories: recalled.map((m) => ({ text: m.text, kind: m.kind, score: m.score })),
        // Show the FINAL system the model received — `system` plus the reasoning-effort
        // directive the provider appends for 'decide' — so the inspector reflects the
        // real prompt, not the bare one we composed. Providers that don't transform it
        // (or in tests) return `system` unchanged.
        prompt: { system: this.provider.effectiveSystem?.(system, 'decide') ?? system, user },
        rawOutput,
        decision,
        // Every acted decision is now the model's own (there is no scripted fallback);
        // tagged 'llm' to keep the telemetry/action-log wire shape stable.
        ...(decision ? { decisionSource: 'llm' as const } : {}),
        // The full agentic trace (lookups + actions + yield), for the inspector.
        ...(steps.length > 0 ? { steps } : {}),
      }),
    );
  }

  /** Publish this villager's freshly-revised social book for persistence + the UI. */
  private publishRelationships(relationships: Relationship[]): void {
    this.bus.publish(
      EXCHANGES.villagerTelemetry,
      makeEvent('villager.relationship.updated', {
        villagerId: this.profile.id,
        villagerName: this.profile.name,
        relationships,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // INCEPTION — a synthetic memory forced in from outside
  // -------------------------------------------------------------------------

  /**
   * Force a synthetic, high-priority memory into our vector store. Shared by the
   * God Agent (`supervisor.plant_idea`) and the human UI
   * (`user.intervention.plant_idea`). Because the implant carries maximum
   * importance, the very next recall surfaces it at the top of the prompt and we
   * act on it as if it were our own — the "Inception".
   */
  private onPlantIdea(payload: PlantIdeaPayload): void {
    if (payload.villagerId !== this.profile.id) return; // not addressed to us
    if (!this.memory) return;
    console.log(
      `[villager:${this.profile.id}] idea planted by ${payload.source}: "${payload.memory}"`,
    );
    // A planted idea can upend what the villager means to do; let today's agenda
    // catch up at the next morning tick rather than steering by a stale plan.
    this.planner?.invalidate();
    this.store(
      narrateImplant(
        { memory: payload.memory, tick: this.latest?.tick ?? 0, source: payload.source },
        this.memory.clock,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // ACT — validated decision -> intent envelope on the bus
  // -------------------------------------------------------------------------

  private act(decision: AgentDecision): void {
    const id = this.profile.id;
    switch (decision.kind) {
      case 'move_to': {
        this.profile.status = `walking to (${decision.x}, ${decision.y})`;
        this.publish(makeEvent('villager.move', { villagerId: id, x: decision.x, y: decision.y }));
        return;
      }
      case 'reason': {
        // PRIVATE: a thought kept to itself. It never goes on the bus (no neighbour
        // hears it) and has no world effect — it only lays down a `reasoning` memory
        // so the mind can recall its own deliberation next turn and follow through,
        // and so the nightly reflection learns from how it reasoned.
        this.profile.status = 'lost in thought';
        console.log(`[villager:${id}] reasons privately: "${decision.thought}"`);
        if (this.memory) {
          this.store(
            narrateReasoning(
              { thought: decision.thought, tick: this.latest?.tick ?? 0, location: this.latest?.self.position },
              this.memory.clock,
            ),
          );
        }
        return;
      }
      case 'say': {
        this.profile.status = 'speaking to those nearby';
        console.log(`[villager:${id}] says aloud: "${decision.message}"`);
        // Keep our own line in the earshot buffer so next turn we see the running
        // chat (our side included) and don't repeat ourselves or re-greet.
        this.recentSpeech.push({
          speakerId: id,
          speakerName: this.profile.name,
          message: decision.message,
          tick: this.latest?.tick ?? 0,
          heardAt: Date.now(),
          self: true,
        });
        if (this.recentSpeech.length > AgentService.SPEECH_MEMORY_MAX) this.recentSpeech.shift();
        // Phase 4 (ingest) — remember what WE said (listeners remember it via
        // onHeardSpeech), so the exchange is recorded from every point of view.
        if (this.memory) {
          this.store(
            narrateOwnSpeech(
              {
                message: decision.message,
                tick: this.latest?.tick ?? 0,
                location: this.latest?.self.position,
              },
              this.memory.clock,
            ),
          );
        }
        this.publish(makeEvent('villager.speak', { villagerId: id, message: decision.message }));
        return;
      }
      case 'interact_with': {
        this.profile.status = `interacting with ${decision.objectId}`;
        this.publish(makeEvent('villager.interact', { villagerId: id, objectId: decision.objectId }));
        return;
      }
      case 'work_at': {
        this.profile.status = `working at ${decision.buildingId}`;
        this.publish(makeEvent('villager.work', { villagerId: id, buildingId: decision.buildingId }));
        return;
      }
      case 'take_from': {
        this.profile.status = `taking ${decision.resource} from ${decision.buildingId}`;
        this.publish(
          makeEvent('villager.take', {
            villagerId: id,
            buildingId: decision.buildingId,
            resource: decision.resource,
          }),
        );
        return;
      }
      case 'give_to': {
        this.profile.status = `giving ${decision.resource} to ${decision.buildingId}`;
        this.publish(
          makeEvent('villager.give', {
            villagerId: id,
            buildingId: decision.buildingId,
            resource: decision.resource,
          }),
        );
        return;
      }
      case 'pray_at': {
        this.profile.status = `praying at ${decision.buildingId}`;
        console.log(`[villager:${id}] prays at ${decision.buildingId}: "${decision.message}"`);
        this.publish(
          makeEvent('villager.pray', {
            villagerId: id,
            villagerName: this.profile.name,
            buildingId: decision.buildingId,
            message: decision.message,
          }),
        );
        return;
      }
      case 'propose_plan': {
        this.profile.status = 'proposing a plan to the group';
        console.log(`[villager:${id}] proposes a ${decision.planKind} plan: "${decision.goal}"`);
        this.publish(
          makeEvent('villager.propose_plan', {
            villagerId: id,
            goal: decision.goal,
            planKind: decision.planKind,
            role: decision.role,
          }),
        );
        // Say it aloud too, so the company actually hears the proposal and can join.
        const spoken = `Here's a thought — ${decision.goal}. I'll ${decision.role}. Who's with me?`;
        this.speakAloud(spoken);
        return;
      }
      case 'join_plan': {
        this.profile.status = 'joining the group plan';
        console.log(`[villager:${id}] joins the group plan as "${decision.role}"`);
        this.publish(makeEvent('villager.join_plan', { villagerId: id, role: decision.role }));
        this.speakAloud(`I'm in — I'll ${decision.role}.`);
        return;
      }
      case 'propose_build': {
        const spec = buildableFor(decision.structure);
        this.profile.status = `proposing to build ${decision.name}`;
        console.log(`[villager:${id}] proposes building ${decision.structure} "${decision.name}" at (${decision.x}, ${decision.y})`);
        this.publish(
          makeEvent('villager.propose_build', {
            villagerId: id,
            structure: decision.structure,
            name: decision.name,
            ...(decision.description ? { description: decision.description } : {}),
            x: decision.x,
            y: decision.y,
          }),
        );
        // Rally the neighbours: announce it aloud so company can join and haul materials.
        // For an invented structure, name WHAT it is (the description) so the company
        // understands the new thing being raised, not a generic "a new structure".
        const what =
          decision.structure === 'custom' && decision.description
            ? `"${decision.name}" — ${decision.description}`
            : `${spec.label} — "${decision.name}"`;
        const needs = Object.entries(spec.cost)
          .map(([r, n]) => `${n} ${r}`)
          .join(' and ');
        this.speakAloud(
          `Let's build ${what}. We'll need ${needs} hauled to the site. Who's with me?`,
        );
        return;
      }
      case 'command_cart': {
        this.profile.status = `setting a cart to haul ${decision.resource}`;
        console.log(
          `[villager:${id}] commands ${decision.cartId}: haul ${decision.resource} ${decision.fromBuildingId} -> ${decision.toBuildingId}`,
        );
        this.publish(
          makeEvent('villager.command_cart', {
            villagerId: id,
            cartId: decision.cartId,
            resource: decision.resource,
            fromBuildingId: decision.fromBuildingId,
            toBuildingId: decision.toBuildingId,
          }),
        );
        this.speakAloud(`I'll set this cart to keep the ${decision.resource} moving.`);
        return;
      }
      case 'add_to_agenda': {
        this.profile.status = 'noting something on my agenda';
        console.log(`[villager:${id}] adds a ${decision.itemKind} to its agenda: "${decision.title}"`);
        this.publish(
          makeEvent('villager.add_agenda', {
            villagerId: id,
            itemKind: decision.itemKind,
            title: decision.title,
            ...(decision.dayOffset !== undefined ? { dayOffset: decision.dayOffset } : {}),
            ...(decision.partOfDay ? { partOfDay: decision.partOfDay } : {}),
            ...(decision.placeId ? { placeId: decision.placeId } : {}),
          }),
        );
        return;
      }
      case 'propose_event': {
        this.profile.status = 'proposing an event to the group';
        console.log(`[villager:${id}] proposes an event: "${decision.title}"`);
        this.publish(
          makeEvent('villager.propose_event', {
            villagerId: id,
            title: decision.title,
            dayOffset: decision.dayOffset,
            partOfDay: decision.partOfDay,
            ...(decision.placeId ? { placeId: decision.placeId } : {}),
          }),
        );
        // Announce it aloud so the company actually hears the invitation and can accept.
        const when = decision.dayOffset === 0 ? `today ${decision.partOfDay}` : `${decision.dayOffset === 1 ? 'tomorrow' : `in ${decision.dayOffset} days`}, ${decision.partOfDay}`;
        this.speakAloud(`Let's gather — ${decision.title}, ${when}. You're all invited; will you come?`);
        return;
      }
      case 'accept_event': {
        this.profile.status = 'accepting an invitation';
        console.log(`[villager:${id}] accepts event ${decision.eventId}`);
        this.publish(makeEvent('villager.accept_event', { villagerId: id, eventId: decision.eventId }));
        const ev = this.agendaItems.get(decision.eventId);
        if (ev && ev.type === 'event') this.speakAloud(`I'll be there — count me in for ${ev.title}.`);
        return;
      }
    }
  }

  /**
   * Say a line aloud as part of another action (e.g. announcing a proposed plan):
   * publish the speech intent and keep it in our own earshot buffer + memory, the
   * same bookkeeping the `say` action does, without making it a separate turn.
   */
  private speakAloud(message: string): void {
    const id = this.profile.id;
    this.recentSpeech.push({
      speakerId: id,
      speakerName: this.profile.name,
      message,
      tick: this.latest?.tick ?? 0,
      heardAt: Date.now(),
      self: true,
    });
    if (this.recentSpeech.length > AgentService.SPEECH_MEMORY_MAX) this.recentSpeech.shift();
    if (this.memory) {
      this.store(
        narrateOwnSpeech(
          { message, tick: this.latest?.tick ?? 0, location: this.latest?.self.position },
          this.memory.clock,
        ),
      );
    }
    this.publish(makeEvent('villager.speak', { villagerId: id, message }));
  }

  private publish(envelope: ReturnType<typeof makeEvent>): void {
    this.bus.publish(EXCHANGES.villagerIntents, envelope);
  }

  /**
   * Fire-and-forget memory write. Ingestion must never block or crash the
   * sense/think/act loops, so failures are logged and swallowed — a lost memory
   * is recoverable; a stalled mind is not.
   */
  private store(seed: Parameters<MemoryStream['remember']>[0]): void {
    if (!this.memory) return;
    void this.memory.remember(seed).catch((err) => {
      console.warn(`[villager:${this.profile.id}] failed to store memory:`, errMsg(err));
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Turn one assistant {@link LLMTurn} into the transcript message that records it (content + tool calls). */
function assistantMessage(turn: LLMTurn): LlmMessage {
  return {
    role: 'assistant',
    ...(turn.content ? { content: turn.content } : {}),
    ...(turn.toolCalls.length > 0
      ? {
          toolCalls: turn.toolCalls.map((c: LLMToolCall) => ({
            id: c.id ?? c.name,
            name: c.name,
            arguments: JSON.stringify(c.input ?? {}),
          })),
        }
      : {}),
  };
}

/** A short, single-line JSON preview of a tool call's input, for the trace. */
function previewInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s === '{}') return '';
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * The success acknowledgement fed back to the mind after an action commits — a
 * short, factual confirmation of what it just set in motion, so a multi-action turn
 * reads coherently ("You take wood… you set to work…"). It does NOT promise the
 * engine accepted it (a stock shortfall is still the engine's to refuse); it states
 * what the villager attempted.
 */
function ackFor(d: AgentDecision): string {
  switch (d.kind) {
    case 'move_to':
      return `You set off toward (${d.x}, ${d.y}).`;
    case 'say':
      return `You say aloud: "${d.message}"`;
    case 'reason':
      return 'You turn the thought over privately.';
    case 'interact_with':
      return `You reach for ${d.objectId}.`;
    case 'work_at':
      return `You set to work at ${d.buildingId}.`;
    case 'take_from':
      return `You take ${d.resource} from ${d.buildingId} into your backpack.`;
    case 'give_to':
      return `You hand over your ${d.resource} at ${d.buildingId}.`;
    case 'pray_at':
      return `You pray at ${d.buildingId}.`;
    case 'propose_plan':
      return `You propose a shared plan: "${d.goal}".`;
    case 'join_plan':
      return `You join the group's plan as "${d.role}".`;
    case 'propose_build':
      return `You call for raising ${d.name}; a site will open for the village to build.`;
    case 'command_cart':
      return `You set ${d.cartId} to haul ${d.resource} from ${d.fromBuildingId} to ${d.toBuildingId}.`;
    case 'add_to_agenda':
      return `You note on your agenda: "${d.title}".`;
    case 'propose_event':
      return `You propose the gathering "${d.title}" and invite those nearby.`;
    case 'accept_event':
      return 'You accept the invitation; it joins your agenda.';
    default:
      return 'Done.';
  }
}

/**
 * Choose the village's social hub from its buildings — the place lone villagers
 * are nudged toward so they converge and can meet. Preference order favours the
 * natural gathering spots (the Tavern first — the village's social heart — then
 * Hall Town, then the spring); any building is a last resort. Deterministic, so
 * every mind picks the SAME hub.
 */
function pickSocialHub(entries: MapEntry[]): SocialHub | null {
  if (entries.length === 0) return null;
  const PREFERRED = ['tavern', 'hall_town', 'water_source', 'temple'];
  for (const kind of PREFERRED) {
    const hit = entries.find((e) => e.kind === kind);
    if (hit) return { name: hit.name, position: hit.position };
  }
  const first = entries[0]!;
  return { name: first.name, position: first.position };
}
