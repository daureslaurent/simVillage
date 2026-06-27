/**
 * shared/types.ts
 * ---------------------------------------------------------------------------
 * The SINGLE SOURCE OF TRUTH for the wire protocol and the world's entity
 * shapes. Both the server (World Engine + transport) and the client (Canvas
 * viewport) import this file directly, so the contract between them can never
 * silently drift.
 *
 * Design notes:
 *  - Server -> client messages are a discriminated union on `kind`.
 *  - Client -> server commands are a discriminated union on `command`.
 *  - Entities are a discriminated union on `type`.
 * Using string-literal discriminants keeps the JSON self-describing and lets
 * TypeScript exhaustively narrow each variant on both ends.
 * ---------------------------------------------------------------------------
 */

import type { VillagerAppearance } from './appearance';
export type { VillagerAppearance } from './appearance';

/** A 2D point / vector in world-grid coordinates (cells, not pixels). */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Village-wide weather, set by the "God Agent" (Supervisor) and broadcast to
 * every observer. Ambient only today — it tints the viewport and is carried in
 * the world snapshot; villagers may fold it into perception in a later phase.
 */
export type WeatherKind = 'clear' | 'rain' | 'storm' | 'fog' | 'heatwave';

/**
 * The validated, typed outcome of a single villager tool call. Narrow on
 * `.kind`. Lives here (not in villager/tools.ts) so the wire contract — the
 * telemetry envelope and the UI inspector — can be fully typed without the
 * gateway or browser importing villager internals. `agent/src/tools.ts` re-exports
 * it and owns the parser that produces it.
 */
export type AgentDecision =
  | { kind: 'move_to'; x: number; y: number }
  | { kind: 'say'; message: string }
  /** Private deliberation — a thought the villager keeps to itself (never spoken,
   *  no world effect). Stored as a `reasoning` memory and acted on next turn. */
  | { kind: 'reason'; thought: string }
  | { kind: 'interact_with'; objectId: string }
  | { kind: 'work_at'; buildingId: string }
  | { kind: 'take_from'; buildingId: string; resource: ResourceKind }
  | { kind: 'give_to'; buildingId: string; resource: ResourceKind }
  | { kind: 'pray_at'; buildingId: string; message: string }
  /** Open a SHARED plan for the group you are gathered with: a common goal and the
   *  part you yourself will take. Others can then join_plan with their own roles. */
  | { kind: 'propose_plan'; goal: string; planKind: 'work' | 'prayer' | 'social'; role: string }
  /** Commit to the shared plan your group is forming, taking on a role in it. */
  | { kind: 'join_plan'; role: string }
  /** Propose raising a new STRUCTURE the whole village builds together: which kind
   *  of thing ({@link BuildableId}), the name it will carry, and where to raise it.
   *  Opens a construction site others haul materials to — a shared village goal. For
   *  `structure: 'custom'` the villager INVENTS something new; `description` says what
   *  it is and becomes the finished landmark's function. Ignored for catalog kinds. */
  | { kind: 'propose_build'; structure: BuildableId; name: string; x: number; y: number; description?: string }
  /** Set (or replace) the standing order of a nearby {@link Cart}: which resource to
   *  haul, the building to take FROM, and the building to give TO. The cart then runs
   *  that take→deposit loop on its own. Requires standing beside the cart. */
  | {
      kind: 'command_cart';
      cartId: string;
      resource: ResourceKind;
      fromBuildingId: string;
      toBuildingId: string;
    }
  /** Add an item to your OWN agenda: either an untimed `note` (a reminder/intention)
   *  or a personal `event` fixed to a day + part of day (and optionally a place). */
  | {
      kind: 'add_to_agenda';
      itemKind: 'note' | 'event';
      title: string;
      /** Events only: days from today (0 = today, 1 = tomorrow, …). */
      dayOffset?: number;
      /** Events only: the part of day it happens in. */
      partOfDay?: AgendaPartOfDay;
      /** Events only: the building it happens at (its id), if anywhere in particular. */
      placeId?: string;
    }
  /** Propose a SHARED event to the neighbours gathered with you: a happening at a day
   *  + part of day (and optionally a place). Everyone in your gathering is invited and
   *  can accept_event to put it on their own agenda. */
  | {
      kind: 'propose_event';
      title: string;
      dayOffset: number;
      partOfDay: AgendaPartOfDay;
      placeId?: string;
    }
  /** Accept an event you have been invited to (by its id), committing to attend — it
   *  joins your agenda and you are steered there when its time nears. */
  | { kind: 'accept_event'; eventId: string };

/**
 * One step in a mind's AGENTIC TURN. A single granted turn now runs a loop: the
 * model may call read-only lookup tools (whose results are fed back), take one or
 * more world actions, and finally yield. Each step is recorded here so the whole
 * reasoning chain can be replayed in the inspector — "looked up the forge, saw it
 * was empty, hauled wood, then worked it".
 */
export interface AgentTraceStep {
  /** `read` = a lookup tool (no world effect); `action` = a world-changing tool; `yield` = the model stopped calling tools. */
  kind: 'read' | 'action' | 'yield';
  /** The tool the model called (absent for a `yield`). */
  tool?: string;
  /** Any visible reasoning/content the model emitted alongside this step. */
  thought?: string;
  /** Compact preview of the tool's input arguments. */
  input?: string;
  /** What was fed back to the model: a lookup answer, an action acknowledgement, or an error. */
  result?: string;
  /** For an `action` step: whether it actually committed an intent to the world (vs. was rejected and fed back). */
  committed?: boolean;
}

/** A role in an LLM chat transcript (the message-array the agentic loop builds). */
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

/** One tool call the model emitted, on the wire (arguments kept as a JSON string, OpenAI-style). */
export interface LlmToolCallWire {
  /** Provider-issued id, echoed back on the matching `tool`-role result message. */
  id: string;
  name: string;
  /** The raw JSON arguments string the model produced (parsed + validated downstream). */
  arguments: string;
}

/**
 * One message in the agentic transcript handed to the engine each loop step. A
 * `system`/`user` message is plain content; an `assistant` message may carry
 * `toolCalls`; a `tool` message returns one call's result, keyed by `toolCallId`.
 */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: LlmToolCallWire[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/**
 * The coarse part of an in-world day an agenda event is pinned to — the granularity
 * villagers actually reason about (mirrors {@link import('./simClock').PartOfDay}).
 * Anchored to a concrete hour by `PART_OF_DAY_HOUR` / `tickForDayPart` in simClock.
 */
export type AgendaPartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

/** Every agenda part-of-day, as a runtime list — the closed vocabulary for scheduling. */
export const AGENDA_PARTS_OF_DAY: readonly AgendaPartOfDay[] = [
  'morning',
  'afternoon',
  'evening',
  'night',
];

/** Runtime guard: is `value` one of the known {@link AgendaPartOfDay}s? */
export function isAgendaPartOfDay(value: unknown): value is AgendaPartOfDay {
  return typeof value === 'string' && (AGENDA_PARTS_OF_DAY as readonly string[]).includes(value);
}

/**
 * The kinds of resource a building can hold, serve, and be refilled with. The
 * economy is two short, parallel production chains:
 *   - SURVIVAL: the Water Source yields `water` (infinite) → Greenfield converts
 *     water into `food` → Hall Town stores both for villagers to eat and drink.
 *   - CRAFT: the Grove yields `wood` (infinite) → the Workshop converts wood into
 *     `goods` → the Tavern stocks goods, which villagers enjoy to relieve boredom.
 *   - BUILD: the Quarry yields `stone` (infinite); stone (with some wood/goods) is
 *     hauled to a construction site to raise a new structure (see {@link BuildableId}).
 * See {@link BuildingKind} for which kinds stock which.
 */
export type ResourceKind = 'water' | 'food' | 'wood' | 'goods' | 'stone';

/** Every resource kind, as a runtime list — the closed vocabulary of the economy. */
export const RESOURCE_KINDS: readonly ResourceKind[] = ['water', 'food', 'wood', 'goods', 'stone'];

/** Runtime guard: is `value` one of the known {@link ResourceKind}s? */
export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** The kinds of things that can exist in the world. Extend as phases grow. */
export type EntityType = 'villager' | 'tree' | 'building' | 'cart';

/**
 * The id of the sole village in a single-village world — the default owner stamped
 * on every owned entity (villager / building / cart) until a rival exists. The v3
 * rival-village seam (design §10) keys ownership off `BaseEntity.villageId`; with one
 * village every owned entity carries this, so nothing reads as contested and behaviour
 * is exactly as before. A second village simply means a second id alongside it.
 */
export const DEFAULT_VILLAGE_ID = 'village_0';

/**
 * The id of the SECOND (rival) village in a two-village world (v3 P5 soft competition,
 * design §10). The home village is {@link DEFAULT_VILLAGE_ID}; a rival cluster seeded
 * opposite it carries this. Only the rival starter uses it — a world may grow more
 * villages with further ids.
 */
export const RIVAL_VILLAGE_ID = 'village_1';

/** Fields common to every entity. */
export interface BaseEntity {
  /** Stable unique id, e.g. "villager_1" or "tree_42". */
  id: string;
  type: EntityType;
  /** Current position in grid coordinates. May be fractional for smooth motion. */
  position: Vec2;
  /**
   * Which village OWNS this entity (v3 rival-village seam, design §10). A villager,
   * building or cart belongs to exactly one village; neutral terrain (trees) leaves
   * it unset. Optional and defaulting to {@link DEFAULT_VILLAGE_ID}, so a single-village
   * world — and every old save that predates the field — behaves exactly as before.
   * It only starts to matter once a second village exists and effects begin to enforce
   * ownership (raids, territory claims, fog-of-war digests).
   */
  villageId?: string;
}

/** A static, immovable object. Sent once at connect time, never per-tick. */
export interface Tree extends BaseEntity {
  type: 'tree';
}

/**
 * The flavours of building that make a settlement read as a village. The economy
 * is two short parallel chains (survival + craft) plus leisure and civic places:
 *  - `water_source`  — an inexhaustible spring; villagers draw water freely.
 *  - `greenfield`    — a farm that converts stocked water into food.
 *  - `lumber_source` — an inexhaustible grove; villagers gather wood freely.
 *  - `workshop`      — a forge/workshop that converts stocked wood into goods.
 *  - `hall_town`     — the town hall; stores food and water for everyone.
 *  - `tavern`        — the inn; stocks goods that villagers enjoy to relieve boredom.
 *  - `temple`        — where villagers pray, petitioning the God Agent.
 *  - `house`         — a home where villagers rest (relieves fatigue).
 */
export type BuildingKind =
  | 'water_source'
  | 'greenfield'
  | 'lumber_source'
  | 'workshop'
  | 'hall_town'
  | 'tavern'
  | 'temple'
  | 'house'
  // The construction & adornment kinds. `quarry` is an inexhaustible stone source;
  // a `construction_site` is a half-built structure villagers haul materials to
  // until it becomes its target kind; a `monument` (statue) and a `lamp` are
  // villager-raised adornments that beautify their surroundings (passive boredom
  // relief in a radius). See {@link BUILDABLES} for what villagers can raise.
  | 'quarry'
  | 'construction_site'
  | 'monument'
  | 'lamp'
  // A `landmark` is a villager-INVENTED structure — anything the village dreams up
  // beyond the fixed catalog (a market, a wall, a meeting house, a shrine). It has no
  // resource economy; its `function` carries the villagers' own description of what it
  // is, and it lifts spirits in a radius like a monument (the payoff for raising one).
  // This is what lets the settlement grow in ways the catalog never anticipated.
  | 'landmark'
  // A `depot` is the village's TECHNICAL STATION: the control house for the robot-carts.
  // It has no resource economy, but a villager standing at it can set the standing order
  // of ANY cart in the village (no need to walk out to each one), so the whole haulage
  // fleet is driven from one place. See `command_cart` and {@link BUILDABLES.depot}.
  | 'depot'
  // ---- FORTIFICATIONS (v3 rival war) — placed by a village's god, never by the world
  // generator. They carry `life` and turn raids into a real contest. See
  // `shared/fortifications.ts` for their mechanics, life pools and combat constants.
  //  - `wall`       — a 1×1 IMPASSABLE segment; a line of them rings the settlement so
  //                   raiders must route the long way to a `gate`. Destructible (siege).
  //  - `gate`       — a passable opening in a wall; own folk pass freely, a rival only
  //                   if no defender is holding it. The one weak point in the ring.
  //  - `watchtower` — extends the village's raid-detection reach: raids are spotted early.
  //  - `barracks`   — musters defenders; a villager on a `guard` order posted near one
  //                   (or at a gate) repels raiders rather than merely standing about.
  //  - `war_camp`   — offensive muster: raiders staged near it strike harder and faster.
  //  - `siege_ram`  — escorted against a rival `wall`, it batters the wall's life down
  //                   fast, opening a breach where there was no gate.
  | 'wall'
  | 'gate'
  | 'watchtower'
  | 'barracks'
  | 'war_camp'
  | 'siege_ram';

/**
 * What a god may conjure into the world with `spawn_entity` — a lone `villager`
 * newcomer, a `tree` to reshape terrain, or any FORTIFICATION building kind (a
 * `wall` line, a `gate`, a `watchtower`, …). Kept as its own union so the spawn
 * plumbing (god tool → event → engine) widens in exactly one place.
 */
export type SpawnableType =
  | 'villager'
  | 'tree'
  | 'wall'
  | 'gate'
  | 'watchtower'
  | 'barracks'
  | 'war_camp'
  | 'siege_ram';

/**
 * The structures villagers can choose to RAISE together, named by a friendly id
 * the build tool exposes (kept separate from {@link BuildingKind} so the internal
 * `construction_site` / `quarry` kinds are never offered as buildable). Each id maps
 * to a finished {@link BuildingKind}, a material cost, and a footprint — see the
 * `BUILDABLES` registry in `shared/buildings.ts`.
 */
export type BuildableId =
  | 'house'
  | 'well'
  | 'statue'
  | 'lamp'
  | 'depot'
  | 'handcart'
  | 'freight'
  | 'custom';

/** Every buildable id, as a runtime list — the closed vocabulary of what can be raised. */
export const BUILDABLE_IDS: readonly BuildableId[] = [
  'house',
  'well',
  'statue',
  'lamp',
  'depot',
  'handcart',
  'freight',
  // `custom` is the open-ended one: the villagers invent a structure of their own and
  // describe it. It finishes into a generic `landmark` (see {@link BUILDABLES}).
  'custom',
];

/** Runtime guard: is `value` one of the known {@link BuildableId}s? */
export function isBuildableId(value: unknown): value is BuildableId {
  return typeof value === 'string' && (BUILDABLE_IDS as readonly string[]).includes(value);
}

/**
 * The grades of {@link Cart} a villager can raise. A `handcart` is small and cheap;
 * a `freight` cart hauls far more for a far steeper cost. Kept separate from
 * {@link BuildableId} so the two cart buildables can map cleanly onto a tier whose
 * stats (capacity, speed, colour) live in `CART_SPECS` (`shared/buildings.ts`).
 */
export type CartTier = 'handcart' | 'freight';

/** Every cart tier, as a runtime list. */
export const CART_TIERS: readonly CartTier[] = ['handcart', 'freight'];

/** Runtime guard: is `value` one of the known {@link CartTier}s? */
export function isCartTier(value: unknown): value is CartTier {
  return typeof value === 'string' && (CART_TIERS as readonly string[]).includes(value);
}

/**
 * What a {@link Cart} is doing right now, for status display and perception.
 *  - `idle`     — no order; parked.
 *  - `toSource` — driving to the pickup building to load.
 *  - `toDest`   — driving to the drop-off building to unload.
 *  - `waiting`  — arrived but blocked (source empty while empty, or dest full while
 *                 loaded); retried every tick until it can move resources again.
 */
export type CartPhase = 'idle' | 'toSource' | 'toDest' | 'waiting';

/**
 * A cart's standing order: the single take→deposit loop it runs on its own. It
 * loads `resource` at `fromBuildingId` (up to its capacity), drives to
 * `toBuildingId`, unloads, and repeats. Replaced wholesale by `command_cart`.
 */
export interface CartOrder {
  /** Building id the cart loads the resource FROM. */
  fromBuildingId: string;
  /** Building id the cart unloads the resource TO. */
  toBuildingId: string;
  /** The single resource kind this order hauls. */
  resource: ResourceKind;
}

/**
 * The live progress of a {@link Building} that is still a construction site. Carries
 * what the site will BECOME, the name it will take, and the materials it still
 * needs versus what has been hauled in so far. The site's mutable `stock` holds the
 * contributed materials; `required` is the static goal. Cleared (undefined) the
 * moment the site is completed and the building takes on its target kind.
 */
export interface ConstructionState {
  /**
   * What this site becomes once fully built, when it raises a fixed BUILDING.
   * Mutually exclusive with {@link targetCartTier}: exactly one is set, matching
   * whether the proposed {@link Buildable} carries a `kind` or a `producesCart`.
   */
  targetKind?: BuildingKind;
  /**
   * The cart tier this site spawns once built, when it raises a mobile CART instead
   * of a building. When set, completion removes the site and spawns a {@link Cart}
   * rather than mutating the site into a building. See {@link targetKind}.
   */
  targetCartTier?: CartTier;
  /** The buildable id that was proposed (for UI labels / icons). */
  buildable: BuildableId;
  /** The name the finished building (or cart) will carry, chosen by the proposer. */
  targetName: string;
  /**
   * For an INVENTED structure (`buildable: 'custom'`): the villagers' own description
   * of what it is, which becomes the finished `landmark`'s `function`. Absent for
   * catalog builds, whose function comes from {@link BUILDING_FUNCTIONS} by kind.
   */
  description?: string;
  /** Materials required to complete it, by resource kind. */
  required: Partial<Record<ResourceKind, number>>;
}

/**
 * A static, multi-tile structure — the bones of the village. Like trees it is
 * sent once at connect time and never per-tick, but it occupies a rectangular
 * footprint (`width` x `height` tiles, anchored at `position` as the top-left
 * corner) and carries a human name the villagers and UI can refer to.
 */
export interface Building extends BaseEntity {
  type: 'building';
  kind: BuildingKind;
  /** Human label, e.g. "The Rolling Pin Bakery". */
  name: string;
  /**
   * What the place is FOR, in one human-readable line, e.g. "where bread is
   * baked and sold". Distinct from `kind` (the category): the function is what
   * villagers reason about and what the map tool reports so a mind knows why it
   * would go there.
   */
  function: string;
  /** Footprint width in tiles. */
  width: number;
  /** Footprint height in tiles. */
  height: number;
  /** Render color (any CSS color string). */
  color: string;
  /**
   * Live resource stock, by kind. A service is only rendered while the resource
   * it consumes is > 0; villagers replenish it by working/hauling here. Buildings
   * with no resource economy (a house, the temple) carry an empty record. The static
   * fields above ride `world.init`; this MUTABLE stock is streamed per-tick (see
   * {@link BuildingStock}) so observers and minds always see the current level.
   */
  stock: Partial<Record<ResourceKind, number>>;
  /** Maximum units of each resource this building can hold. */
  capacity: number;
  /**
   * Present ONLY while this building is a `construction_site`: the project's target
   * and the materials it still needs. The site's `stock` holds the materials hauled
   * in so far; when each `required` kind is met the engine transforms the building
   * into {@link ConstructionState.targetKind} and clears this field. Absent on every
   * finished building. Like the other static fields it rides `world.init` (and is
   * re-announced when a site opens or completes); only `stock` streams per-tick.
   */
  construction?: ConstructionState;
  /**
   * STRUCTURAL HEALTH — how much battering the building can still take before it is
   * razed (v3 rival war). Every building has a pool sized by its kind (walls are
   * tough, a gate weaker; ordinary buildings sit at a high default and are rarely
   * touched). Raiders and siege rams whittle it down; at 0 a wall/gate is BREACHED
   * and removed, opening the ring. Streamed per-tick (with `stock`) so damage shows
   * live. Optional for back-compat: old saves omit it and the engine backfills the
   * kind's max. See `shared/fortifications.ts` `BUILDING_MAX_LIFE`.
   */
  life?: number;
  /** The building's full health pool — the cap `life` is restored toward / clamped to. */
  maxLife?: number;
  /**
   * GATE state: whether the opening stands open (passable to rivals) or is being
   * actively HELD by a defender (rivals blocked). Engine-derived each tick from
   * whether a friendly guard is posted within reach; streamed so the client can draw
   * the gate open vs barred. Meaningful only on `kind === 'gate'`.
   */
  open?: boolean;
  /**
   * SIEGE progress against this building, 0..1 — how close a besieging ram/raiders
   * are to breaching it. Drives the client's breach-progress bar. Meaningful only on
   * a wall/gate currently under siege; absent otherwise.
   */
  siegeProgress?: number;
}

/**
 * A building's live, mutable stock — the only part of a {@link Building} that
 * changes during play. Buildings themselves are sent once in `world.init`
 * (static footprint + name); their stock drifts every tick as villagers use and
 * refill them, so it rides the lightweight per-tick update instead, keyed by id.
 */
export interface BuildingStock {
  id: string;
  stock: Partial<Record<ResourceKind, number>>;
  /** Current structural health, when it differs from full — drives the damage bar (v3 war). */
  life?: number;
  /** Gate hold state: true when standing open to rivals, false when a defender bars it. */
  open?: boolean;
  /** Siege progress 0..1 against this building, when under siege — drives the breach bar. */
  siegeProgress?: number;
}

/** The kinds of thing that can happen to a building, recorded in its activity log. */
export type BuildingEventKind =
  | 'take' // a villager drew a resource out
  | 'give' // a villager dropped a resource in
  | 'work_started' // a villager began working the building (e.g. farming)
  | 'work_finished' // the work session ended (carries a conversion summary)
  | 'work_refused' // work was attempted but the building had nothing to work
  | 'depleted' // a stocked resource hit zero
  | 'filled' // a stocked resource reached capacity
  | 'site_opened' // a construction site was raised (the project began)
  | 'completed'; // a construction site gathered all its materials and became its building

/**
 * One entry in a building's ACTIVITY LOG — something that happened to it. The log
 * is a rolling window of the last few simulated hours, surfaced in the UI's
 * building inspector AND fed into a nearby villager's prompt so minds can reason
 * over what has recently been done at a place (and avoid redundant hauling).
 */
export interface BuildingEvent {
  buildingId: string;
  buildingName: string;
  /** Clock (round) tick the event happened on — the sim-time stamp and prune basis. */
  tick: number;
  /** Wall-clock time recorded, ISO-8601 on the wire. */
  at: string;
  kind: BuildingEventKind;
  /** The villager involved, when any (take/give/work). */
  actorId?: string;
  actorName?: string;
  /** The resource and amount moved, when the event is about stock. */
  resource?: ResourceKind;
  amount?: number;
  /** Free-text colour, e.g. "no water to convert" or "farmed 6 water → 3 food". */
  note?: string;
}

/**
 * A villager's needs. Each is a 0..100 pressure where HIGHER = more pressing:
 * they creep up over time and are relieved by consuming the matching resource
 * (water for thirst, food for hunger — from the backpack or Hall Town; goods for
 * boredom — at the tavern) or, for fatigue, by resting at a house. Kept as plain
 * numbers so the UI can draw them as bars without any extra mapping.
 */
export interface VillagerNeeds {
  /** Hunger — rises over time, relieved by eating. 100 = starving. */
  hunger: number;
  /** Thirst — rises over time, relieved by drinking. 100 = parched. */
  thirst: number;
  /** Fatigue — rises while active, relieved by resting. 100 = exhausted. */
  fatigue: number;
  /**
   * Boredom — rises over time, relieved by recreation: enjoying goods at the
   * tavern, and (a little) by being among company. 100 = restless and dull.
   */
  boredom: number;
}

/** How many items a villager may carry at once. */
export const BACKPACK_CAPACITY = 5;

// ---------------------------------------------------------------------------
// v3 — supervisor POLICY + WORLD DIGEST (design §5)
// ---------------------------------------------------------------------------

/**
 * The standing strategic levers the v3 supervisor sets to steer the whole village
 * (design §5.2). Each is a 0..1 weight folded into every villager's utility scores,
 * biasing the discretionary work the village chooses (grow food, gather, build, …)
 * without ever overriding self-preservation. The supervisor changes these slowly;
 * villagers' own needs still drive the moment-to-moment loop.
 */
export type Priority =
  | 'food'
  | 'water'
  | 'rest'
  | 'recreation'
  | 'build'
  | 'gather'
  | 'defense'
  | 'expand';

/** Every priority, as a runtime list — the closed vocabulary the supervisor sets weights over. */
export const PRIORITIES: readonly Priority[] = [
  'food',
  'water',
  'rest',
  'recreation',
  'build',
  'gather',
  'defense',
  'expand',
];

/**
 * The village's standing POLICY: the supervisor's priority weights plus the reasoning
 * behind them. Broadcast to every villager (where the utility brain reads it), shown in
 * the UI, and persisted so it survives a reboot. Empty weights ⇒ the village runs neutral.
 */
export interface VillagePolicy {
  /** 0..1 per priority; absent priorities fall back to a neutral baseline in the brain. */
  weights: Partial<Record<Priority, number>>;
  /** Why the supervisor set this policy — surfaced in the UI / chronicle. */
  rationale?: string;
  /** The in-world day the policy was set (for telemetry + persistence). */
  day?: number;
  /**
   * Which village this policy governs (v3 rival-village seam). Set when broadcast so a
   * villager applies only its OWN supervisor's policy; absent ⇒ the single-village default
   * ({@link DEFAULT_VILLAGE_ID}), which every villager accepts.
   */
  villageId?: string;
}

/** An aggregate of one need across the village: its average and its worst (max) value. */
export interface NeedStat {
  avg: number;
  max: number;
}

/**
 * What ONE supervisor can observe of a RIVAL village (v3 rival-village seam, design
 * §10) — deliberately PARTIAL: fog-of-war. A supervisor sees the rival's rough size
 * and visible activity, never its exact stocks or per-villager needs. Folded into the
 * world digest only once a second village exists; absent in a single-village world, so
 * a lone village's prompt is unchanged.
 */
export interface RivalDigest {
  /** The rival village's id. */
  villageId: string;
  /** Rough headcount of the rival — an estimate, not a census. */
  population: number;
  /** How many structures the rival is seen to hold. */
  buildings: number;
  /**
   * Roughly WHERE the rival settlement lies (the centroid of its visible folk). Fog-of-war
   * still — you can see the smoke of their square, not their books — but enough for a god to
   * point a raiding party at it via an `issue_order` raid. Absent if none are in view.
   */
  center?: Vec2;
  /** A one-line read on what the rival seems to be up to, for the prompt + chronicle. */
  activity: string;
}

/**
 * The compact, AGGREGATED snapshot the supervisor reasons over to set policy (design
 * §5.1) — never raw per-villager state. Assembled by the engine's daily aggregator and
 * carried on the daily summary. Grows with the rival digest + vision in later phases.
 */
export interface WorldDigestVitals {
  /** Average + worst of each physical need across all villagers. */
  needs: Record<keyof VillagerNeeds, NeedStat>;
  /** Total units of each resource held across every building's stock. */
  stocks: Partial<Record<ResourceKind, number>>;
  /** Per building-kind: how many exist, and how many are running low on stock. */
  buildings: { kind: string; count: number; lowStock: number }[];
  /**
   * What this village can observe of a RIVAL (fog-of-war, design §10). Present only
   * once a second village exists; absent — and unread — in a single-village world.
   */
  rival?: RivalDigest;
}

// ---------------------------------------------------------------------------
// v3 P4 — WORLD EVENTS (design §9.2). The engine, not just the LLM, can fire
// salient happenings — a famine setting in, a store run dry, a newcomer, a
// surplus — so the supervisor faces a CHANGING, contested world instead of a flat
// daily readout. These are the anti-repetition "variety engine": legible signals
// the god reacts to. They ride the daily digest as colour, and a high-salience one
// INTERRUPTS the god's daily cadence (design §8) for an out-of-turn deliberation.
// ---------------------------------------------------------------------------

/** What kind of world happening a {@link DigestEvent} reports. */
export type DigestEventKind =
  // A need has turned dire across the village (famine = hunger, drought = thirst, …).
  | 'famine'
  // A whole resource store has run dry (food/water/wood/goods hit zero).
  | 'shortage'
  // A resource has piled up well past what the village needs — plenty to spend.
  | 'surplus'
  // A new villager has appeared (spawned or wandered in).
  | 'newcomer'
  // A structure was finished — a concrete step toward a city.
  | 'build_complete'
  // The village has gone listless — many villagers idle, little happening.
  | 'stagnation'
  // A rival villager took resources from one of this village's buildings (v3 P5 soft
  // competition, design §10) — a raid the god should answer (raise defense, post guards).
  | 'raid';

/** How loudly an event should be heard. A `crisis` interrupts the god's daily cadence. */
export type DigestEventSalience = 'info' | 'warning' | 'crisis';

/** Every event kind, as a runtime list (for validation / iteration). */
export const DIGEST_EVENT_KINDS: readonly DigestEventKind[] = [
  'famine',
  'shortage',
  'surplus',
  'newcomer',
  'build_complete',
  'stagnation',
  'raid',
];

/** One salient world happening the engine detected, for the supervisor to weigh. */
export interface DigestEvent {
  kind: DigestEventKind;
  salience: DigestEventSalience;
  /** A short human line for the prompt + logs, e.g. "Hunger has turned dire (avg 78)." */
  text: string;
  /** The sim day the event fired on. */
  day: number;
  /** The sim tick the event fired on. */
  tick: number;
  /**
   * Which village this happening is ABOUT (v3 rival-village seam). Lets an alert wake
   * only that village's supervisor. Optional + defaulting to {@link DEFAULT_VILLAGE_ID}
   * so a single-village world is unchanged.
   */
  villageId?: string;
}

// ---------------------------------------------------------------------------
// v3 — supervisor ORDERS (design §5.2). The targeted, expiring override lever:
// the policy steers ~90% of behaviour; an order pushes specific villagers at a
// specific task for a while. Orders are SOFT — a villager obeys via a large
// utility bonus but still self-preserves (won't ignore starvation) — and EXPIRE
// (`ttlTicks`), after which the village relaxes back to the standing policy.
// ---------------------------------------------------------------------------

/**
 * The kind of task an order directs villagers to do (maps onto utility-brain behaviours).
 * `raid` (v3 P5) sends villagers across to a rival's territory to seize its stores.
 */
export type OrderTask = 'build' | 'gather' | 'haul' | 'guard' | 'move' | 'work' | 'socialize' | 'raid';

/** Every order task, as a runtime list — the closed vocabulary for `issue_order`. */
export const ORDER_TASKS: readonly OrderTask[] = [
  'build',
  'gather',
  'haul',
  'guard',
  'move',
  'work',
  'socialize',
  'raid',
];

/** WHO an order is aimed at. Empty ⇒ the whole village. */
export interface OrderTarget {
  /** Specific villager ids. */
  villagerIds?: string[];
  /** A role/trait keyword (matched against a villager's traits), e.g. "builder". */
  role?: string;
  /** Advisory cap on how many should obey (not strictly enforced in P3). */
  count?: number;
}

/** The specifics of an order — which place, which resource, where. */
export interface OrderParams {
  buildingId?: string;
  resource?: ResourceKind;
  x?: number;
  y?: number;
}

/** A single standing order the supervisor (or a human) pushes at the village. */
export interface VillageOrder {
  /** Stable id (the issuing bus eventId), so a later order can replace it. */
  id: string;
  target: OrderTarget;
  task: OrderTask;
  params: OrderParams;
  /** Expires this many in-world ticks after a villager receives it; absent ⇒ until replaced. */
  ttlTicks?: number;
  /** Why it was issued — surfaced in the UI / chronicle. */
  rationale?: string;
  /**
   * Which village this order is for (v3 rival-village seam). Set when broadcast so only
   * that village's villagers obey it; absent ⇒ the single-village default
   * ({@link DEFAULT_VILLAGE_ID}).
   */
  villageId?: string;
}

/**
 * A job a villager has taken on that spans several ticks. Today the only kind is
 * `refill`: keep a building's stock topped up by working at it. The engine drives
 * the task — walking the villager to the building and replenishing it over time —
 * and clears it when the place is full, the villager is sent elsewhere, or the
 * target vanishes. Carried on the villager so the UI can show what each is busy
 * doing beyond the moment-to-moment status line.
 */
export interface VillagerTask {
  /** The kind of job. Only `refill` for now; extend as more chores appear. */
  kind: 'refill';
  /** The building this task concerns. */
  buildingId: string;
  /** Human label for the job, e.g. "Refilling the Village Well". */
  label: string;
}

/** A mobile villager. Walks toward `target` one step (`speed`) per tick. */
export interface Villager extends BaseEntity {
  type: 'villager';
  /** Human display name, e.g. "Bram the Baker". Falls back to the id if unknown. */
  name: string;
  /** Destination the villager is walking toward, or null when idle. */
  target: Vec2 | null;
  /** Render color (any CSS color string). Mirrors {@link appearance}.bodyColor. */
  color: string;
  /**
   * The villager's procedural LOOK — a small set of parts (body shape, outfit
   * colour, hair, hat, held tool) the client layers into a distinct little
   * figure so no two villagers render alike. Generated with the persona on an
   * LLM world build; otherwise a deterministic look derived from the id. Optional
   * for back-compat: old saves omit it and the client derives one on the fly.
   */
  appearance?: VillagerAppearance;
  /** Movement speed in grid cells per tick. */
  speed: number;
  /**
   * One human-readable line describing what the villager is doing right now,
   * e.g. "Idle", "Walking to (250, 248)", or "Drinking at the Village Well".
   * Derived by the engine each tick from movement and surroundings.
   */
  status: string;
  /** The villager's physical needs (hunger / thirst / fatigue). */
  needs: VillagerNeeds;
  /**
   * Resources the villager is carrying — one array entry per UNIT, each a
   * {@link ResourceKind} string (e.g. `["food", "food", "water"]`). The backpack
   * holds simulation resources only (no flavour items); villagers fill and empty
   * it at buildings via the `take_from` / `give_to` tools to HAUL resources from a
   * producer to where they are needed. Never longer than {@link BACKPACK_CAPACITY}.
   */
  backpack: string[];
  /**
   * The multi-tick job this villager is busy with (e.g. refilling a building),
   * or null when free. Set by the engine in response to a villager's `work_at`
   * intent and cleared when the job is done or abandoned. See {@link VillagerTask}.
   */
  task: VillagerTask | null;
  /**
   * Whether the villager is ASLEEP — out of power and recovering. A villager
   * collapses into sleep when its fatigue maxes out (no power left), drops where
   * it stands, and its mind goes dark: the turn coordinator grants it no LLM turns
   * while asleep, so it neither thinks nor acts until it wakes (~7 in-world hours
   * later) with its power restored. The engine owns this flag and the wake timer.
   */
  asleep: boolean;
  /**
   * LIFE — the villager's health, 0..{@link maxLife} (v3 rival war). Whole while at
   * peace; combat at a contested gate or raid drains it. There is NO permanent death:
   * a villager whose life hits 0 is DOWNED (see {@link downed}) — it breaks off, flees
   * home, and its life regenerates until it can rejoin. Out of combat, life mends
   * slowly on its own. Optional for back-compat; the engine backfills full health on
   * a save that predates it. See `shared/fortifications.ts`. Optional so hand-written
   * seeds and pre-war saves need not carry it — the engine backfills full health on load.
   */
  life?: number;
  /** The villager's full health pool — the cap `life` mends toward and is clamped to. */
  maxLife?: number;
  /**
   * DOWNED — true while a villager has been beaten to 0 life and is retreating home to
   * recover. A downed villager drops its errand and its mind goes quiet (like
   * {@link asleep}): the coordinator grants it no LLM turns, it cannot fight, raid or
   * be hit again, and it heads for the nearest friendly house, rejoining once its life
   * has mended past the recovery mark. The engine owns this flag.
   */
  downed?: boolean;
  /**
   * The id of the HOUSE this villager owns and sleeps in (v3 housing). Every villager
   * is given its OWN home: it turns in there to shed fatigue, and downed it limps there
   * to recover. The engine assigns it — matching free houses to villagers who lack one
   * when a house is raised, when a newcomer arrives, and once on load — so the village
   * builds a new house only while someone is still homeless. Optional for back-compat:
   * old saves omit it and the engine backfills an assignment from the existing houses.
   */
  homeId?: string;
}

/**
 * A ROBOT-CART: a mobile hauler a villager raises from resources, then commands
 * once to run a single take→deposit loop between two buildings on its own. Like a
 * villager it walks toward `target` at `speed` per tick and is streamed per-tick
 * (not in `world.init`), but it has no needs or mind — it just executes its
 * {@link order}. A villager standing beside it can set or replace the order with
 * the `command_cart` tool. Its stats (capacity, speed, colour) come from its
 * {@link tier} via `CART_SPECS` (`shared/buildings.ts`).
 */
export interface Cart extends BaseEntity {
  type: 'cart';
  /** Human display name, e.g. "Handcart 1" — shown in perception and on the map. */
  name: string;
  /** Which grade of cart this is; sets its capacity, speed, and colour. */
  tier: CartTier;
  /** Footprint width in tiles (so `rectDistance` treats it like a building). */
  width: number;
  /** Footprint height in tiles. */
  height: number;
  /** Destination the cart is driving toward, or null when parked. */
  target: Vec2 | null;
  /** Render color (from the tier). */
  color: string;
  /** Movement speed in grid cells per tick (fast — 10). */
  speed: number;
  /** Maximum units of cargo this cart can carry in one trip. */
  capacity: number;
  /**
   * Cargo currently aboard — one array entry per UNIT, each a {@link ResourceKind}
   * string, exactly like {@link Villager.backpack} (so the same load/unload helpers
   * serve both). Homogeneous: only ever the current order's resource. Never longer
   * than {@link capacity}.
   */
  cargo: string[];
  /** The standing take→deposit loop, or null when the cart has no order yet. */
  order: CartOrder | null;
  /** What the cart is doing right now (drives status + perception). */
  phase: CartPhase;
  /** When `phase` is `waiting`, why — e.g. "source has no water", "destination is full". */
  waitReason: string | null;
  /** Id of the villager that set the current order, or null. Provenance only. */
  lastCommandedBy: string | null;
}

/** Discriminated union of all entities. Narrow on `.type`. */
export type Entity = Tree | Villager | Building | Cart;

/**
 * A GATHERING: three or more villagers standing close enough together to form a
 * social cluster. Derived spatially by the engine every tick (connected groups
 * within a few tiles of one another), and carried in the world snapshot so the
 * browser can draw it and each mind knows it is in company. The `id` is stable
 * while the same set of members keeps standing together, so observers can tell a
 * continuing gathering from a brand-new one.
 */
export interface Gathering {
  /** Stable id derived from the sorted member ids. */
  id: string;
  /** The villager ids taking part, sorted. Always length >= 3. */
  memberIds: string[];
  /** Centroid of the members, for placing a label / hull on the map. */
  center: Vec2;
  /** The nearest notable place they're gathered at (building name), or null in the open. */
  place: string | null;
}

/**
 * What ONE villager thinks of ANOTHER — the evolving social tie that lets
 * memories and reasoning change how neighbours regard each other. Each villager
 * keeps a small book of these (one per person it has come to know); they are
 * revised during the nightly reflection, when the mind looks back over the day's
 * shared moments and asks "what do I now make of this person?".
 */
export interface Relationship {
  /** The other villager this opinion is about. */
  otherId: string;
  /** Their display name at the time of the last update. */
  otherName: string;
  /**
   * How warmly this villager regards the other, -100 (enmity) … 0 (neutral) …
   * 100 (a deep bond). Nudged up or down each reflection by what passed between
   * them that day, and clamped to the range.
   */
  affinity: number;
  /** One evolving, first-person line, e.g. "a tireless worker, if short with me". */
  opinion: string;
  /** The simulation tick the opinion was last revised on. */
  lastTick: number;
}

/**
 * Pushed when a villager's view of its neighbours is revised (after a nightly
 * reflection), so the browser's relationships view updates live. Carries that
 * villager's whole social book each time (it stays small), keyed by villager id.
 */
export interface RelationshipUpdateMessage {
  kind: 'relationship.updated';
  villagerId: string;
  villagerName: string;
  relationships: Relationship[];
}

/**
 * One villager's COMMITMENT to a shared group plan: who they are and the role
 * they took on ("draw water for the farm"). A {@link GroupPlan} is the sum of
 * these — a gathering turning talk into a coordinated division of labour.
 */
export interface GroupPlanMember {
  villagerId: string;
  villagerName: string;
  /** The part this villager took on, in their own words. */
  role: string;
}

/**
 * A SHARED PLAN a gathering agreed on: one villager proposes a common goal and
 * others commit to roles, so a cluster of neighbours does coordinated work
 * (or convenes a prayer) instead of milling about repeating greetings. Held
 * loosely — it guides the members' prompts and is shown in the UI, but the
 * engine never forces anyone to follow it.
 */
export interface GroupPlan {
  /** Stable id for this plan (the proposer + tick it was opened). */
  id: string;
  /** The villager who proposed it. */
  proposerId: string;
  proposerName: string;
  /** The shared aim in one line, e.g. "keep the forge fed and Hall Town stocked". */
  goal: string;
  /** A short kind tag for the UI / ritual handling: 'work' | 'prayer' | 'social' | 'build'. */
  kind: 'work' | 'prayer' | 'social' | 'build';
  /** Everyone who has committed to a role so far (the proposer included). */
  members: GroupPlanMember[];
  /** Sim tick the plan was opened. */
  startTick: number;
  /** Sim tick of the latest change (a new member, a role). */
  lastTick: number;
}

/** Pushed when a group plan is opened or joined, so the UI's agenda panel updates live. */
export interface GroupPlanMessage {
  kind: 'group_plan.updated';
  plan: GroupPlan;
}

// ---------------------------------------------------------------------------
// AGENDA — each villager's personal book of intentions and scheduled happenings
// ---------------------------------------------------------------------------

/**
 * One villager committed to attend an {@link AgendaEvent}, or invited to it: their
 * id and display name. The organizer is always a participant; everyone gathered with
 * them when the event was proposed starts as an invitee until they accept.
 */
export interface AgendaParticipant {
  villagerId: string;
  villagerName: string;
}

/**
 * An untimed AGENDA NOTE: a reminder or intention a villager jots for itself, with no
 * fixed time ("mend the fence", "thank Mara for the bread"). Private to its owner.
 * Surfaced in the owner's prompt and shown under them in the UI; auto-expires after a
 * couple of in-world days so the list stays a window onto current intentions.
 */
export interface AgendaNote {
  type: 'note';
  /** Stable unique id (owner + tick + counter). */
  id: string;
  /** The villager whose agenda this sits on. */
  ownerId: string;
  ownerName: string;
  /** The note itself, in the villager's own voice. */
  title: string;
  /** Sim tick the note was jotted. */
  createdTick: number;
}

/**
 * A scheduled AGENDA EVENT: a happening fixed to an in-world day + part of day, and
 * optionally a place. May be PERSONAL (one villager's own plan, `shared: false`) or
 * SHARED (proposed to a gathering, `shared: true`) — a shared event carries its
 * organizer, the neighbours who have accepted (`participants`), and those still
 * invited (`invited`). The same event object is the single source of truth for every
 * attendee; each villager's agenda is the events they organise, attend, or are
 * invited to. Auto-expires once its time has comfortably passed.
 */
export interface AgendaEvent {
  type: 'event';
  /** Stable unique id (organizer + tick + counter). */
  id: string;
  /** What the event is, in the organizer's own voice ("share a meal at the Inn"). */
  title: string;
  /** The villager who set or proposed it. */
  organizerId: string;
  organizerName: string;
  /** The resolved target round tick the event is set for (drives sorting + steering). */
  scheduledTick: number;
  /** In-world day (1-based) it falls on — for display and to re-derive the time. */
  day: number;
  /** The part of day it happens in. */
  partOfDay: AgendaPartOfDay;
  /** The building it happens at (its id), if anywhere in particular. */
  placeId?: string;
  /** The building's display name, resolved by the coordinator from `placeId`. */
  placeName?: string;
  /** True for a proposed, multi-villager event; false for a personal one. */
  shared: boolean;
  /** Everyone committed to attend (the organizer always included). */
  participants: AgendaParticipant[];
  /** Neighbours invited (gathered with the organizer when proposed) who haven't accepted. */
  invited: AgendaParticipant[];
  /** Sim tick the event was created. */
  createdTick: number;
}

/** One entry on a villager's agenda — an untimed note or a scheduled event. Narrow on `.type`. */
export type AgendaItem = AgendaNote | AgendaEvent;

/** Pushed when an agenda item is created or changed (a new note/event, an acceptance). */
export interface AgendaUpdateMessage {
  kind: 'agenda.updated';
  item: AgendaItem;
}

/** Pushed when an agenda item is dropped (an event whose time has passed, or a stale note). */
export interface AgendaRemovedMessage {
  kind: 'agenda.removed';
  itemId: string;
}

/**
 * The colours the ground is painted with — themed per village so a farming valley
 * reads green, a desert oasis sandy, a volcanic crater dark. All plain CSS colour
 * strings. `ground` is the base fill of the world; `groundAccent` is a second tone
 * blotched over it for subtle texture; `vegetation` colours the trees/plants.
 */
export interface TerrainPalette {
  /** Base ground fill within the world bounds. */
  ground: string;
  /** A second ground tone, blotched over the base for texture (e.g. darker grass). */
  groundAccent: string;
  /** Tree / vegetation colour. */
  vegetation: string;
}

/** The default (temperate farming-valley) palette: green grass, leafy trees. */
export const DEFAULT_TERRAIN_PALETTE: TerrainPalette = {
  ground: '#3f6b34',
  groundAccent: '#355a2b',
  vegetation: '#2ea043',
};

/** How big and dense a generated village is — sets map size, packing gap and tree cover. */
export type VillageSize = 'small' | 'medium' | 'large';

/**
 * A village's RAID STANCE in a two-village (rival) world — a soft, prompt-level
 * dial chosen at setup, fed into that side's god (supervisor) charter so it raids
 * more or less readily. Purely a nudge to the LLM; no engine mechanic changes.
 */
export type CompetitionIntensity = 'peaceful' | 'balanced' | 'aggressive';

/** The default raid stance when none is chosen — even-handed. */
export const DEFAULT_COMPETITION_INTENSITY: CompetitionIntensity = 'balanced';

/**
 * The setup parameters for ONE side of a two-village (rival) world, chosen
 * independently on the rival setup screen: its own style (which fully themes its
 * roster, building names and ground palette), villager count, size and raid stance.
 * All optional so a partial choice falls back to the backend's defaults.
 */
export interface VillageSetupParams {
  /** Free-text style that fully themes this side (names, roster, ground palette). */
  style?: string;
  /** Villager count for this side (slider); clamped to the backend ceiling. */
  villagers?: number;
  /** Village size/density for this side. */
  size?: VillageSize;
  /** This side's raid stance, fed to its god's charter (soft). */
  intensity?: CompetitionIntensity;
}

/**
 * The rival-mode setup block: a shared map/valley BACKDROP plus the two sides'
 * independent {@link VillageSetupParams}. `mapTheme` is a loose mood hint passed to
 * BOTH sides' generation (and drives the setup screen's live colour preview); each
 * side still themes itself fully, so the two grounds read apart on one map.
 */
export interface RivalSetupParams {
  /** Shared valley backdrop/mood hint; also what the live colour preview reflects. */
  mapTheme?: string;
  /** The home (west) settlement's parameters. */
  home: VillageSetupParams;
  /** The rival (east) settlement's parameters. */
  rival: VillageSetupParams;
}

/**
 * The complete, persistable description of a world. This is what the engine is
 * constructed from, what gets written to / read from MongoDB, and what a
 * snapshot looks like. Keeping it a plain data shape (no methods) makes it
 * trivially serializable for both the DB and the network.
 */
export interface WorldSeed {
  width: number;
  height: number;
  trees: Tree[];
  villagers: Villager[];
  /** Static structures that make the map a village. May be absent in old saves. */
  buildings: Building[];
  /** Mobile robot-carts, with their orders, so a restart resumes them. Absent in old saves. */
  carts?: Cart[];
  /**
   * The in-world CLOCK tick (turn-coordinator round) this snapshot was taken at,
   * so a restart RESUMES simulated time instead of starting over at Day 1. Written
   * into every live snapshot; absent in a freshly generated seed (treated as 0) and
   * in old saves predating the field.
   */
  clock?: number;
  /**
   * Live engine TRANSIENT state, carried in the snapshot so a restart resumes
   * exactly where it left off (weather no longer reverts to clear, sleepers stay
   * asleep, work sessions and status notices survive). All optional: a freshly
   * generated seed and old saves simply omit them and the engine starts clean.
   */
  weather?: WeatherKind;
  /** Sleepers' wake schedule (the engine-internal `sleepUntil` map, as an array). */
  sleepUntil?: { villagerId: string; from: number; until: number; fatigue0: number }[];
  /** In-flight work sessions (the engine-internal `workSession` map, as an array). */
  workSession?: { villagerId: string; inputUsed: number }[];
  /** Short-lived status notices (the engine-internal `notices` map, as an array). */
  notices?: { villagerId: string; text: string; untilTick: number }[];
  /** Monotonic counter for God-spawned entity ids, so resumed ids never collide. */
  spawnSeq?: number;
  /**
   * Optional FLAVOUR of an LLM-generated village (see the world generator). `theme`
   * is the short setting label the operator asked for or the model invented (e.g.
   * "a fishing hamlet on a cold coast"); `setting` is a sentence or two describing
   * it. Pure flavour — the mechanics are unchanged — surfaced to the browser so a
   * player can see what kind of village they're watching. Absent for the classic
   * hand-authored seed.
   */
  theme?: string;
  setting?: string;
  /**
   * The themed ground colours (see {@link TerrainPalette}). Set on every freshly
   * generated world (classic gets {@link DEFAULT_TERRAIN_PALETTE}); absent in old
   * saves, where the client falls back to the default.
   */
  palette?: TerrainPalette;
  /**
   * In a TWO-village (rival) world, the SECOND ground palette: `palette` paints the
   * map WEST of {@link paletteSplitX} (the home side) and this paints the EAST (the
   * rival side), so each settlement reads in its own terrain on one shared map.
   * Absent in single-village worlds, where `palette` covers the whole ground.
   */
  rivalPalette?: TerrainPalette;
  /**
   * The x tile-coordinate where the ground switches from {@link palette} (west) to
   * {@link rivalPalette} (east) — the territory midline of a two-village world.
   * Only meaningful alongside `rivalPalette`; absent in single-village worlds.
   */
  paletteSplitX?: number;
}

// ---------------------------------------------------------------------------
// Server -> Client messages
// ---------------------------------------------------------------------------

/**
 * Streamed while the backend is GENERATING a fresh village with the LLM (minutes),
 * so the browser can show a live loading overlay. Sent only during a true generation
 * (GENERATE_LLM=on); the final one carries `done: true`, just before `world.init`.
 */
export interface WorldGeneratingMessage {
  kind: 'world.generating';
  phase: 'map' | 'villagers' | 'bible' | 'assembling';
  label: string;
  step?: number;
  total?: number;
  done?: boolean;
}

/**
 * Sent when the backend has NO world yet and is waiting for the player to choose how
 * to create one (the first-run setup screen). Carries the defaults the form opens
 * with and whether LLM auto-generation is available at all (`canAuto`).
 */
export interface WorldNeedsSetupMessage {
  kind: 'world.needs_setup';
  /** Whether the LLM auto-generate option is offered (GENERATE_LLM on + engine reachable). */
  canAuto: boolean;
  /** Pre-fill for the style field (from GENERATE_THEME), if any. */
  defaultStyle: string;
  /** Slider ceiling for villager count. */
  maxVillagers: number;
  /** Slider initial value for villager count. */
  defaultVillagers: number;
  /** Initial size selection. */
  defaultSize: VillageSize;
  /**
   * Whether this is a TWO-village (rival) world (RIVAL_VILLAGE=on). When set, the
   * setup screen shows the rival layout: a shared map theme plus independent per-side
   * style / villager-count / size / raid-stance controls. Absent/false = single village.
   */
  rival?: boolean;
}

/**
 * The backend's answer to a {@link PreviewStyleCommand}: a quick read on a style's
 * theme label + ground colours, for the setup screen's live swatch. `requestId`
 * echoes the request so the UI can ignore stale (out-of-order) previews.
 */
export interface WorldStylePreviewMessage {
  kind: 'world.style_preview';
  requestId: number;
  theme: string;
  palette: TerrainPalette;
}

/**
 * Sent exactly once, immediately after a client connects. Carries the
 * everything-that-rarely-changes payload: grid dimensions, static terrain
 * (trees), and the tick rate so the client can interpolate/label time.
 */
export interface WorldInitMessage {
  kind: 'world.init';
  width: number;
  height: number;
  trees: Tree[];
  /** Static village structures, sent once like trees. */
  buildings: Building[];
  /** Ticks per second the engine is running at. */
  tickRate: number;
  /** Current village weather, so a connecting browser starts in sync. */
  weather: WeatherKind;
  /** Flavour of an LLM-generated village (theme label + a sentence). Absent for the classic seed. */
  theme?: string;
  setting?: string;
  /** Themed ground colours (see {@link TerrainPalette}); absent in old saves. */
  palette?: TerrainPalette;
  /** Second ground palette for the rival (east) side of a two-village world; see {@link WorldSeed.rivalPalette}. */
  rivalPalette?: TerrainPalette;
  /** Tile x where the ground switches from {@link palette} to {@link rivalPalette}; see {@link WorldSeed.paletteSplitX}. */
  paletteSplitX?: number;
}

/**
 * Broadcast every tick. Intentionally lightweight: only the moving villagers are
 * included (trees are static and already known from `world.init`).
 */
export interface WorldStateUpdate {
  kind: 'world.state_update';
  /** Monotonic tick counter since engine start. */
  tick: number;
  villagers: Villager[];
  /** Mobile robot-carts (position, cargo, order, phase), streamed per-tick like villagers. */
  carts: Cart[];
  /** Social clusters of 2+ nearby villagers, derived spatially each tick. */
  gatherings: Gathering[];
  /**
   * The live, mutable stock of every building that has a resource economy
   * (others are omitted). Lets observers and minds track depletion/refill without
   * re-sending the static building list each tick. See {@link BuildingStock}.
   */
  buildingStocks: BuildingStock[];
}

/** Broadcast whenever the God Agent changes the weather. */
export interface WorldWeatherMessage {
  kind: 'world.weather';
  weather: WeatherKind;
}

/**
 * Final Phase — "Inception". One villager's full thought process for a single
 * turn, streamed to the UI inspector: the memories RAG recalled, the exact
 * prompt sent to the model, its raw output, and the decision we acted on. This
 * is the browser-facing mirror of the `villager.telemetry.thought_process` bus
 * event; the gateway translates one into the other.
 */
export interface VillagerThoughtMessage {
  kind: 'villager.thought';
  villagerId: string;
  villagerName: string;
  tick: number;
  /** Logical simulation tick (turn-coordinator round) this think ran in, if any. */
  roundTick?: number;
  recalledMemories: { text: string; kind: string; score: number }[];
  prompt: { system: string; user: string };
  rawOutput: string;
  decision: AgentDecision | null;
  /** `'fallback'` when the decision was a scripted substitute, not LLM-authored. */
  decisionSource?: 'llm' | 'utility' | 'fallback';
  /**
   * The full agentic TRACE for this turn — every lookup, action, and the final
   * yield, in order. Present for minds that run the multi-step loop; absent for a
   * legacy single-decision turn. {@link decision} stays the representative committed
   * action so older consumers keep working.
   */
  steps?: AgentTraceStep[];
}

/**
 * The turn coordinator's per-round heartbeat, forwarded to the browser. Carries
 * the current logical tick (a round in which every eligible villager gets one LLM
 * window), who is acting, and who is on post-action cooldown. Drives the debug
 * window's current-tick readout.
 */
export interface SimTickMessage {
  kind: 'sim.tick';
  tick: number;
  acting: string[];
  cooldown: Record<string, number>;
}

/**
 * One persisted villager ACTION, as served by the gateway's history endpoint
 * (`GET /villagers/:id/actions`). It is the durable record behind the left-dock
 * roster: every turn a villager actually acted (a non-null `decision`) is stored
 * with the full technical LLM context that produced it, so the UI can list the
 * action AND pop a modal of the prompt / recalled memories / raw model output.
 * It mirrors `VillagerThoughtMessage` minus the live `kind` tag, plus a server
 * timestamp.
 */
export interface VillagerActionRecord {
  villagerId: string;
  villagerName: string;
  tick: number;
  /** Always present — only acting turns are recorded, never skips. */
  decision: AgentDecision;
  recalledMemories: { text: string; kind: string; score: number }[];
  prompt: { system: string; user: string };
  rawOutput: string;
  /**
   * Where the decision came from: `'llm'` (the model chose it) or `'fallback'` (a
   * scripted contextual step we substituted because the model produced nothing
   * usable — its `rawOutput` is then empty/partial). Absent on records written
   * before this field existed; treat absence as `'llm'`.
   */
  decisionSource?: 'llm' | 'utility' | 'fallback';
  /** The full agentic trace for the turn this action came from, when the mind ran the loop. */
  steps?: AgentTraceStep[];
  /** Server wall-clock time the action was recorded, ISO-8601 on the wire. */
  recordedAt: string;
}

/**
 * A villager's STATIC IDENTITY, surfaced to the browser for the roster's
 * "Character" view: who they are and what they want, independent of the
 * moment-to-moment world state. Served by `GET /villagers/:id/persona`.
 */
export interface VillagerPersona {
  id: string;
  /** Display name, e.g. "Bram Baker". */
  name: string;
  /** A short, stable personality, e.g. ["curious", "cautious", "talkative"]. */
  traits: string[];
  /** What the villager is presently trying to achieve. */
  goal: string;
  /** Optional flavour/history; omitted when the persona carries none. */
  backstory?: string;
}

/**
 * One stored MEMORY of a villager, surfaced to the browser for the roster's
 * "Memories" view. A read-only projection of the agent's memory record (the
 * embedding vector is never sent). Served by `GET /villagers/:id/memories`,
 * newest first.
 */
export interface VillagerMemory {
  /** Stable memory id. */
  id: string;
  /** The narrative line that was remembered. */
  text: string;
  /** Observation / conversation / reflection / … (the agent's `MemoryKind`). */
  kind: string;
  /** Salience in [0,1] — reflections high, mundane observations low. */
  importance: number;
  /** Wall-clock ms when the memory formed. */
  timestamp: number;
  /** The simulation tick it formed on, when known. */
  tick?: number;
}

/** One line in the village chat: who said it, what they said, and when. */
export interface ConversationMessage {
  speakerId: string;
  speakerName: string;
  message: string;
  /** World tick the line was spoken on. */
  tick: number;
  /** Wall-clock time the line was recorded, ISO-8601 on the wire. */
  at: string;
}

/**
 * The village CHAT: a single rolling log of everything villagers say aloud, in the
 * order it was said. Speech is broadcast — a villager's words reach everyone within
 * earshot — so there is one shared transcript rather than per-pair threads. New
 * lines append; the speakers seen so far make up `participants`. Persisted and
 * surfaced live in the UI.
 */
export interface Conversation {
  /** Stable id of the chat log (a single, village-wide channel). */
  id: string;
  /** The villager ids that have spoken so far, in first-seen order. */
  participants: string[];
  /** Display names for `participants`, in the same order. */
  participantNames: string[];
  startedAt: string;
  lastAt: string;
  startTick: number;
  lastTick: number;
  /** Every line spoken, in the order it was said. */
  messages: ConversationMessage[];
}

/**
 * Pushed whenever a conversation is opened or extended by a new line, so the UI
 * list updates live. Carries the full conversation each time (they stay small),
 * so the client can simply replace its cached copy by `id`.
 */
export interface ConversationUpdateMessage {
  kind: 'conversation.updated';
  conversation: Conversation;
}

/**
 * Pushed whenever something happens to a building, so the inspector panel's
 * activity log updates live. Carries the single new event; the client appends it
 * to whichever building it is currently inspecting.
 */
export interface BuildingEventMessage {
  kind: 'building.event';
  event: BuildingEvent;
}

/**
 * The semantic REASON an LLM call was made — finer-grained than `endpoint`,
 * since both a villager's turn and the God Agent's turn hit `/decide`, and
 * both nightly reflection and daily planning hit `/complete`. This is what
 * the debug window's type filter and per-type averages key off.
 */
export type LlmCallPurpose = 'decide' | 'supervisor' | 'reflect' | 'plan' | 'embed';

// ---------------------------------------------------------------------------
// Reasoning effort — how hard the model is asked to think, per call purpose
// ---------------------------------------------------------------------------

/**
 * How much DELIBERATION the model is steered toward before it answers. This is a
 * pure PROMPT lever: a line is appended to the system prompt asking the model to
 * think more or less, while the answer it must emit (a JSON tool call, or the
 * requested prose) is unchanged — the extra reasoning stays internal, never in
 * the output. Local models honour this to varying degrees; it costs nothing for
 * those that don't.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * The call purposes whose effort can be tuned — every LLM use EXCEPT `embed`
 * (an embedding is a vector lookup, not reasoning). One global level per purpose.
 */
export type EffortPurpose = Exclude<LlmCallPurpose, 'embed'>;

/** The tunable purposes, in display order (used by the settings UI). */
export const EFFORT_PURPOSES: readonly EffortPurpose[] = ['decide', 'supervisor', 'reflect', 'plan'];

/** A complete per-purpose effort configuration. */
export type ReasoningEffortSettings = Record<EffortPurpose, ReasoningEffort>;

/** The balanced default applied before anything is configured or persisted. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffortSettings = {
  decide: 'medium',
  supervisor: 'medium',
  reflect: 'medium',
  plan: 'medium',
};

/** Human label for each level (for the UI + logs). */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Guard: is `v` one of the three effort levels? */
export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return v === 'low' || v === 'medium' || v === 'high';
}

/** Guard: is `v` one of the tunable purposes? */
export function isEffortPurpose(v: unknown): v is EffortPurpose {
  return EFFORT_PURPOSES.includes(v as EffortPurpose);
}

/**
 * The system-prompt line that realises a given effort level. Appended to the END
 * of the system prompt (so the long, cache-friendly prefix is untouched) by the
 * shared LLM client. The directive scales how much the model deliberates, and in
 * every case insists the reasoning stays internal — the final answer must carry
 * only the required output, never the thinking. `medium` returns '' so the
 * baseline prompt is left exactly as it was.
 */
export function reasoningEffortInstruction(level: ReasoningEffort): string {
  switch (level) {
    case 'low':
      return (
          'Reasoning effort: LOW. Decide quickly and decisively with minimal ' +
          'deliberation. Keep your <think> process to an absolute minimum, ' +
          'do not weigh options at length, and proceed immediately to ' +
          'providing only the required output.'
      );
    case 'high':
      return (
          'Reasoning effort: HIGH. Think carefully and thoroughly before you answer. ' +
          'Use your <think> block to weigh your situation, memories, relationships, ' +
          'and goals step-by-step before committing to the single best choice. ' +
          'Once your <think> block is complete, your final visible reply must ' +
          'contain only the required output (the tool call / the requested text).'
      );
    case 'medium':
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// LLM model — which chat model the engine thinks with
// ---------------------------------------------------------------------------

/**
 * The engine's CHAT model state, owned by the backend and pushed to the browser
 * so the Settings window can show (and switch) it. A single global model backs
 * every kind of mind work — villager decisions, the God, reflection, planning;
 * embeddings keep their own fixed model and are never touched here.
 *
 * `available` is discovered live from the llama/Ollama backend (its
 * `GET /v1/models`); it may be empty if the backend is unreachable, in which
 * case the UI still shows `current` and offers a refresh.
 */
export interface LlmModelConfig {
  /** The model id every chat call currently runs against. Empty only before the engine answers. */
  current: string;
  /** Model ids the backend reports it can serve, for the selector. May be empty. */
  available: string[];
}

/**
 * One endpoint in the LLM POOL — a single OpenAI-compatible server. Each endpoint
 * is serialized on its own (one in-flight call at a time), but different endpoints
 * run in PARALLEL, so the pool's concurrency ceiling equals the number of endpoints.
 */
export interface LlmEndpointInfo {
  /** Stable id (the base URL). */
  id: string;
  /** The server's base URL. */
  baseUrl: string;
  /** Model ids this endpoint reports via `GET /v1/models`. May be empty if unreachable. */
  models: string[];
  /** True while a call is queued or running on this endpoint. */
  busy: boolean;
}

/**
 * The LLM pool the backend can spread minds across. `capacity` is how many turns
 * may think at once (= number of endpoints); the scheduler sizes its concurrency
 * from it. `defaultModel` is what an unassigned call runs against.
 */
export interface LlmPoolConfig {
  endpoints: LlmEndpointInfo[];
  capacity: number;
  defaultModel: string;
}

/**
 * TOKEN usage for one LLM call, as reported by the model server's `usage` block.
 * `inputTokens` is the prompt read; `outputTokens` is everything generated (which
 * includes any reasoning); `thinkTokens` is the reasoning portion when the model
 * breaks it out separately (a reasoning model's hidden "thinking"). Absent fields
 * mean the server didn't report them.
 */
export interface LlmUsage {
  /** Prompt (input) tokens the model read. */
  inputTokens: number;
  /** Completion (output) tokens generated — includes reasoning tokens, if any. */
  outputTokens: number;
  /** Reasoning ("thinking") tokens, when the model reports them separately. */
  thinkTokens?: number;
}

/**
 * Routing hint a mind attaches to an LLM call so the pool runs it on a chosen
 * endpoint and/or model. Both optional: omit `endpoint` to let the pool pick the
 * least-loaded free one, omit `model` to use that endpoint's default. This is how
 * villagers "share one endpoint/model" or are "assigned independently".
 */
export interface LlmRouteHint {
  /** Endpoint id (base URL) to run on. Omit to let the pool choose a free one. */
  endpoint?: string;
  /** Model id to run. Omit to use the pool's default model. */
  model?: string;
}

/**
 * One LLM round-trip to the shared engine is STARTING — the browser-facing
 * mirror of the `engine.llm.started` bus event. Drives the LLM-engine debug
 * window's "running" list. Fields mirror the bus payload one-for-one.
 */
export interface LlmCallStartedMessage {
  kind: 'engine.llm.started';
  id: number;
  endpoint: '/decide' | '/complete' | '/embed';
  purpose: LlmCallPurpose;
  /** Who issued the call: a villager name, "God Agent", or a villager id. */
  agent: string;
  label: string;
  request: string;
  startedAt: number;
}

/**
 * A STREAMING delta of an in-flight `/decide` call — the browser-facing mirror
 * of `engine.llm.delta`. The Live LLM window appends each chunk to that call's
 * growing live block (splitting reasoning from visible output) until the
 * matching `finished` message lands it in a history card.
 */
export interface LlmCallDeltaMessage {
  kind: 'engine.llm.delta';
  id: number;
  /** Newest slice of visible output text (may contain `<think>` tags). */
  content?: string;
  /** Newest slice of separately-reported reasoning, when the model breaks it out. */
  reasoning?: string;
}

/** The matching round-trip FINISHED — mirror of `engine.llm.finished`. */
export interface LlmCallFinishedMessage {
  kind: 'engine.llm.finished';
  id: number;
  endpoint: '/decide' | '/complete' | '/embed';
  purpose: LlmCallPurpose;
  label: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  response: string;
  error?: string;
  startedAt: number;
  /** How many tool calls the model emitted this turn (the `/decide` path). */
  toolCount?: number;
  /** Token usage the model reported for this call, when available (the debug window tallies it). */
  usage?: LlmUsage;
}

/**
 * The engine's current POOL shape, pushed to the browser on connect and on a
 * short interval so the LLM-engine debug window can show each endpoint, its
 * models, and whether it is busy right now. The backend owns the truth (it polls
 * the engine's `/pool`).
 */
export interface LlmPoolMessage {
  kind: 'llm.pool';
  config: LlmPoolConfig;
}

/**
 * A villager's PRAYER, surfaced live to the human "Supervisor" console (the
 * temple's god) so the user can hear each petition as it is offered and choose to
 * grant or deny it. `id` is the prayer's bus eventId — the stable handle a verdict
 * references.
 */
export interface SupervisorPrayerMessage {
  kind: 'supervisor.prayer';
  id: string;
  villagerId: string;
  villagerName: string;
  message: string;
  tick: number;
  /**
   * Which village the praying villager belongs to (v3 rival-village seam). The gateway
   * stamps it from the villager's `villageId`, defaulting to {@link DEFAULT_VILLAGE_ID},
   * so the N-village god console can file each petition under its own village.
   */
  villageId: string;
}

/**
 * A divine ACT the Supervisor (god) just took — broadcast to the human console so
 * the outcome of a force-run (or the autonomous daily deliberation) is visible.
 * `action` is the god-tool kind; `summary` is a one-line human-readable gloss.
 */
export interface SupervisorActionMessage {
  kind: 'supervisor.action';
  action: string;
  summary: string;
  /**
   * Which village's god took the act (v3 rival-village seam). Stamped by the gateway from
   * the command's `villageId` (or the target villager's), defaulting to
   * {@link DEFAULT_VILLAGE_ID}, so the console can attribute each divine act to a side.
   */
  villageId: string;
}

// ---------------------------------------------------------------------------
// VILLAGE VISION — the settlement's shared ambition to grow into a city
// ---------------------------------------------------------------------------

/** Which pillar of city-growth a milestone belongs to (for grouping + colour). */
export type VillagePillar = 'build' | 'culture' | 'economy' | 'other';

/**
 * One thing the village ACHIEVED on its road from huts to a city — a structure
 * raised, a custom or festival taken up, a trade established. Milestones accumulate
 * across days (the god appends them) so growth compounds and villagers can see how
 * far they have come. Build milestones are recorded objectively from completed
 * construction; the cultural/economic ones are the god's reading of the day.
 */
export interface VillageMilestone {
  /** In-world day (1-based) it was reached. */
  day: number;
  pillar: VillagePillar;
  /** One human line, e.g. "Raised Hearthstone Hall, a meeting house". */
  text: string;
}

/**
 * The village's shared VISION: how city-like it has become, and the achievements
 * that got it there. There is no formal metric — `stage` is the god's free-form
 * NAME for the settlement's current development ("a scattering of homesteads", "a
 * hamlet", "a town", "a city in truth"), reassessed each day and narrated in the
 * chronicle. Persisted across reboots and broadcast to every villager so the
 * collective goal — grow the village into a city — is always in front of them.
 */
export interface VillageVision {
  /** The god's current name for the settlement's stage of development. */
  stage: string;
  /** Achievements so far, oldest first; the compounding record of growth. */
  milestones: VillageMilestone[];
  /** The in-world day this vision was last reassessed (0 before the first night). */
  updatedDay: number;
  /**
   * Which village this vision belongs to (v3 rival-village seam). Set when broadcast so
   * a villager carries only its own village's stage/milestones; absent ⇒ the
   * single-village default ({@link DEFAULT_VILLAGE_ID}).
   */
  villageId?: string;
}

// ---------------------------------------------------------------------------
// v3 — VILLAGE SCORE (a head-to-head competition metric, design §10)
// ---------------------------------------------------------------------------

/**
 * The PILLARS a {@link VillageScore} breaks down into. Each is its own 0..100
 * sub-score so the HUD and supervisor can see WHY a village leads or trails, not
 * just the bottom line. Deliberately NOT survival/needs — a village that merely
 * keeps its people fed is treading water; the score measures the things two
 * villages actually compete over.
 */
export interface VillageScorePillars {
  /**
   * GROWTH — how built-up the settlement is: its structures and its population.
   * The visible footprint a rival sees across the valley.
   */
  growth: number;
  /**
   * SOCIAL — how alive and cohesive the village is, read from how much its people
   * talk and act together rather than idling apart.
   */
  social: number;
  /**
   * DEFENSE — the village's standing in the raiding game: how its raids inflicted
   * on rivals balance against the raids it has suffered. 50 is untested neutrality.
   */
  defense: number;
}

/** Every pillar key, as a runtime list — for iterating the breakdown in the UI. */
export const VILLAGE_SCORE_PILLARS: readonly (keyof VillageScorePillars)[] = [
  'growth',
  'social',
  'defense',
];

/**
 * One village's COMPETITION SCORE: a single 0..100 number plus the per-pillar
 * breakdown it is blended from. Computed by the daily aggregator off the same
 * per-village snapshot the digest is built from, so it never needs the engine's
 * internals. Emitted for every village at once as a {@link VillageScoreboard} so
 * the head-to-head is always apples-to-apples.
 */
export interface VillageScore {
  villageId: string;
  /** A human label for the village, if known (e.g. its name), else the id. */
  villageName?: string;
  /** The blended 0..100 overall standing. */
  overall: number;
  /** The 0..100 sub-scores `overall` is weighted from. */
  pillars: VillageScorePillars;
}

/**
 * The leaderboard across every village, recomputed each aggregator pulse + day
 * boundary. `scores` is sorted by `overall` descending, so `scores[0]` leads.
 * With a single village it carries exactly one entry — a score against no rival.
 */
export interface VillageScoreboard {
  day: number;
  tick: number;
  scores: VillageScore[];
}

/** A single divine act the god took during a day, for the chronicle's ledger. */
export interface DivineAct {
  /** The god-tool kind (spawn_entity / change_weather / plant_idea). */
  action: string;
  /** A one-line, human-readable gloss of the act. */
  summary: string;
}

/**
 * The God Agent's end-of-day CHRONICLE — a beautiful, human-facing report of the
 * day, authored every day (independent of whether the god intervened). The
 * narrative is mythic prose; the metrics/quotes/prayers/acts are the ledger the
 * client renders beside it. Persisted and pushed to the browser's summary window.
 */
export interface SupervisorDailyReportPayload {
  day: number;
  tick: number;
  /** A human in-world stamp for the day, e.g. "Day 7 · 18:00". */
  dateLabel: string;
  /** The god's mythic, poetic chronicle of the day (free prose). */
  narrative: string;
  /** The day's hard numbers, mirrored from the aggregator's summary. */
  metrics: {
    population: number;
    conversations: number;
    movements: number;
    idleVillagers: number;
    weather: WeatherKind;
  };
  /** A few standout utterances from the day. */
  quotes: string[];
  /** Prayers villagers offered at the temple today. */
  prayers: string[];
  /** What the god did today (weather, spawns, planted ideas). */
  divineActs: DivineAct[];
  /**
   * The god's name for the village's stage of development on this day (its reading
   * of how city-like the settlement has become), if it judged one. Absent on old
   * reports and when no vision is tracked. See {@link VillageVision}.
   */
  villageStage?: string;
  /** Milestones the village reached this day (newly recorded), for the chronicle. */
  newMilestones?: VillageMilestone[];
}

/**
 * The god's nightly chronicle pushed to the browser for the summary window. Wraps
 * the {@link SupervisorDailyReportPayload} the supervisor authored each day.
 */
export interface SupervisorDailyReportMessage {
  kind: 'supervisor.daily_report';
  report: SupervisorDailyReportPayload;
}

/**
 * The village COMPETITION SCOREBOARD pushed to the browser: the live head-to-head
 * standing for the HUD chip and the supervisor panel breakdown. Pushed on connect
 * (replayed from the gateway's cache) and on every aggregator pulse / day boundary.
 */
export interface VillageScoreMessage {
  kind: 'village.score';
  scoreboard: VillageScoreboard;
}

/**
 * A per-village CENSUS — the concrete vitals a multi-village UI shows beside the
 * abstract 0..100 score: how many people, how much of each resource is stored, and
 * what structures stand. Derived by the gateway from the per-village digest the
 * aggregator already emits (`village.pulse` / `village.daily_summary`), so no new
 * server emitter is needed. Emitted for EVERY known village together so the head-to-
 * head reads apples-to-apples, mirroring {@link VillageScoreboard}.
 */
export interface VillageCensus {
  villageId: string;
  /** Headcount of living villagers in the village. */
  population: number;
  /** Total units of each resource held across the village's building stocks. */
  resources: Partial<Record<ResourceKind, number>>;
  /** Per building-kind: how many stand. Drawn from the digest's building tallies. */
  structures: { kind: string; count: number }[];
  /** How many of the village's structures are fortifications (walls/gates/towers/etc). */
  fortCount: number;
}

/**
 * The census across every village, pushed to the browser on each aggregator pulse and
 * cached for replay on connect (like {@link VillageScoreMessage}). The client groups its
 * entities by `villageId` as a live fallback, but this is the authoritative tally.
 */
export interface VillageCensusMessage {
  kind: 'village.census';
  day: number;
  tick: number;
  villages: VillageCensus[];
}

/**
 * A salient WORLD EVENT surfaced to the browser — a raid, famine, shortage, surplus,
 * newcomer, completed build or stagnation — tagged with the village it is ABOUT so the
 * UI can raise a per-village alert/ticker. Mirrors the bus `village.alert`
 * ({@link DigestEvent}); the gateway forwards it and keeps a short replay buffer.
 */
export interface VillageAlertMessage {
  kind: 'village.alert';
  villageId: string;
  event: DigestEvent;
}

/**
 * The current per-purpose REASONING-EFFORT configuration, pushed to the browser
 * on connect and on every change so the settings window mirrors the live state
 * (and stays in sync across multiple open tabs). The single source of truth lives
 * on the backend.
 */
export interface ReasoningEffortMessage {
  kind: 'reasoning.effort';
  settings: ReasoningEffortSettings;
}

/**
 * The engine's current CHAT-MODEL config, pushed to the browser on connect and
 * on every change so the Settings window mirrors the live model (and stays in
 * sync across tabs). The backend owns the truth.
 */
export interface LlmModelMessage {
  kind: 'llm.model';
  config: LlmModelConfig;
}

/** Anything the server may push to a client. Narrow on `.kind`. */
export type ServerMessage =
  | WorldInitMessage
  | WorldGeneratingMessage
  | WorldNeedsSetupMessage
  | WorldStylePreviewMessage
  | WorldStateUpdate
  | WorldWeatherMessage
  | VillagerThoughtMessage
  | ConversationUpdateMessage
  | BuildingEventMessage
  | SimTickMessage
  | LlmCallStartedMessage
  | LlmCallDeltaMessage
  | LlmCallFinishedMessage
  | SupervisorPrayerMessage
  | SupervisorActionMessage
  | SupervisorDailyReportMessage
  | VillageScoreMessage
  | VillageCensusMessage
  | VillageAlertMessage
  | RelationshipUpdateMessage
  | GroupPlanMessage
  | AgendaUpdateMessage
  | AgendaRemovedMessage
  | ReasoningEffortMessage
  | LlmModelMessage
  | LlmPoolMessage;

// ---------------------------------------------------------------------------
// Client -> Server commands ("God Hand" interventions)
// ---------------------------------------------------------------------------

/**
 * Force a villager to start walking toward (x, y). The engine validates the
 * target (in-bounds, not a tree) and then moves the villager over subsequent
 * ticks — it does NOT teleport. Originates from a human "God Hand" click,
 * relayed by the Ingress Gateway over the `user.commands` exchange.
 */
export interface ForceMoveCommand {
  command: 'force_move';
  targetId: string;
  x: number;
  y: number;
}

/**
 * An autonomous villager's own request to walk toward (x, y). Functionally the
 * same destination-setting as `force_move`, but it originates from an AI villager
 * on the `villager.intents` exchange rather than from a human. Kept as a distinct
 * variant so the engine (and logs) can tell intent from intervention.
 */
export interface VillagerMoveCommand {
  command: 'villager_move';
  villagerId: string;
  x: number;
  y: number;
}

/**
 * The God Agent's request to introduce a new entity. Arrives over
 * `supervisor.commands` and is translated into this engine command by the
 * transport. The engine validates the tile (in-bounds, not already a tree).
 */
export interface SpawnEntityCommand {
  command: 'spawn_entity';
  entityType: SpawnableType;
  x: number;
  y: number;
  /**
   * For a `wall` (or `gate`): how many segments to lay in a LINE from (x, y). One
   * tile per segment, marching along {@link orientation}. Ignored by point spawns
   * (villager / tree / single fort buildings). A wall line of length>2 auto-leaves
   * one `gate` near its middle so the ring it forms is actually enterable.
   */
  length?: number;
  /** Direction a wall line marches: 'h' = east along +x, 'v' = south along +y. */
  orientation?: 'h' | 'v';
}

/** The God Agent's request to set the village-wide weather. */
export interface SetWeatherCommand {
  command: 'set_weather';
  weather: WeatherKind;
}

/**
 * A divine BLESSING on one villager: the god mends body and spirit at once —
 * every need is eased to nothing and a sleeper is roused, fully restored. Arrives
 * from the human god console (relayed as `user.bless`).
 */
export interface BlessVillagerCommand {
  command: 'bless_villager';
  villagerId: string;
}

/**
 * A divine SMITING of one villager: the god visits hardship — every need spikes
 * toward distress, so the villager must scramble to recover. The mirror of a
 * blessing, from the same console (relayed as `user.smite`).
 */
export interface SmiteVillagerCommand {
  command: 'smite_villager';
  villagerId: string;
}

/**
 * An autonomous villager's request to WORK at a building to replenish its
 * resources (draw water, harvest, bake, …). Originates from a villager mind on
 * the `villager.intents` exchange. The engine walks the villager to the building
 * if needed and tops up its stock over subsequent ticks (a {@link VillagerTask}).
 */
export interface VillagerWorkCommand {
  command: 'villager_work';
  villagerId: string;
  buildingId: string;
}

/**
 * A villager's request to TAKE a resource from a building into its backpack
 * (load up at a producer), or to GIVE carried resource to a building (drop off
 * where it's needed). The engine moves as much as fits — bounded by the
 * building's stock/capacity and the backpack's free space / carried amount — and
 * only when the villager is standing next to the building.
 */
export interface VillagerTakeCommand {
  command: 'villager_take';
  villagerId: string;
  buildingId: string;
  resource: ResourceKind;
}

export interface VillagerGiveCommand {
  command: 'villager_give';
  villagerId: string;
  buildingId: string;
  resource: ResourceKind;
}

/**
 * A villager's PRAYER at the temple — a petition addressed to the God Agent
 * (Supervisor). The engine records it and emits a `village.prayer` event onto the
 * nervous system; the day's prayers are folded into the nightly village summary
 * the Supervisor reads, so the god hears its people at its daily cadence. The
 * villager must be standing next to the temple for the prayer to be heard.
 */
export interface VillagerPrayCommand {
  command: 'villager_pray';
  villagerId: string;
  buildingId: string;
  message: string;
}

/**
 * A villager's intent to START a construction project — to raise a new structure
 * the village builds together. The engine opens a `construction_site` building at
 * (or near) the chosen tile; villagers then haul materials and `give_to` it until
 * it is complete. `structure` is the {@link BuildableId} being raised and `name`
 * the label the finished building will carry.
 */
export interface VillagerStartBuildCommand {
  command: 'villager_start_build';
  villagerId: string;
  structure: BuildableId;
  name: string;
  /** For an INVENTED structure (`structure: 'custom'`): what it is — becomes the
   *  finished landmark's function. Absent for catalog kinds. */
  description?: string;
  x: number;
  y: number;
}

/** A villager setting or replacing a nearby cart's standing take→deposit order. */
export interface VillagerCommandCartCommand {
  command: 'villager_command_cart';
  villagerId: string;
  cartId: string;
  resource: ResourceKind;
  fromBuildingId: string;
  toBuildingId: string;
}

/**
 * Anything the engine can be asked to do. These arrive over RabbitMQ
 * (`user.commands` / `villager.intents` / `supervisor.commands`) rather than a
 * WebSocket, but the engine's intake (`dispatchCommand`) stays
 * transport-agnostic. Narrow on `.command`.
 */
export type ClientCommand =
  | ForceMoveCommand
  | VillagerMoveCommand
  | SpawnEntityCommand
  | SetWeatherCommand
  | BlessVillagerCommand
  | SmiteVillagerCommand
  | VillagerWorkCommand
  | VillagerTakeCommand
  | VillagerGiveCommand
  | VillagerPrayCommand
  | VillagerStartBuildCommand
  | VillagerCommandCartCommand;

/**
 * The "Inception" intervention: a human, via the UI inspector, forcing a
 * synthetic memory into one villager's mind. Browser-only — it is relayed by
 * the gateway straight onto the bus for the villagers, and never reaches the
 * engine (see `user.intervention.plant_idea` in shared/events.ts).
 */
export interface PlantIdeaCommand {
  command: 'plant_idea';
  targetId: string;
  memory: string;
}

/**
 * The human god's verdict on one villager prayer, sent from the Supervisor
 * console. 'choose' GRANTS this one prayer — the god answers it at once and every
 * other prayer still pending is dismissed (only one can be chosen). 'reject' lets
 * a single prayer fall on deaf ears without disturbing the rest. The gateway
 * relays it to the Supervisor over `user.supervisor.verdict` — a multi-word key
 * the engine's one-word `user.*` binding deliberately skips (like `plant_idea`).
 */
export interface SupervisorVerdictCommand {
  command: 'supervisor_verdict';
  prayerId: string;
  villagerId: string;
  villagerName: string;
  message: string;
  verdict: 'choose' | 'reject';
  /**
   * Which village's god should hear this verdict (v3 rival-village seam). With one
   * supervisor per village the gateway routes by it; absent ⇒ {@link DEFAULT_VILLAGE_ID}.
   * The console fills it from the prayer's `villageId`.
   */
  villageId?: string;
}

/** Force the Supervisor (god) to weigh the pending prayers NOW (answers at most one), off-cadence. */
export interface SupervisorForceRunCommand {
  command: 'supervisor_force_run';
  /** Which village's god to force-run (v3 rival seam); absent ⇒ {@link DEFAULT_VILLAGE_ID}. */
  villageId?: string;
}

/** Pause (seize the wheel) or resume the autonomous LLM Supervisor — the v3 §8 human override. */
export interface SupervisorPauseCommand {
  command: 'supervisor_pause';
  paused: boolean;
  /** Which village's god to pause/resume (v3 rival seam); absent ⇒ {@link DEFAULT_VILLAGE_ID}. */
  villageId?: string;
}

/**
 * The human god, from the Supervisor console's "Divine Powers", directly setting
 * the village weather. Unlike the autonomous god's `change_weather` (which rides
 * `supervisor.commands`), this is a human intervention relayed over `user.commands`
 * straight to the engine.
 */
export interface GodSetWeatherCommand {
  command: 'god_set_weather';
  weather: WeatherKind;
}

/** The human god blessing one villager (eases every need, wakes a sleeper). */
export interface GodBlessCommand {
  command: 'god_bless';
  targetId: string;
}

/** The human god smiting one villager (every need spikes toward distress). */
export interface GodSmiteCommand {
  command: 'god_smite';
  targetId: string;
}

/** The human god conjuring a new entity at a tile (a newcomer or a tree). */
export interface GodSpawnCommand {
  command: 'god_spawn';
  entityType: 'villager' | 'tree';
  x: number;
  y: number;
}

/**
 * From the Settings window: set the reasoning effort for ONE call purpose. It is
 * a backend-config change (not a world intervention), relayed by the gateway over
 * the multi-word `user.config.set_reasoning_effort` key the engine's one-word
 * `user.*` binding deliberately skips.
 */
export interface SetReasoningEffortCommand {
  command: 'set_reasoning_effort';
  purpose: EffortPurpose;
  level: ReasoningEffort;
}

/**
 * From the Settings window: switch the engine's global CHAT model. Like
 * {@link SetReasoningEffortCommand} it is a backend-config change, relayed over
 * the multi-word `user.config.set_llm_model` key the engine's one-word `user.*`
 * binding skips; the backend applies it, persists it, and re-broadcasts.
 */
export interface SetLlmModelCommand {
  command: 'set_llm_model';
  /** A model id the backend reported as available. */
  model: string;
}

/**
 * From the Settings window: re-query the backend for its available models (and
 * re-broadcast the current config). Lets the operator pick up a model that came
 * online after boot, or recover the list if discovery failed at startup.
 */
export interface RefreshLlmModelsCommand {
  command: 'refresh_llm_models';
}

/**
 * From the first-run SETUP screen: create the village. `mode: 'static'` uses the
 * hand-authored seed + villagers.json; `mode: 'auto'` generates with the LLM using
 * the chosen free-text `style`, villager count and size.
 */
export interface GenerateWorldCommand {
  command: 'generate_world';
  mode: 'auto' | 'static';
  /** Free-text style for auto mode (desert, alien, water…); ignored for static. */
  style?: string;
  /** Villager count for auto mode (slider). */
  villagers?: number;
  /** Village size/density for auto mode. */
  size?: VillageSize;
  /**
   * The TWO-village (rival) selections — a shared map theme plus independent per-side
   * params. Present only when the backend is in rival mode (RIVAL_VILLAGE=on); the
   * single-village `style`/`villagers`/`size` fields above are ignored when it is set.
   * `mode` still selects auto (LLM) vs static (fixed-blueprint) generation.
   */
  rival?: RivalSetupParams;
}

/**
 * From the setup screen: a fast preview of a style's colours, as the player types or
 * picks a chip. `requestId` lets the UI drop stale answers. Debounced client-side.
 */
export interface PreviewStyleCommand {
  command: 'preview_style';
  requestId: number;
  style: string;
}

/**
 * From the Settings window's "New Village": wipe the current world and return to the
 * setup screen. Destructive — the UI confirms first.
 */
export interface ResetWorldCommand {
  command: 'reset_world';
}

/**
 * Anything the BROWSER may send the gateway. A superset overlap with
 * `ClientCommand` (both share `force_move`); kept distinct because the God-Hand
 * walk goes to the engine while the God-Whisper (`plant_idea`) and the temple
 * console commands (`supervisor_*`) go to the villagers / the Supervisor.
 */
export type BrowserCommand =
  | ForceMoveCommand
  | PlantIdeaCommand
  | SupervisorVerdictCommand
  | SupervisorForceRunCommand
  | SupervisorPauseCommand
  | GodSetWeatherCommand
  | GodBlessCommand
  | GodSmiteCommand
  | GodSpawnCommand
  | SetReasoningEffortCommand
  | SetLlmModelCommand
  | RefreshLlmModelsCommand
  | GenerateWorldCommand
  | PreviewStyleCommand
  | ResetWorldCommand;
