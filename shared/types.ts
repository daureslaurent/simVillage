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
   *  Opens a construction site others haul materials to — a shared village goal. */
  | { kind: 'propose_build'; structure: BuildableId; name: string; x: number; y: number }
  /** Set (or replace) the standing order of a nearby {@link Cart}: which resource to
   *  haul, the building to take FROM, and the building to give TO. The cart then runs
   *  that take→deposit loop on its own. Requires standing beside the cart. */
  | {
      kind: 'command_cart';
      cartId: string;
      resource: ResourceKind;
      fromBuildingId: string;
      toBuildingId: string;
    };

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

/** Fields common to every entity. */
export interface BaseEntity {
  /** Stable unique id, e.g. "villager_1" or "tree_42". */
  id: string;
  type: EntityType;
  /** Current position in grid coordinates. May be fractional for smooth motion. */
  position: Vec2;
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
  | 'lamp';

/**
 * The structures villagers can choose to RAISE together, named by a friendly id
 * the build tool exposes (kept separate from {@link BuildingKind} so the internal
 * `construction_site` / `quarry` kinds are never offered as buildable). Each id maps
 * to a finished {@link BuildingKind}, a material cost, and a footprint — see the
 * `BUILDABLES` registry in `shared/buildings.ts`.
 */
export type BuildableId = 'house' | 'well' | 'statue' | 'lamp' | 'handcart' | 'freight';

/** Every buildable id, as a runtime list — the closed vocabulary of what can be raised. */
export const BUILDABLE_IDS: readonly BuildableId[] = [
  'house',
  'well',
  'statue',
  'lamp',
  'handcart',
  'freight',
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
  /** Render color (any CSS color string). */
  color: string;
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
}

// ---------------------------------------------------------------------------
// Server -> Client messages
// ---------------------------------------------------------------------------

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
  /** Server wall-clock time the action was recorded, ISO-8601 on the wire. */
  recordedAt: string;
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
}

/** Anything the server may push to a client. Narrow on `.kind`. */
export type ServerMessage =
  | WorldInitMessage
  | WorldStateUpdate
  | WorldWeatherMessage
  | VillagerThoughtMessage
  | ConversationUpdateMessage
  | BuildingEventMessage
  | SimTickMessage
  | LlmCallStartedMessage
  | LlmCallFinishedMessage
  | SupervisorPrayerMessage
  | SupervisorActionMessage
  | RelationshipUpdateMessage
  | GroupPlanMessage;

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
  entityType: 'villager' | 'tree';
  x: number;
  y: number;
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
}

/** Force the Supervisor (god) to weigh the pending prayers NOW (answers at most one), off-cadence. */
export interface SupervisorForceRunCommand {
  command: 'supervisor_force_run';
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
  | GodSetWeatherCommand
  | GodBlessCommand
  | GodSmiteCommand
  | GodSpawnCommand;
