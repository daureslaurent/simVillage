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

import type { Villager, AgentDecision, AgentTraceStep, AgendaItem, AgendaPartOfDay, BuildableId, Cart, ResourceKind, Tree, Building, BuildingStock, BuildingEvent, WeatherKind, Conversation, Gathering, Relationship, GroupPlan, EntityType, LlmCallPurpose, SupervisorDailyReportPayload, EffortPurpose, ReasoningEffort, ReasoningEffortSettings, LlmModelConfig, LlmPoolConfig, LlmUsage, VillageVision, VillageScoreboard, TerrainPalette, VillageSize, RivalSetupParams, SpawnableType } from './types';

export type { DivineAct, SupervisorDailyReportPayload, VillageVision } from './types';
import type { WorldDigestVitals, VillagePolicy, VillageOrder, DigestEvent } from './types';
export type { WorldDigestVitals, VillagePolicy, VillageOrder, DigestEvent } from './types';

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
  /** Flavour of an LLM-generated village (theme label + a sentence). Absent for the classic seed. */
  theme?: string;
  setting?: string;
  /** Themed ground colours (see {@link TerrainPalette}); absent in old saves. */
  palette?: TerrainPalette;
  /** Second ground palette for the rival (east) side of a two-village world. */
  rivalPalette?: TerrainPalette;
  /** Tile x where the ground switches from `palette` (west) to `rivalPalette` (east). */
  paletteSplitX?: number;
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

/**
 * Progress of an LLM world GENERATION, streamed while the backend builds a fresh
 * village (which takes minutes) so the browser can show a live loading overlay.
 * Emitted ONLY when `GENERATE_LLM=on` and a generation is actually running — a
 * normal boot never sends these, so the overlay only ever appears during true
 * generation. The final event carries `done: true`, immediately before the engine
 * publishes `world.init`. `step`/`total` are set for the per-villager phase so the
 * UI can show "3 of 6".
 */
export interface WorldGeneratingPayload {
  /** Which stage of generation we're in. */
  phase: 'map' | 'villagers' | 'bible' | 'assembling';
  /** Human, present-tense line for the overlay (e.g. "Bringing the villagers to life"). */
  label: string;
  /** 1-based index within a counted phase (the villagers), when applicable. */
  step?: number;
  /** Total items in a counted phase (the villager count), when applicable. */
  total?: number;
  /** True on the final event, just before `world.init`; tells the UI to dismiss. */
  done?: boolean;
}

/** The backend has no world and is waiting for the player's setup choice. */
export interface WorldNeedsSetupPayload {
  canAuto: boolean;
  defaultStyle: string;
  maxVillagers: number;
  defaultVillagers: number;
  defaultSize: VillageSize;
  /** Two-village (rival) world — show the rival setup layout. See {@link WorldNeedsSetupMessage.rival}. */
  rival?: boolean;
}

/** A fast style-colour preview for the setup screen (answer to `user.config.preview_style`). */
export interface WorldStylePreviewPayload {
  requestId: number;
  theme: string;
  palette: TerrainPalette;
}

export type WorldInitEvent = EventEnvelope<'world.init', WorldInitPayload>;
export type WorldMapUpdatedEvent = EventEnvelope<'world.map_updated', WorldMapUpdatedPayload>;
export type WorldWeatherChangedEvent =
  EventEnvelope<'world.weather_changed', WorldWeatherChangedPayload>;
export type WorldBuildingEvent = EventEnvelope<'world.building_event', WorldBuildingEventPayload>;
export type WorldGeneratingEvent = EventEnvelope<'world.generating', WorldGeneratingPayload>;
export type WorldNeedsSetupEvent = EventEnvelope<'world.needs_setup', WorldNeedsSetupPayload>;
export type WorldStylePreviewEvent = EventEnvelope<'world.style_preview', WorldStylePreviewPayload>;

/** Everything published to `world.events`. Narrow on `.type`. */
export type WorldEvent =
  | WorldInitEvent
  | WorldMapUpdatedEvent
  | WorldWeatherChangedEvent
  | WorldBuildingEvent
  | WorldGeneratingEvent
  | WorldNeedsSetupEvent
  | WorldStylePreviewEvent;

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
  /** Which village's supervisor should hear it (v3 rival seam); absent ⇒ DEFAULT_VILLAGE_ID. */
  villageId?: string;
}

/** "Deliberate now." A human nudge for the Supervisor to act off its daily cadence. */
export interface UserSupervisorForceRunPayload {
  /** Which village's supervisor to force-run (v3 rival seam); absent ⇒ DEFAULT_VILLAGE_ID. */
  villageId?: string;
}

/**
 * v3 — the human SEIZES (or releases) the wheel: pause the autonomous LLM supervisor so
 * it stops thinking each day, leaving the human to drive (divine powers + force-run still
 * work while paused); resume to hand control back. Part of the §8 human override.
 */
export interface UserSupervisorPausePayload {
  paused: boolean;
  /** Which village's supervisor to pause/resume (v3 rival seam); absent ⇒ DEFAULT_VILLAGE_ID. */
  villageId?: string;
}

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
export type UserSupervisorPauseEvent =
  EventEnvelope<'user.supervisor.pause', UserSupervisorPausePayload>;

/** The human god's divine powers (single-word keys the engine binding receives). */
export type UserSetWeatherEvent = EventEnvelope<'user.set_weather', UserSetWeatherPayload>;
export type UserSpawnEvent = EventEnvelope<'user.spawn_entity', UserSpawnPayload>;
export type UserBlessEvent = EventEnvelope<'user.bless', UserBlessPayload>;
export type UserSmiteEvent = EventEnvelope<'user.smite', UserSmitePayload>;

/** Set the reasoning effort for one LLM call purpose (a backend-config change). */
export interface UserSetReasoningEffortPayload {
  purpose: EffortPurpose;
  level: ReasoningEffort;
}
/**
 * A Settings-window change to the model's reasoning effort. A MULTI-word key the
 * engine's one-word `user.*` binding skips — handled only by the backend
 * (`user.config.*`), which owns the LLM client and persists the setting.
 */
export type UserSetReasoningEffortEvent =
  EventEnvelope<'user.config.set_reasoning_effort', UserSetReasoningEffortPayload>;

/** Switch the engine's global chat model (a backend-config change). */
export interface UserSetLlmModelPayload {
  model: string;
}
/**
 * A Settings-window model switch. Like {@link UserSetReasoningEffortEvent} a
 * MULTI-word `user.config.*` key the engine's one-word `user.*` binding skips —
 * handled only by the backend, which owns the LLM client and persists the choice.
 */
export type UserSetLlmModelEvent =
  EventEnvelope<'user.config.set_llm_model', UserSetLlmModelPayload>;

/** Re-discover the backend's available models and re-broadcast the config. */
export type UserRefreshLlmModelsEvent =
  EventEnvelope<'user.config.refresh_llm_models', Record<string, never>>;

/** Create the village from the setup screen — `user.config.*` so the engine skips it. */
export interface UserGenerateWorldPayload {
  mode: 'auto' | 'static';
  style?: string;
  villagers?: number;
  size?: VillageSize;
  /** Two-village (rival) selections; see {@link RivalSetupParams}. Present only in rival mode. */
  rival?: RivalSetupParams;
}
export type UserGenerateWorldEvent =
  EventEnvelope<'user.config.generate_world', UserGenerateWorldPayload>;

/** A fast style-colour preview request from the setup screen. */
export interface UserPreviewStylePayload {
  requestId: number;
  style: string;
}
export type UserPreviewStyleEvent =
  EventEnvelope<'user.config.preview_style', UserPreviewStylePayload>;

/** Wipe the world and return to setup ("New Village"). */
export type UserResetWorldEvent =
  EventEnvelope<'user.config.reset_world', Record<string, never>>;

/** Everything published to `user.commands`. Narrow on `.type`. */
export type UserCommandEvent =
  | UserForceMoveEvent
  | UserSyncEvent
  | UserPlantIdeaEvent
  | UserSupervisorVerdictEvent
  | UserSupervisorForceRunEvent
  | UserSupervisorPauseEvent
  | UserSetWeatherEvent
  | UserSpawnEvent
  | UserBlessEvent
  | UserSmiteEvent
  | UserSetReasoningEffortEvent
  | UserSetLlmModelEvent
  | UserRefreshLlmModelsEvent
  | UserGenerateWorldEvent
  | UserPreviewStyleEvent
  | UserResetWorldEvent;

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
  /**
   * For an INVENTED structure (`structure: 'custom'`): what it is, in the proposer's
   * words — becomes the finished landmark's function. Ignored for catalog kinds.
   */
  description?: string;
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

/**
 * A villager adds an item to its OWN agenda: an untimed `note`, or a personal `event`
 * fixed to `dayOffset` (days from today) + `partOfDay` and optionally a `placeId`. Only
 * the {@link AgendaCoordinator} consumes this; the engine ignores it like the plan intents.
 */
export interface VillagerAddAgendaPayload {
  villagerId: string;
  itemKind: 'note' | 'event';
  title: string;
  /** Events only: days from today (0 = today). */
  dayOffset?: number;
  /** Events only: the part of day it happens in. */
  partOfDay?: AgendaPartOfDay;
  /** Events only: the building id it happens at, if any. */
  placeId?: string;
}

/**
 * A villager PROPOSES a shared event to the gathering it is in: a happening at
 * `dayOffset` + `partOfDay` (optionally at `placeId`). The coordinator opens the event
 * with the proposer attending and everyone gathered with them invited.
 */
export interface VillagerProposeEventPayload {
  villagerId: string;
  title: string;
  dayOffset: number;
  partOfDay: AgendaPartOfDay;
  placeId?: string;
}

/** A villager ACCEPTS an event it was invited to (by id), committing to attend. */
export interface VillagerAcceptEventPayload {
  villagerId: string;
  eventId: string;
}

export type VillagerAddAgendaEvent = EventEnvelope<'villager.add_agenda', VillagerAddAgendaPayload>;
export type VillagerProposeEventEvent =
  EventEnvelope<'villager.propose_event', VillagerProposeEventPayload>;
export type VillagerAcceptEventEvent =
  EventEnvelope<'villager.accept_event', VillagerAcceptEventPayload>;

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
  /**
   * Which village this summary is FOR (v3 rival-village seam). The aggregator emits one
   * summary per village; a supervisor reads only its own. Optional + defaulting to
   * {@link DEFAULT_VILLAGE_ID} so a single-village world is unchanged.
   */
  villageId?: string;
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
  /**
   * Structures the village FINISHED building this day, one human line each (e.g.
   * "Hearthstone Hall — raised a house"). The objective signal of growth the god
   * reads to judge how city-like the village has become and to record milestones.
   */
  completedBuilds?: string[];
  /**
   * v3 — the aggregate WORLD DIGEST vitals (needs/stocks/buildings) the supervisor
   * reads to set the village {@link VillagePolicy}. Optional for back-compat: older
   * summaries (and the very first tick before any villager is seen) omit it.
   */
  digest?: WorldDigestVitals;
  /**
   * v3 P4 — salient world events the engine detected DURING this day (a famine, a store
   * run dry, a newcomer, a surplus). The colour that makes the day legible to the god,
   * beyond the flat vitals. Omitted when the day passed without a notable happening.
   */
  events?: DigestEvent[];
}

export type VillageDailySummaryEvent =
  EventEnvelope<'village.daily_summary', VillageDailySummaryPayload>;

/**
 * v3 P4 (design §8) — a HIGH-SALIENCE world event that should INTERRUPT the god's daily
 * cadence: a crisis the village can't wait until nightfall for the god to notice (a famine
 * setting in, the larder run empty). The supervisor deliberates out-of-turn on receipt,
 * subject to its pause flag + an interrupt cool-off so a sustained crisis can't spam it.
 */
export type VillageAlertEvent = EventEnvelope<'village.alert', DigestEvent>;

/**
 * v3 P4 (design §7) — a RARE villager-LLM "moment". Under the utility brain villagers are
 * mute automatons; a moment hands ONE of them a single real language-model turn for a
 * memorable beat (a cry in a famine, acting on the god's whisper, a festival), then it
 * drops back to the cheap brain. The {@link MomentCoordinator} owns a small per-day budget
 * and emits this at the chosen villager; that villager folds `reason` into its prompt and
 * thinks once with the LLM. A no-op for villagers already on the LLM brain.
 */
export interface VillageMomentPayload {
  /** Which villager is granted the rare LLM turn. */
  villagerId: string;
  /** Why — folded into the villager's prompt so its one turn reacts to the occasion. */
  reason: string;
  /** What occasioned the moment, for logs/telemetry. */
  kind: 'crisis' | 'whisper' | 'festival' | 'newcomer';
}

export type VillageMomentEvent = EventEnvelope<'village.moment', VillageMomentPayload>;

/**
 * A real-time HEARTBEAT digest, emitted on a wall-clock interval (independent of the
 * in-game day, which is ~40 real minutes long). It carries the same live per-village
 * digest as a daily summary so the god can re-tune POLICY and issue ORDERS several times
 * an hour instead of once a day — the steering layer that keeps the village in motion.
 * Unlike `village.daily_summary` it advances NO day bookkeeping (no chronicle, vision,
 * or long-term memory write); it is a pure between-days nudge.
 */
export type VillagePulseEvent = EventEnvelope<'village.pulse', VillageDailySummaryPayload>;

/**
 * The kinds of LIVE world LOOKUP the agentic supervisor may request mid-deliberation.
 * Each is a read-only question answered from the village read-model the
 * {@link DailySummaryAggregator} already holds (current villager + building snapshot),
 * so the god can INVESTIGATE before it acts rather than steer blind off the daily digest.
 */
export type SupervisorQueryKind =
  | 'inspect_villager'
  | 'list_villagers'
  | 'list_buildings'
  | 'scan_rival';

/**
 * The agentic god ASKING the read-model a question (supervisor -> aggregator). Rides
 * `supervisor.commands` (the engine + gateway safely ignore the unknown key); the
 * aggregator answers from its current snapshot with a matching {@link VillageQueryResultEvent}.
 * `queryId` correlates request and reply; `villageId` scopes the answer to the asking god.
 */
export interface SupervisorQueryPayload {
  /** Globally-unique id correlating this request with its result. */
  queryId: string;
  /** Which village is asking — the answer is scoped to it (a rival can't read our roster). */
  villageId: string;
  kind: SupervisorQueryKind;
  /** Lookup specifics, e.g. `{ villagerId }` or `{ buildingKind }`. */
  args?: { villagerId?: string; buildingKind?: string };
}

export type SupervisorQueryEvent = EventEnvelope<'supervisor.query', SupervisorQueryPayload>;

/**
 * The read-model's ANSWER to a {@link SupervisorQueryEvent} (aggregator -> supervisor), keyed
 * by the request's `queryId`. `summary` is the human-readable prose the god reads back into
 * its deliberation; `ok` is false when the lookup found nothing (an unknown villager id).
 */
export interface VillageQueryResultPayload {
  queryId: string;
  ok: boolean;
  summary: string;
}

export type VillageQueryResultEvent =
  EventEnvelope<'village.query_result', VillageQueryResultPayload>;

export type SupervisorDailyReportEvent =
  EventEnvelope<'village.daily_report', SupervisorDailyReportPayload>;

/**
 * The village's shared VISION, broadcast by the god whenever it reassesses the
 * settlement's growth (each day, and once on boot from the restored state). Every
 * villager folds the latest into its prompt so the collective goal — grow the
 * village into a city — and the milestones reached so far are always in front of it.
 */
export type VillageVisionEvent = EventEnvelope<'village.vision', VillageVision>;

/**
 * The village COMPETITION SCOREBOARD, emitted by the aggregator each pulse + day
 * boundary: every village's blended 0..100 standing and its per-pillar breakdown.
 * The gateway forwards it to the browser's HUD + supervisor panel.
 */
export type VillageScoreEvent = EventEnvelope<'village.score', VillageScoreboard>;

/** Everything published to `village.events`. Narrow on `.type`. */
export type VillageEvent =
  | VillageDailySummaryEvent
  | SupervisorDailyReportEvent
  | VillageVisionEvent
  | VillageScoreEvent
  | VillageAlertEvent
  | VillageMomentEvent
  | VillagePulseEvent
  | VillageQueryResultEvent;

// ---------------------------------------------------------------------------
// supervisor.commands  (the "God Agent" -> engine & villagers)
// ---------------------------------------------------------------------------

/** Introduce a new entity at a tile. `spawn_entity(type, x, y)` on the wire. */
export interface SupervisorSpawnEntityPayload {
  entityType: SpawnableType;
  x: number;
  y: number;
  /** Wall/gate line length in segments (see {@link SpawnEntityCommand.length}). */
  length?: number;
  /** Wall line direction: 'h' east, 'v' south (see {@link SpawnEntityCommand.orientation}). */
  orientation?: 'h' | 'v';
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
/**
 * v3 — the supervisor's standing POLICY (`set_priorities`): the priority weights that
 * steer every villager's utility brain. Broadcast on `supervisor.commands`; the minds
 * fold it into their scores, and the UI/chronicle can show what the god is steering.
 */
export type SupervisorSetPrioritiesEvent =
  EventEnvelope<'supervisor.set_priorities', VillagePolicy>;
/**
 * v3 — a targeted, expiring ORDER (`issue_order`): the supervisor (or a human) pushes
 * specific villagers at a task for a while. The utility brain folds it in as a large,
 * soft bonus; it expires by `ttlTicks` and the village relaxes back to policy.
 */
export type SupervisorIssueOrderEvent =
  EventEnvelope<'supervisor.issue_order', VillageOrder>;

/** Everything published to `supervisor.commands`. Narrow on `.type`. */
export type SupervisorCommandEvent =
  | SupervisorSpawnEntityEvent
  | SupervisorChangeWeatherEvent
  | SupervisorPlantIdeaEvent
  | SupervisorSetPrioritiesEvent
  | SupervisorIssueOrderEvent
  | SupervisorQueryEvent;

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
   * The in-world tick this think was granted in, when the village runs under the
   * `MindScheduler`. Absent for an uncoordinated (legacy self-paced) mind.
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
  /**
   * Where {@link decision} came from: `'llm'` when the model chose it, `'utility'`
   * when the v3 rule-driven {@link UtilityBrain} scored and picked it (no LLM call),
   * `'fallback'` when the model produced nothing usable (a malformed call, a declined
   * action, or an engine error) and we substituted a scripted contextual step. A
   * `'fallback'` turn has an empty (or partial) {@link rawOutput} — it is NOT an
   * authored LLM decision, so consumers can tell the two apart. Omitted on skipped turns.
   */
  decisionSource?: 'llm' | 'utility' | 'fallback';
  /**
   * The full agentic TRACE for this turn — every lookup tool, world action, and the
   * final yield, in order — when the mind ran the multi-step loop. Absent for a
   * single-decision turn. {@link decision} remains the representative committed action.
   */
  steps?: AgentTraceStep[];
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

/**
 * An agenda item was created or changed (a new note/event, a fresh acceptance). Rides
 * the telemetry exchange so the minds keep their own agenda current AND the gateway can
 * surface every villager's agenda to the UI. Carries the whole item each time.
 */
export type VillagerAgendaEvent = EventEnvelope<'villager.agenda.updated', AgendaItem>;

/** An agenda item was dropped (an event whose time has passed, or a stale note). */
export type VillagerAgendaRemovedEvent =
  EventEnvelope<'villager.agenda.removed', { itemId: string }>;

/** Everything published to `villager.telemetry`. Narrow on `.type`. */
export type VillagerTelemetryEvent =
  | VillagerThoughtProcessEvent
  | VillagerConversationEvent
  | VillagerRelationshipEvent
  | VillagerGroupPlanEvent
  | VillagerAgendaEvent
  | VillagerAgendaRemovedEvent;

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
  /** Token usage the model reported for this call, when available. */
  usage?: LlmUsage;
}

/**
 * A STREAMING delta of an in-flight `/decide` call — one slice of the model's
 * output as the engine relays the token stream back. Emitted only for the
 * `decide` endpoint (villager + God-Agent tool decisions stream end-to-end; the
 * `complete`/`embed` paths stay buffered). Many of these flow between the call's
 * `started` and `finished` events, each carrying the newest chunk of visible
 * output and/or the model's separately-reported reasoning ("thinking").
 */
export interface LlmCallDeltaPayload {
  /** The id of the `started`/`finished` pair this delta belongs to. */
  id: number;
  /** Newest slice of visible output text (may include `<think>` tags to split client-side). */
  content?: string;
  /** Newest slice of separately-reported reasoning, when the model breaks it out. */
  reasoning?: string;
}

export type LlmCallStartedEvent = EventEnvelope<'engine.llm.started', LlmCallStartedPayload>;
export type LlmCallDeltaEvent = EventEnvelope<'engine.llm.delta', LlmCallDeltaPayload>;
export type LlmCallFinishedEvent = EventEnvelope<'engine.llm.finished', LlmCallFinishedPayload>;

/** The engine's current per-purpose reasoning-effort config (broadcast on change + at boot). */
export interface EngineReasoningEffortPayload {
  settings: ReasoningEffortSettings;
}
export type EngineReasoningEffortEvent =
  EventEnvelope<'engine.reasoning_effort', EngineReasoningEffortPayload>;

/** The engine's current chat-model config (broadcast on change, refresh, + at boot). */
export interface EngineLlmModelPayload {
  config: LlmModelConfig;
}
export type EngineLlmModelEvent =
  EventEnvelope<'engine.llm_model', EngineLlmModelPayload>;

/** The engine's current POOL shape (endpoints + live busy flags), broadcast on a short interval. */
export interface EngineLlmPoolPayload {
  config: LlmPoolConfig;
}
export type EngineLlmPoolEvent =
  EventEnvelope<'engine.llm_pool', EngineLlmPoolPayload>;

/** Everything published to `engine.telemetry`. Narrow on `.type`. */
export type EngineTelemetryEvent =
  | LlmCallStartedEvent
  | LlmCallDeltaEvent
  | LlmCallFinishedEvent
  | EngineReasoningEffortEvent
  | EngineLlmModelEvent
  | EngineLlmPoolEvent;

// ---------------------------------------------------------------------------
// simulation.events  (the turn coordinator's logical-tick clock)
// ---------------------------------------------------------------------------

/**
 * A villager's mind ASKING for an LLM window because something around it changed
 * (it was spoken to, a neighbour came within earshot, a need crossed into
 * distress, it arrived somewhere). This is the INTERRUPT half of the scheduler's
 * "hybrid heartbeat + interrupt" trigger: the {@link MindScheduler} raises this
 * villager's priority and grants it a turn as soon as an endpoint is free, instead
 * of waiting for its idle heartbeat. `urgency` is 0..1 (higher = sooner).
 */
export interface MindWantsTurnPayload {
  villagerId: string;
  /** How pressing the stimulus is, 0..1. The scheduler grants highest-urgency first. */
  urgency: number;
  /** A short reason for telemetry/logs (e.g. "spoken to by Mira"). */
  reason?: string;
}

/**
 * The scheduler granting ONE villager its LLM window. Under the parallel pool,
 * up to {@link LlmPoolConfig.capacity} of these are live at once (one per free
 * endpoint); a single endpoint still serializes the minds routed to it.
 */
export interface SimTurnGrantedPayload {
  villagerId: string;
  /** The in-world tick this grant belongs to (the wall-clock sim clock). */
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
 * LEGACY (no longer emitted): under the old lockstep coordinator this signalled
 * the end of a round, when minds applied the action they'd buffered so a round's
 * decisions landed together. With the parallel {@link MindWantsTurnPayload}-driven
 * scheduler there are no rounds — each mind acts the moment it decides — so nothing
 * publishes or consumes this. The type is kept only for wire/back-compat.
 */
export interface SimTickEndPayload {
  /** The logical tick (round number) that just finished. */
  tick: number;
}

export type MindWantsTurnEvent = EventEnvelope<'mind.wants_turn', MindWantsTurnPayload>;
export type SimTurnGrantedEvent = EventEnvelope<'sim.turn_granted', SimTurnGrantedPayload>;
export type SimTurnDoneEvent = EventEnvelope<'sim.turn_done', SimTurnDonePayload>;
export type SimTickEvent = EventEnvelope<'sim.tick', SimTickPayload>;
export type SimTickEndEvent = EventEnvelope<'sim.tick_end', SimTickEndPayload>;

/** Everything published to `simulation.events`. Narrow on `.type`. */
export type SimulationEvent =
  | MindWantsTurnEvent
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
  | VillagerCommandCartEvent
  | VillagerAddAgendaEvent
  | VillagerProposeEventEvent
  | VillagerAcceptEventEvent;
