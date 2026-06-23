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
  SimTickEndEvent,
  VillagerGroupPlanEvent,
  WorldEvent,
} from '../../shared/events';
import type { BuildingEvent, GroupPlan, Relationship, ResourceKind } from '../../shared/types';
import { BACKPACK_CAPACITY } from '../../shared/types';
import { BUILDING_LOG_WINDOW_TICKS, buildableFor } from '../../shared/buildings';
import type { CharacterProfile } from './profile';
import { WorldView, type Perception } from './sensory';
import { PromptAssembler } from './prompt/PromptAssembler';
import { AT_BUILDING_REACH, type HeardUtterance, type SocialHub } from './prompt/blocks';
import type { MapEntry } from './sensory';
import { DailyPlanner } from './planning/DailyPlanner';
import type { Synthesizer } from './memory/Synthesizer';
import type { LLMProvider } from './llm/LLMProvider';
import {
  AGENT_TOOLS,
  COMMAND_CART_TOOL,
  CONSULT_MAP_TOOL,
  MalformedToolCallError,
  parseDecision,
  type AgentDecision,
} from './tools';
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
   * Run under the {@link TurnCoordinator}: instead of self-pacing on a wall-clock
   * interval, the mind thinks only when GRANTED a turn (`sim.turn_granted`) and
   * acks when done (`sim.turn_done`). This serializes LLM use across villagers and
   * is what gives `thinkIntervalMs` no role. Defaults to false (legacy self-pace).
   */
  coordinated?: boolean;
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

  /** True when driven by the turn coordinator (think on grant, not on a timer). */
  private readonly coordinated: boolean;

  /**
   * The village's shared gathering place (tavern / market / town hall), resolved
   * once the building layout is known. A lone villager is steered here so the
   * villagers actually converge and can talk, instead of each idling at its
   * own workplace forever out of earshot. Null until `world.init` arrives.
   */
  private socialHub: SocialHub | null = null;

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
   * The action chosen this turn, HELD until the round ends. Under the coordinator a
   * mind decides during its granted window but does not act yet — it buffers the
   * decision here and applies it on `sim.tick_end`, so every villager's action for a
   * round lands together at the END OF THE TICK instead of one-by-one mid-round.
   * Null when nothing is pending. (Unused in legacy self-paced mode, which acts at
   * once.)
   */
  private pendingDecision: AgentDecision | null = null;
  /**
   * How many turns IN A ROW this mind has only DELIBERATED — chosen `say` or `reason`
   * without taking a world action. Either one alone is a livelock: agreeing to "go
   * haul the water" turn after turn (talk loop), or thinking it over again and again
   * (think loop), while never actually moving. Once this crosses
   * {@link COMMITMENT_STALL_TURNS} we withhold BOTH say and reason for a turn and push
   * the mind to act on its plan. Reset to 0 by any real action.
   */
  private consecutiveDeliberationTurns = 0;
  /**
   * Consecutive deliberation (say/reason) turns that mark a stall. Low enough to break
   * the livelock quickly, high enough to let a genuine short exchange (propose, reply,
   * confirm) happen first. NOTE: the guard is now ENFORCED — a withheld say/reason that
   * the model emits anyway is discarded and replaced by a world action (see the think
   * loop). Set at 2: a propose-and-reply beat is allowed, but the third straight turn
   * of pure talk is compelled into a concrete step — the live data showed villagers
   * negotiating the same errand for dozens of turns and never walking to it.
   */
  private static readonly COMMITMENT_STALL_TURNS = 2;

  /**
   * A short, human reason the PREVIOUS turn's chosen action could not be carried
   * out (a speech with no one in earshot, a redundant move, a malformed call).
   * Surfaced in the next turn's prompt so the mind can self-correct rather than
   * repeating the same fumble blind. Captured-and-cleared at the top of each think.
   */
  private lastSkippedReason: string | null = null;

  /**
   * The gathering (its member-set key) we have been part of across consecutive
   * think-turns, and for how many — so a group that has been together a while is
   * nudged to do more than exchange greetings (propose an errand, a story, a visit).
   * Reset whenever the company changes or disperses.
   */
  private gatheringStreakKey: string | null = null;
  private gatheringStreak = 0;
  /** Consecutive turns with the same company before its conversation counts as "warm". */
  private static readonly GATHERING_WARM_TURNS = 3;

  constructor(
    private readonly bus: EventBus,
    private readonly profile: CharacterProfile,
    private readonly provider: LLMProvider,
    options: AgentServiceOptions = {},
  ) {
    this.world = new WorldView(profile.id);
    this.prompts = new PromptAssembler(profile, options.bible ?? '');
    this.coordinated = options.coordinated ?? false;
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

    // Coordinated mode: the turn clock grants our LLM windows. We think only when
    // granted and ack when done — no self-paced loop.
    if (this.coordinated) {
      await this.bus.subscribe<SimTurnGrantedEvent>(EXCHANGES.simulation, 'sim.turn_granted', (event) =>
        this.onTurnGranted(event.payload),
      );
      // End of round: apply the decision we buffered during our turn, so the whole
      // round's actions take effect together at the end of the tick.
      await this.bus.subscribe<SimTickEndEvent>(EXCHANGES.simulation, 'sim.tick_end', () =>
        this.flushPendingDecision(),
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
        this.latest = perception;
        this.ingestObservations(perception);
        // Let the daily planner and the nightly reflection cron see the world clock
        // tick by: the planner sketches a fresh agenda each morning, reflection
        // fires each night. Both are fire-and-forget and short-circuit cheaply.
        this.planner?.onTick(perception.tick);
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

  /** Drop utterances older than the earshot window (wall-clock). */
  private pruneSpeech(now: number): void {
    const cutoff = now - this.speechRetentionMs;
    while (this.recentSpeech.length > 0 && this.recentSpeech[0].heardAt < cutoff) {
      this.recentSpeech.shift();
    }
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
   * The round ended: apply the decision we held during our turn. Buffering it until
   * now is what makes a round's actions resolve TOGETHER at the end of the tick —
   * no villager acted on another's not-yet-applied move earlier in the same round.
   * A no-op when we skipped this round (nothing buffered).
   */
  private flushPendingDecision(): void {
    const decision = this.pendingDecision;
    if (!decision) return;
    this.pendingDecision = null;
    this.act(decision);
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

    // Track how long we have kept the SAME company, so a settled group is nudged
    // toward shared action once the conversation has had time to warm up.
    const gatheringKey = perception.self.gathering
      ? perception.self.gathering.withIds.slice().sort().join(',')
      : null;
    if (gatheringKey && gatheringKey === this.gatheringStreakKey) {
      this.gatheringStreak++;
    } else {
      this.gatheringStreakKey = gatheringKey;
      this.gatheringStreak = gatheringKey ? 1 : 0;
    }
    const groupWarm = this.gatheringStreak >= AgentService.GATHERING_WARM_TURNS;

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

    // Commitment -> action. A villager that has spent several turns in a row merely
    // TALKING — agreeing on a plan ("let's fill a dozen buckets", "let's haul the
    // water") without ever taking a step toward it — is in a conversational livelock.
    // It happens at every phase, not just once a haul is gathered: they negotiate the
    // errand endlessly and never walk to the spring. Break it by WITHHOLDING both
    // deliberation tools for this turn (drop `say` AND `reason` so the model cannot
    // keep the dialogue open or retreat into more thinking) and telling it plainly to
    // act on its plan. Self-clearing: any real action resets the counter, so a normal
    // exchange (a few lines, or a thought then a step) still happens — we only cut in
    // once talk/thought has clearly stopped converting into doing.
    const commitmentStall = this.consecutiveDeliberationTurns >= AgentService.COMMITMENT_STALL_TURNS;
    // Withhold BOTH deliberation tools when stalled, so the model cannot keep talking
    // OR keep thinking instead of acting — it must pick a world action this turn.
    let tools = commitmentStall
      ? AGENT_TOOLS.filter((t) => t.name !== 'say' && t.name !== 'reason')
      : AGENT_TOOLS;
    // Offer the operate-cart tool ONLY when a cart is within reach — so the choice
    // appears exactly when the villager is beside a cart it could actually command,
    // and never clutters the menu otherwise (the engine re-checks the same reach).
    const cartInReach = perception.nearbyCarts.some((c) => c.canCommand);
    if (cartInReach) tools = [...tools, COMMAND_CART_TOOL];
    if (commitmentStall) {
      console.log(
        `[villager:${this.profile.id}] commitment stall (${this.consecutiveDeliberationTurns} talk/think turns in a row) ` +
          '— withholding speech & reasoning, nudging to act',
      );
    }

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
      commitToAction: commitmentStall,
      villageMap: this.world.villageMap(),
      buildingActivity,
      lastSkippedReason: skipReason,
      groupWarm,
      groupPlan: this.myGroupPlan(),
      joinablePlan: this.joinableGroupPlan(perception),
    });

    let decision: AgentDecision | null = null;
    let rawOutput = '';
    let consulted = false;
    try {
      // The mind gets at most one map lookup per turn: if it calls consult_map we
      // hand it the village layout and ask once more for a real action. Capping at
      // two rounds keeps a stubborn model from looping on the map forever.
      for (let round = 0; round < 2; round++) {
        const result = await this.provider.decide({
          system,
          userMessage,
          tools,
          agent: this.profile.name ?? this.profile.id,
          purpose: 'decide',
        });
        rawOutput = rawOutput ? `${rawOutput}\n---\n${result.raw}` : result.raw;

        if (result.call?.name === CONSULT_MAP_TOOL && !consulted) {
          consulted = true;
          console.log(`[villager:${this.profile.id}] consulted the village map`);
          userMessage = `${userMessage}\n\n${this.prompts.villageMap(this.world.villageMap())}`;
          continue; // think again, now with the map in hand
        }

        if (result.call) {
          const parsed = parseDecision(result.call.name, result.call.input);
          if (commitmentStall && (parsed.kind === 'say' || parsed.kind === 'reason')) {
            // The stall guard withholds say/reason from the tool contract, but a local
            // model deep in a talk loop ignores that and emits `say` anyway — and the
            // parser accepts it (it validates against all known tools, not the withheld
            // subset). Enforce the withholding HERE: discard the deliberation, note why,
            // and fall through to a real world action below so the livelock actually
            // breaks instead of running on for dozens of turns.
            console.log(
              `[villager:${this.profile.id}] stall guard: discarding ${parsed.kind} — forcing a world action`,
            );
            this.lastSkippedReason =
              'you have only been talking/thinking for several turns without acting — you must take a concrete step now (move, take, give, work), not speak or reason again';
          } else if (parsed.kind === 'say' && !this.hasAudience(perception)) {
            // STRICT PROXIMITY: speech is broadcast to whoever is near, so saying
            // something with nobody in earshot reaches no one. Don't act on it —
            // remember why (for next turn's prompt) and fall back to something useful
            // below (e.g. head to the hub to find company) instead of wasting the turn.
            console.log(
              `[villager:${this.profile.id}] cannot speak: no one within earshot this turn`,
            );
            this.lastSkippedReason =
              'you tried to say something, but no one was within earshot to hear it — walk to where neighbours are before speaking';
          } else if (parsed.kind === 'move_to' && this.isRedundantMove(parsed.x, parsed.y, perception)) {
            // The mind asked to walk somewhere it has effectively already reached
            // (its own tile, or a building it stands beside) — a wasted, no-op move.
            // Remember why, and fall back to interacting with what is here instead of
            // re-walking to where it already is.
            console.log(
              `[villager:${this.profile.id}] ignoring redundant move to (${parsed.x}, ${parsed.y}) — already there`,
            );
            this.lastSkippedReason = `you tried to move to (${parsed.x}, ${parsed.y}), but you were already standing next to it — interact with the place (take_from / give_to / work_at) instead of walking to it`;
          } else {
            decision = parsed;
          }
        }
        break; // acted, held, declined, or used up the map lookup — done this turn
      }
    } catch (err) {
      if (err instanceof MalformedToolCallError) {
        // The LLM emitted something that isn't a valid tool call. Log it (we never let
        // unvalidated output reach the bus) and let the fallback below take a real step.
        console.warn(`[villager:${this.profile.id}] malformed tool call: ${err.message}`, err.raw);
        this.lastSkippedReason = 'your last action was not understood, so it was skipped';
      } else {
        console.warn(`[villager:${this.profile.id}] think failed:`, errMsg(err));
      }
    }

    // Apply the chosen action, or — when the LLM fumbled (an invalid action we
    // declined, a malformed call, or nothing at all) — fall back to a sensible
    // contextual one, so the villager always makes progress instead of idling a turn.
    // A map consult is a legitimate use of the turn, so we don't override it.
    if (decision) {
      this.commit(decision);
    } else if (!consulted) {
      // When breaking a commitment stall, forbid the speech fallback too — a greeting
      // is still a deliberation turn and would keep the talk loop alive. Force a step.
      const fallback = this.fallbackDecision(perception, commitmentStall);
      if (fallback) {
        console.log(`[villager:${this.profile.id}] fallback action: ${fallback.kind}`);
        decision = fallback;
        this.commit(fallback);
      }
    }

    // Final Phase ("Inception" feed) — broadcast the full thought process every turn,
    // whether we acted, fell back, or skipped, so the UI can watch the mind work.
    // Fire-and-forget: telemetry must never stall the think loop.
    this.publishTelemetry(perception, recalled, system, userMessage, rawOutput, decision);
    this.thinking = false;
  }

  /**
   * Commit a chosen action: record it as this turn's act (so the coordinator starts
   * our cooldown, sized by the action), track the talk-vs-act streak that trips the
   * commitment-stall guard, and apply it. Under the coordinator the action is HELD
   * until the round ends (`sim.tick_end`) so a round's decisions land together; a
   * self-paced mind has no round boundary and acts at once.
   */
  private commit(decision: AgentDecision): void {
    this.lastTurnActed = true;
    this.lastTurnKind = decision.kind;
    if (decision.kind === 'say' || decision.kind === 'reason') this.consecutiveDeliberationTurns++;
    else this.consecutiveDeliberationTurns = 0;
    console.log(`[villager:${this.profile.id}] decided ${decision.kind}: ${JSON.stringify(decision)}`);
    if (this.coordinated) this.pendingDecision = decision;
    else this.act(decision);
  }

  /**
   * The SAFETY-NET action when the LLM produced nothing usable (an invalid action we
   * declined, a malformed call, or no call at all). A compact rule layer that keeps a
   * villager productive without replacing the mind's creative choices — it only fires
   * when the model has already fumbled. Reads what is right next to the villager and
   * does the obvious thing there; failing that, greets present company or heads for
   * the social hub. Returns null only when truly nothing sensible is to hand.
   */
  private fallbackDecision(perception: Perception, forbidSpeech = false): AgentDecision | null {
    const { self, nearbyVillagers, nearbyBuildings } = perception;
    const backpack = self.backpack;
    const free = BACKPACK_CAPACITY - backpack.length;

    // The building we are already standing beside (if any) — do the obvious chore there.
    const at = nearbyBuildings.find((b) => b.distance <= AT_BUILDING_REACH);
    if (at) {
      const hasRoom = (r: ResourceKind): boolean => (at.stock[r] ?? 0) < at.capacity;
      const carries = (r: ResourceKind): boolean => backpack.includes(r);
      switch (at.kind) {
        case 'water_source':
          if (free > 0) return { kind: 'take_from', buildingId: at.id, resource: 'water' };
          break;
        case 'lumber_source':
          if (free > 0) return { kind: 'take_from', buildingId: at.id, resource: 'wood' };
          break;
        case 'quarry':
          if (free > 0) return { kind: 'take_from', buildingId: at.id, resource: 'stone' };
          break;
        case 'construction_site': {
          // Standing at a half-built structure: hand over whatever building material
          // we carry (the engine takes only what it still needs and ignores the rest).
          const give = (['stone', 'wood', 'goods'] as ResourceKind[]).find((r) => carries(r));
          if (give) return { kind: 'give_to', buildingId: at.id, resource: give };
          break;
        }
        case 'greenfield':
          // Hand over carried water if there's room; else work the field to make food
          // (only when it actually can be worked — has water in, food not yet full).
          if (carries('water') && hasRoom('water')) return { kind: 'give_to', buildingId: at.id, resource: 'water' };
          if ((at.stock.water ?? 0) > 0 && hasRoom('food')) return { kind: 'work_at', buildingId: at.id };
          break;
        case 'workshop':
          // Hand over carried wood if there's room; else work the forge into goods
          // (only when it can be worked — has wood in, goods not yet full).
          if (carries('wood') && hasRoom('wood')) return { kind: 'give_to', buildingId: at.id, resource: 'wood' };
          if ((at.stock.wood ?? 0) > 0 && hasRoom('goods')) return { kind: 'work_at', buildingId: at.id };
          break;
        case 'hall_town': {
          // Drop whatever haul we are carrying into the larder, if it has room.
          const give = (['food', 'water'] as ResourceKind[]).find((r) => carries(r) && hasRoom(r));
          if (give) return { kind: 'give_to', buildingId: at.id, resource: give };
          break;
        }
        case 'tavern':
          // Stock the inn with any goods we are carrying, if it has room.
          if (carries('goods') && hasRoom('goods')) return { kind: 'give_to', buildingId: at.id, resource: 'goods' };
          break;
        case 'temple':
          return {
            kind: 'pray_at',
            buildingId: at.id,
            message: 'I give thanks, and ask that the village be provided for.',
          };
        // case 'house': resting relieves fatigue automatically — nothing to issue.
      }
    }

    // Someone is in earshot — a greeting is always a valid, social fallback. But when
    // breaking a commitment stall we suppress speech (a greeting is just more talk) and
    // instead make a physical step: walk to the nearest sensed building so the villager
    // actually moves toward doing something rather than idling in the chatter.
    if (!forbidSpeech && nearbyVillagers.some((a) => a.canHear)) return { kind: 'say', message: 'Hello there!' };
    if (forbidSpeech && nearbyBuildings.length > 0) {
      const target = nearbyBuildings
        .filter((b) => b.distance > AT_BUILDING_REACH)
        .sort((a, b) => a.distance - b.distance)[0];
      if (target && !this.isRedundantMove(target.position.x, target.position.y, perception)) {
        return { kind: 'move_to', x: target.position.x, y: target.position.y };
      }
    }

    // Otherwise head to where the village gathers, unless we are already there.
    if (this.socialHub && !this.isRedundantMove(this.socialHub.position.x, this.socialHub.position.y, perception)) {
      return { kind: 'move_to', x: this.socialHub.position.x, y: this.socialHub.position.y };
    }
    return null;
  }

  /** Publish one `villager.telemetry.thought_process` envelope for this turn. */
  private publishTelemetry(
    perception: Perception,
    recalled: RecalledMemory[],
    system: string,
    user: string,
    rawOutput: string,
    decision: AgentDecision | null,
  ): void {
    this.bus.publish(
      EXCHANGES.villagerTelemetry,
      makeEvent('villager.telemetry.thought_process', {
        villagerId: this.profile.id,
        villagerName: this.profile.name,
        tick: perception.tick,
        ...(this.roundTick !== undefined ? { roundTick: this.roundTick } : {}),
        recalledMemories: recalled.map((m) => ({ text: m.text, kind: m.kind, score: m.score })),
        prompt: { system, user },
        rawOutput,
        decision,
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
            x: decision.x,
            y: decision.y,
          }),
        );
        // Rally the neighbours: announce it aloud so company can join and haul materials.
        const needs = Object.entries(spec.cost)
          .map(([r, n]) => `${n} ${r}`)
          .join(' and ');
        this.speakAloud(
          `Let's build ${spec.label} — "${decision.name}". We'll need ${needs} hauled to the site. Who's with me?`,
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
