/**
 * shared/events.ts
 * ---------------------------------------------------------------------------
 * Phase 2 — "The Nervous System".
 *
 * THE SINGLE SOURCE OF TRUTH for the message bus contract. Every service that
 * speaks to RabbitMQ (the World Engine and the Ingress Gateway today; the AI
 * villager workers tomorrow) imports these types so the envelopes on the wire can
 * never silently drift.
 *
 * This file is intentionally RUNTIME-DEPENDENCY-FREE: it declares only types
 * plus a frozen constant table. That keeps it safe to import from any
 * environment (it carries no `amqplib`/Node imports), even though in practice
 * only the Node services need it. The `EventBus` wrapper that actually talks to
 * the broker lives in `bus/EventBus.ts`.
 *
 * Topology — three Topic Exchanges, one per "direction" of the nervous system:
 *
 *   world.events    engine  ->  everyone   (the world telling observers what it did)
 *   villager.intents   villagers  ->  engine     (autonomous villagers asking to act)
 *   user.commands   gateway ->  engine     ("God Hand" interventions from the UI)
 *
 * Every payload is wrapped in an `EventEnvelope` carrying `eventId`,
 * `timestamp`, `type`, and `payload`. The envelope `type` doubles as the AMQP
 * routing key, so a topic binding like `world.*` or `user.*` selects events by
 * their dotted type.
 * ---------------------------------------------------------------------------
 */

import type { Villager, AgentDecision, BuildableId, Cart, ResourceKind, Tree, Building, BuildingStock, BuildingEvent, WeatherKind, Conversation, Gathering, Relationship, GroupPlan, EntityType, LlmCallPurpose } from './types';

/** The Topic Exchanges that make up the bus, one per direction of the nervous system. */
export const EXCHANGES = {
  /** Engine -> observers: the authoritative stream of what the world did. */
  worldEvents: 'world.events',
  /** Villagers -> engine: autonomous villagers requesting to act. */
  villagerIntents: 'villager.intents',
  /** Gateway -> engine (and -> villagers): human interventions from the UI. */
  userCommands: 'user.commands',
  /** Aggregator/Supervisor -> all: macro, day-scale signals about the village. */
  villageEvents: 'village.events',
  /** The "God Agent" -> engine & villagers: macro interventions (spawn/weather/idea). */
  supervisorCommands: 'supervisor.commands',
  /** Villagers -> observers: raw, introspectable "what I was thinking" traces. */
  villagerTelemetry: 'villager.telemetry',
  /** The LLM-engine HTTP client -> observers: every round-trip to the engine, for the debug window. */
  engineTelemetry: 'engine.telemetry',
  /**
   * The turn coordinator's heartbeat. Carries the logical-tick clock: turn grants
   * (coordinator -> a villager), turn-done acks (villager -> coordinator), and the
   * per-round `sim.tick` announcement (coordinator -> observers).
   */
  simulation: 'simulation.events',
} as const;

/** Union of the three exchange names. */
export type ExchangeName = (typeof EXCHANGES)[keyof typeof EXCHANGES];

/**
 * The universal wrapper around every message on every exchange. `type` is the
 * discriminant AND the AMQP routing key; `payload` is the variant-specific body.
 */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  /** Globally-unique id for this single event (idempotency / tracing). */
  eventId: string;
  /** Unix epoch milliseconds the event was created. */
  timestamp: number;
  /** Dotted event type. Doubles as the topic routing key. */
  type: TType;
  /** The variant-specific body. Narrow via `type`. */
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// world.events  (engine -> observers)
// ---------------------------------------------------------------------------

/** Rarely-changing world description: dimensions, static terrain, tick rate. */
export interface WorldInitPayload {
  width: number;
  height: number;
  tickRate: number;
  trees: Tree[];
  /** Static village structures, carried alongside the trees. */
  buildings: Building[];
  /** Current weather, so the picture is complete for a fresh observer. */
  weather: WeatherKind;
}

/** Per-tick result of processing movement: the moving villagers' new positions. */
export interface WorldMapUpdatedPayload {
  tick: number;
  villagers: Villager[];
  /** Mobile robot-carts this tick (position, cargo, order, phase) — stream like villagers. */
  carts: Cart[];
  /** Social clusters of 2+ nearby villagers this tick (see `Gathering`). */
  gatherings: Gathering[];
  /**
   * Live stock of every building with a resource economy (see `BuildingStock`).
   * The static building list rides `world.init`; this carries only the mutable
   * stock so depletion/refill is visible without re-sending the buildings.
   */
  buildingStocks: BuildingStock[];
}

/** Emitted when the God Agent changes the weather. */
export interface WorldWeatherChangedPayload {
  weather: WeatherKind;
}

/**
 * Emitted whenever something happens to a building (a take, give, work session, a
 * refused work, a depletion/fill). Rides `world.events`, so it reaches both the
 * gateway (→ browser inspector) and the villager minds (via their `world.#`
 * subscription) with no extra wiring. The payload is the full {@link BuildingEvent}.
 */
export type WorldBuildingEventPayload = BuildingEvent;

export type WorldInitEvent = EventEnvelope<'world.init', WorldInitPayload>;
export type WorldMapUpdatedEvent = EventEnvelope<'world.map_updated', WorldMapUpdatedPayload>;
export type WorldWeatherChangedEvent =
  EventEnvelope<'world.weather_changed', WorldWeatherChangedPayload>;
export type WorldBuildingEvent = EventEnvelope<'world.building_event', WorldBuildingEventPayload>;

/** Everything published to `world.events`. Narrow on `.type`. */
export type WorldEvent =
  | WorldInitEvent
  | WorldMapUpdatedEvent
  | WorldWeatherChangedEvent
  | WorldBuildingEvent;

// ---------------------------------------------------------------------------
// user.commands  (gateway -> engine)
// ---------------------------------------------------------------------------

/** Force a villager to walk toward (x, y). The engine validates + moves it. */
export interface UserForceMovePayload {
  targetId: string;
  x: number;
  y: number;
}

/**
 * "Tell me the current world." Emitted by a freshly-started gateway that has no
 * cached snapshot to hand a connecting browser. The engine replies by
 * (re)publishing `world.init` + the latest `world.map_updated`.
 */
export type UserSyncPayload = Record<string, never>;

/**
 * Force a synthetic, high-priority memory into one villager's vector store — the
 * "Inception". Shared with the Supervisor's `supervisor.plant_idea` (same
 * payload, same villager-side handler); `source` records who whispered it.
 */
export interface PlantIdeaPayload {
  villagerId: string;
  /** The synthetic memory text, already in the villager's first-person voice. */
  memory: string;
  source: 'supervisor' | 'user';
}

/**
 * The human god's verdict on a single villager prayer, from the temple console.
 * 'choose' grants this prayer (the Supervisor answers it and dismisses all other
 * pending prayers — only one may be chosen); 'reject' drops just this one.
 */
export interface UserSupervisorVerdictPayload {
  prayerId: string;
  villagerId: string;
  villagerName: string;
  message: string;
  verdict: 'choose' | 'reject';
}

/** "Deliberate now." A human nudge for the Supervisor to act off its daily cadence. */
export type UserSupervisorForceRunPayload = Record<string, never>;

/**
 * The human god's DIVINE POWERS from the temple console, relayed straight to the
 * engine. These are single-word `user.*` keys so the engine's `user.*` binding
 * picks them up (alongside `user.force_move`), unlike the multi-word
 * `user.supervisor.*` control channel which only the Supervisor receives.
 */
export interface UserSetWeatherPayload {
  weather: WeatherKind;
}
export interface UserSpawnPayload {
  entityType: Extract<EntityType, 'villager' | 'tree'>;
  x: number;
  y: number;
}
export interface UserBlessPayload {
  villagerId: string;
}
export interface UserSmitePayload {
  villagerId: string;
}

export type UserForceMoveEvent = EventEnvelope<'user.force_move', UserForceMovePayload>;
export type UserSyncEvent = EventEnvelope<'user.sync', UserSyncPayload>;
/**
 * A human "Inception" from the UI. Note the TWO-word key: the engine's
 * one-word `user.*` binding ignores it, so only the villagers (binding
 * `user.intervention.*`) ever receive it.
 */
export type UserPlantIdeaEvent = EventEnvelope<'user.intervention.plant_idea', PlantIdeaPayload>;
/**
 * The temple-console control channel: the god's per-prayer verdict and the
 * force-run nudge. Multi-word keys the engine's `user.*` binding skips, delivered
 * only to the Supervisor (binding `user.supervisor.*`).
 */
export type UserSupervisorVerdictEvent =
  EventEnvelope<'user.supervisor.verdict', UserSupervisorVerdictPayload>;
export type UserSupervisorForceRunEvent =
  EventEnvelope<'user.supervisor.force_run', UserSupervisorForceRunPayload>;

/** The human god's divine powers (single-word keys the engine binding receives). */
export type UserSetWeatherEvent = EventEnvelope<'user.set_weather', UserSetWeatherPayload>;
export type UserSpawnEvent = EventEnvelope<'user.spawn_entity', UserSpawnPayload>;
export type UserBlessEvent = EventEnvelope<'user.bless', UserBlessPayload>;
export type UserSmiteEvent = EventEnvelope<'user.smite', UserSmitePayload>;

/** Everything published to `user.commands`. Narrow on `.type`. */
export type UserCommandEvent =
  | UserForceMoveEvent
  | UserSyncEvent
  | UserPlantIdeaEvent
  | UserSupervisorVerdictEvent
  | UserSupervisorForceRunEvent
  | UserSetWeatherEvent
  | UserSpawnEvent
  | UserBlessEvent
  | UserSmiteEvent;

// ---------------------------------------------------------------------------
// villager.intents  (villagers -> engine)
// ---------------------------------------------------------------------------

/** An autonomous villager's request to move itself toward (x, y). */
export interface VillagerMovePayload {
  villagerId: string;
  x: number;
  y: number;
}

/**
 * An autonomous villager's request to say something ALOUD to whoever is near it.
 * Speech is broadcast, not directed: `villagerId` is the speaker, and everyone
 * within earshot hears `message` (proximity is enforced by speaker and listeners).
 */
export interface VillagerSpeakPayload {
  villagerId: string;
  message: string;
}

/** An autonomous villager's request to interact with a nearby object (e.g. a tree). */
export interface VillagerInteractPayload {
  villagerId: string;
  objectId: string;
}

/**
 * An autonomous villager's request to WORK at a building to replenish its
 * resources. `villagerId` is the worker; `buildingId` is the place to refill.
 */
export interface VillagerWorkPayload {
  villagerId: string;
  buildingId: string;
}

/**
 * A villager hauling resources: `villager.take` loads `resource` from a building
 * into the backpack; `villager.give` drops carried `resource` into a building.
 */
export interface VillagerTakePayload {
  villagerId: string;
  buildingId: string;
  resource: ResourceKind;
}

export interface VillagerGivePayload {
  villagerId: string;
  buildingId: string;
  resource: ResourceKind;
}

/**
 * A villager's PRAYER at the temple — a petition addressed to the God Agent.
 * `villagerId` is the supplicant; `buildingId` is the temple prayed at; `message`
 * is what they ask of the god. The day's prayers are folded into the nightly
 * `village.daily_summary` the Supervisor reads (the inbound half of the temple
 * channel); the engine validates the villager is beside the temple.
 */
export interface VillagerPrayPayload {
  villagerId: string;
  /** The supplicant's display name, so the god/console can name them without a lookup. */
  villagerName?: string;
  buildingId: string;
  message: string;
}

/**
 * A villager opens a SHARED group plan: a common goal for the gathering it is in,
 * the kind of plan, and the part the proposer itself will take. The
 * {@link GroupCoordinator} turns this into a live {@link GroupPlan} others can join.
 */
export interface VillagerProposePlanPayload {
  villagerId: string;
  goal: string;
  planKind: 'work' | 'prayer' | 'social';
  /** The role the proposer takes on, in their own words. */
  role: string;
}

/** A villager commits to the plan its group is forming, taking on `role`. */
export interface VillagerJoinPlanPayload {
  villagerId: string;
  role: string;
}

/**
 * A villager proposes RAISING a new structure the village builds together. This one
 * intent fans out to two consumers: the engine opens a `construction_site` at the
 * chosen tile, and the {@link GroupCoordinator} opens a `build`-kind group plan so
 * neighbours can join the crew and the structure becomes a shared village goal.
 */
export interface VillagerProposeBuildPayload {
  villagerId: string;
  /** Which structure to raise — a {@link BuildableId}. */
  structure: BuildableId;
  /** The name the finished building will carry, chosen by the proposer. */
  name: string;
  x: number;
  y: number;
}

/**
 * One villager setting (or replacing) a nearby cart's standing take→deposit order.
 * Rides `villager.intents` like the other action intents; only the engine consumes
 * it (no village-plan side effect, unlike a build).
 */
export interface VillagerCommandCartPayload {
  villagerId: string;
  /** The cart being commanded. */
  cartId: string;
  /** The single resource kind the cart will haul. */
  resource: ResourceKind;
  /** Building id to load the resource FROM. */
  fromBuildingId: string;
  /** Building id to unload the resource TO. */
  toBuildingId: string;
}

export type VillagerProposePlanEvent =
  EventEnvelope<'villager.propose_plan', VillagerProposePlanPayload>;
export type VillagerJoinPlanEvent = EventEnvelope<'villager.join_plan', VillagerJoinPlanPayload>;
export type VillagerProposeBuildEvent =
  EventEnvelope<'villager.propose_build', VillagerProposeBuildPayload>;
export type VillagerCommandCartEvent =
  EventEnvelope<'villager.command_cart', VillagerCommandCartPayload>;

export type VillagerMoveEvent = EventEnvelope<'villager.move', VillagerMovePayload>;
export type VillagerSpeakEvent = EventEnvelope<'villager.speak', VillagerSpeakPayload>;
export type VillagerInteractEvent = EventEnvelope<'villager.interact', VillagerInteractPayload>;
export type VillagerWorkEvent = EventEnvelope<'villager.work', VillagerWorkPayload>;
export type VillagerTakeEvent = EventEnvelope<'villager.take', VillagerTakePayload>;
export type VillagerGiveEvent = EventEnvelope<'villager.give', VillagerGivePayload>;
export type VillagerPrayEvent = EventEnvelope<'villager.pray', VillagerPrayPayload>;

// ---------------------------------------------------------------------------
// village.events  (aggregator/supervisor -> all)
// ---------------------------------------------------------------------------

/**
 * A once-per-village-day digest the Supervisor reasons over. The aggregator
 * derives these coarse vitals cheaply from the intent + world streams; the God
 * Villager decides from them whether the village needs a challenge or a reward.
 */
export interface VillageDailySummaryPayload {
  day: number;
  tick: number;
  population: number;
  /** villager.speak count this day. */
  conversations: number;
  /** villager.move count this day. */
  movements: number;
  /** Villagers that emitted no intent at all this day. */
  idleVillagers: number;
  weather: WeatherKind;
  /** A few recent utterances, as colour for the synthesis. */
  notableQuotes?: string[];
  /** Prayers villagers offered at the temple this day — petitions to the god. */
  notablePrayers?: string[];
}

export type VillageDailySummaryEvent =
  EventEnvelope<'village.daily_summary', VillageDailySummaryPayload>;

/** Everything published to `village.events`. Narrow on `.type`. */
export type VillageEvent = VillageDailySummaryEvent;

// ---------------------------------------------------------------------------
// supervisor.commands  (the "God Agent" -> engine & villagers)
// ---------------------------------------------------------------------------

/** Introduce a new entity at a tile. `spawn_entity(type, x, y)` on the wire. */
export interface SupervisorSpawnEntityPayload {
  entityType: 'villager' | 'tree';
  x: number;
  y: number;
}

/** Set the village-wide weather. `change_weather(type)` on the wire. */
export interface SupervisorChangeWeatherPayload {
  weather: WeatherKind;
}

export type SupervisorSpawnEntityEvent =
  EventEnvelope<'supervisor.spawn_entity', SupervisorSpawnEntityPayload>;
export type SupervisorChangeWeatherEvent =
  EventEnvelope<'supervisor.change_weather', SupervisorChangeWeatherPayload>;
/** The God Agent's `plant_idea(villager_id, synthetic_memory)`; reuses PlantIdeaPayload. */
export type SupervisorPlantIdeaEvent =
  EventEnvelope<'supervisor.plant_idea', PlantIdeaPayload>;

/** Everything published to `supervisor.commands`. Narrow on `.type`. */
export type SupervisorCommandEvent =
  | SupervisorSpawnEntityEvent
  | SupervisorChangeWeatherEvent
  | SupervisorPlantIdeaEvent;

// ---------------------------------------------------------------------------
// villager.telemetry  (villagers -> observers)
// ---------------------------------------------------------------------------

/**
 * Everything that went INTO and came OUT OF one villager's LLM decision,
 * verbatim — the "Inception" feed. Published every think cadence, win or skip,
 * so the UI can watch a mind work (and watch a planted idea resurface).
 */
export interface VillagerThoughtProcessPayload {
  villagerId: string;
  villagerName: string;
  tick: number;
  /**
   * The logical SIMULATION tick (turn-coordinator round) this think happened in,
   * when the village is running under the {@link SimulationEvent} coordinator. A
   * round is one pass in which every eligible villager gets an LLM window; see
   * `TurnCoordinator`. Absent for an uncoordinated (legacy wall-clock) mind.
   */
  roundTick?: number;
  /** The memories RAG pulled for this turn (most-relevant first), with scores. */
  recalledMemories: { text: string; kind: string; score: number }[];
  /** The exact prompt halves sent to the model. */
  prompt: { system: string; user: string };
  /** The model's raw, pre-validation output (function-call JSON or content). */
  rawOutput: string;
  /** The validated decision we ACTUALLY published, or null if the turn was skipped. */
  decision: AgentDecision | null;
}

export type VillagerThoughtProcessEvent =
  EventEnvelope<'villager.telemetry.thought_process', VillagerThoughtProcessPayload>;

/**
 * A conversation was opened or extended by a new line. Rides the telemetry
 * exchange (villagers -> observers) so the gateway can forward it to the browser
 * for the live conversation list. Carries the whole conversation each time.
 */
export type VillagerConversationEvent =
  EventEnvelope<'villager.conversation.updated', Conversation>;

/**
 * One villager's social book was revised (after a nightly reflection). Rides the
 * telemetry exchange (villagers -> observers) so a server-side tracker can persist
 * it and the gateway can forward it to the browser's relationships view.
 */
export interface VillagerRelationshipPayload {
  villagerId: string;
  villagerName: string;
  relationships: Relationship[];
}
export type VillagerRelationshipEvent =
  EventEnvelope<'villager.relationship.updated', VillagerRelationshipPayload>;

/**
 * A group plan was opened or joined. Rides the telemetry exchange so observers and
 * the gateway can surface the village's shared agendas (work crews, prayer rituals).
 */
export type VillagerGroupPlanEvent =
  EventEnvelope<'villager.group_plan.updated', GroupPlan>;

/** Everything published to `villager.telemetry`. Narrow on `.type`. */
export type VillagerTelemetryEvent =
  | VillagerThoughtProcessEvent
  | VillagerConversationEvent
  | VillagerRelationshipEvent
  | VillagerGroupPlanEvent;

// ---------------------------------------------------------------------------
// engine.telemetry  (the LLM-engine HTTP client -> observers)
// ---------------------------------------------------------------------------

/** The three engine endpoints a call can hit. */
export type LlmEndpoint = '/decide' | '/complete' | '/embed';

/**
 * One LLM round-trip is STARTING. Emitted by the backend's `HttpLLMClient` the
 * moment it POSTs to the engine, so the debug window can show what is in-flight
 * (and how long it has been running — the symptom when a slow model times out).
 */
export interface LlmCallStartedPayload {
  /** Monotonic per-process call id, correlating this with its `finished` event. */
  id: number;
  endpoint: LlmEndpoint;
  /** Why the call was made — finer-grained than `endpoint` (see {@link LlmCallPurpose}). */
  purpose: LlmCallPurpose;
  /** Who issued the call: a villager name, "God Agent", or a villager id (memory). */
  agent: string;
  /** Short human label, e.g. "decide", "complete", "embed ×3". */
  label: string;
  /** Truncated, human-readable preview of the request body. */
  request: string;
  /** Unix epoch ms the call was sent. */
  startedAt: number;
}

/**
 * The matching LLM round-trip has FINISHED — successfully or not. Carries the
 * outcome, latency, and a preview of the response (or the error text), which is
 * exactly what you need to see why turns are getting skipped.
 */
export interface LlmCallFinishedPayload {
  id: number;
  endpoint: LlmEndpoint;
  purpose: LlmCallPurpose;
  label: string;
  /** True on a 2xx with a parseable body; false on HTTP error, abort, or parse failure. */
  ok: boolean;
  /** HTTP status when the engine answered with a non-2xx; absent on transport/abort errors. */
  status?: number;
  /** Wall-clock duration of the round-trip, in ms. */
  durationMs: number;
  /** Truncated preview of the reply (for /decide: the chosen tool call). */
  response: string;
  /** Error message when `ok` is false (e.g. the 500 detail, or "aborted" on timeout). */
  error?: string;
  startedAt: number;
}

export type LlmCallStartedEvent = EventEnvelope<'engine.llm.started', LlmCallStartedPayload>;
export type LlmCallFinishedEvent = EventEnvelope<'engine.llm.finished', LlmCallFinishedPayload>;

/** Everything published to `engine.telemetry`. Narrow on `.type`. */
export type EngineTelemetryEvent = LlmCallStartedEvent | LlmCallFinishedEvent;

// ---------------------------------------------------------------------------
// simulation.events  (the turn coordinator's logical-tick clock)
// ---------------------------------------------------------------------------

/**
 * The coordinator granting ONE villager its LLM window for the current round.
 * Only the addressed villager thinks; everyone else waits their turn, so the
 * single shared LLM is never hit by two minds at once.
 */
export interface SimTurnGrantedPayload {
  villagerId: string;
  /** The logical tick (round number) this grant belongs to. */
  tick: number;
}

/**
 * A villager's ack that it finished the granted turn. `acted` is true when the
 * think produced a real decision (move/speak/interact) — which is what starts the
 * villager's post-action cooldown — and false for a skipped or failed turn.
 * `decisionKind` names the action taken (e.g. 'work_at') so the coordinator can
 * vary the cooldown by action — a villager that starts working rests longer, since
 * the engine keeps it at the task. Absent when the turn was skipped.
 */
export interface SimTurnDonePayload {
  villagerId: string;
  tick: number;
  acted: boolean;
  decisionKind?: string;
}

/**
 * The per-round announcement: the new logical tick, who is acting in it, and how
 * many ticks of cooldown each resting villager has left. Forwarded to the browser
 * so the debug window can show the current tick and who is live vs. cooling down.
 */
export interface SimTickPayload {
  tick: number;
  /** Villager ids eligible to use the LLM this round (not on cooldown). */
  acting: string[];
  /** villagerId -> ticks of cooldown remaining, for those currently resting. */
  cooldown: Record<string, number>;
}

/**
 * The round is OVER: every villager granted a turn this tick has decided. Minds
 * hold the action they chose during their turn and apply it now, on this signal, so
 * all of a round's decisions take effect together AT THE END OF THE TICK rather than
 * one-by-one mid-round (no villager acts on another's not-yet-applied move).
 */
export interface SimTickEndPayload {
  /** The logical tick (round number) that just finished. */
  tick: number;
}

export type SimTurnGrantedEvent = EventEnvelope<'sim.turn_granted', SimTurnGrantedPayload>;
export type SimTurnDoneEvent = EventEnvelope<'sim.turn_done', SimTurnDonePayload>;
export type SimTickEvent = EventEnvelope<'sim.tick', SimTickPayload>;
export type SimTickEndEvent = EventEnvelope<'sim.tick_end', SimTickEndPayload>;

/** Everything published to `simulation.events`. Narrow on `.type`. */
export type SimulationEvent =
  | SimTurnGrantedEvent
  | SimTurnDoneEvent
  | SimTickEvent
  | SimTickEndEvent;

/**
 * Everything published to `villager.intents`. Narrow on `.type`.
 *
 * All keys are a single word after `villager.`, so the engine's existing
 * `villager.*` topic binding continues to receive every variant. The World Engine
 * acts on `villager.move` and `villager.work` today; `villager.speak` /
 * `villager.interact` are carried on the same exchange for future engine handling
 * (and for any observer that wants to surface villager chatter). `villager.pray`
 * is both acted on by the engine (adjacency check) and tallied by the aggregator.
 */
export type VillagerIntentEvent =
  | VillagerMoveEvent
  | VillagerSpeakEvent
  | VillagerInteractEvent
  | VillagerWorkEvent
  | VillagerTakeEvent
  | VillagerGiveEvent
  | VillagerPrayEvent
  | VillagerProposePlanEvent
  | VillagerJoinPlanEvent
  | VillagerProposeBuildEvent
  | VillagerCommandCartEvent;
