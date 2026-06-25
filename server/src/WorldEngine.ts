/**
 * server/src/WorldEngine.ts
 * ---------------------------------------------------------------------------
 * THE pure simulation core. This class is deliberately ignorant of HOW its
 * state reaches the outside world and HOW it is persisted:
 *
 *   - It imports NO networking library (`ws`, `http`, ...).
 *   - It imports NO database driver (`mongodb`, ...).
 *
 * Instead it is a typed event emitter: it `emit`s `init`/`tick` events that any
 * number of consumers (a WebSocket transport, a Mongo snapshot writer, a test
 * harness, a future RabbitMQ bridge) can subscribe to, and it accepts the
 * outside world's intentions through a single transport-agnostic method:
 * `dispatchCommand`.
 *
 * This is the seam that lets Phase 2 swap WebSockets for RabbitMQ without
 * touching a single line in this file.
 * ---------------------------------------------------------------------------
 */

import { EventEmitter } from 'node:events';

import type {
  Villager,
  VillagerNeeds,
  Building,
  BuildableId,
  BuildingKind,
  BuildingStock,
  BuildingEvent,
  BuildingEventKind,
  Cart,
  CartTier,
  ClientCommand,
  ConstructionState,
  Entity,
  Gathering,
  ResourceKind,
  Tree,
  Vec2,
  TerrainPalette,
  WeatherKind,
  WorldInitMessage,
  WorldSeed,
  WorldStateUpdate,
} from '../../shared/types';
import { BACKPACK_CAPACITY } from '../../shared/types';
import { deriveAppearance } from '../../shared/appearance';
import {
  AMBIENCE_RADIUS,
  BUILDING_CAPACITY,
  BUILDING_COLORS,
  BUILDING_FUNCTIONS,
  cartSpecFor,
  NEED_RESOURCE,
  CONSUME_INTERVAL_ROUNDS,
  NEED_RELIEF_PER_UNIT,
  NEED_CONSUME_THRESHOLD,
  PASSIVE_CONVERT_RATE,
  WORKER_CONVERT_RATE,
  SERVICE_REACH,
  buildableFor,
  buildingAmbience,
  buildingConversion,
  buildingStockKinds,
  isConstructionSite,
  isDepot,
  isConverter,
  isWorkable,
  sourceResource,
  workVerb,
} from '../../shared/buildings';
import { SIM_SECONDS_PER_TICK, simTimeFromTick } from '../../shared/simClock';

/** Render palette for God-spawned newcomers, so they stand out from the seed villagers. */
const SPAWN_VILLAGER_COLORS = ['#ff8c00', '#00ced1', '#ff69b4', '#7fff00', '#ba55d3'];

// ---------------------------------------------------------------------------
// Needs simulation tuning. All rates are per-tick deltas on the 0..100 scale.
// They are intentionally gentle so the bars drift visibly over minutes rather
// than seconds, and so a short visit to the right building clearly reverses them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// All the RATES below are PER IN-WORLD ROUND (one coordinator tick of the clock),
// NOT per physics frame. The engine's physics loop runs many times a second to
// keep bodies MOVING smoothly, but needs, consumption, production and the like
// only advance when the in-world clock advances (see `update`). That ties them to
// simulated time — a slow round waiting on the LLM no longer ages the village —
// and lets the day be balanced as ~480 rounds (24h): a villager wakes rested at
// dawn, hungers/thirsts/tires over the day, and turns in by evening.
// ---------------------------------------------------------------------------

/** How fast hunger and thirst creep up each in-world round. */
const HUNGER_RATE = 0.18;
const THIRST_RATE = 0.25;
/**
 * Fatigue is the villager's POWER, spent by being awake. It grows faster while
 * walking and slower while idle, but it always grows: staying awake costs power.
 * The ONLY way to pay it back is to SLEEP (see {@link WorldEngine.stepSleep}) — a
 * tired villager sleeps at a house, and one that runs all the way out collapses
 * into a forced sleep where it stands. No building passively rests you any more.
 * Tuned so a villager active through the ~280-round waking day reaches the
 * {@link HOUSE_SLEEP_THRESHOLD} by evening.
 */
const FATIGUE_MOVE_RATE = 0.3;
const FATIGUE_IDLE_RATE = 0.2;

/**
 * Fatigue at which a TIRED villager turns in for the night, when it is idle at
 * home. This is the NORMAL way power is restored: sleeping at a house. It sits
 * below the hard {@link FATIGUE_SLEEP_THRESHOLD} collapse, so a villager who makes
 * it to a bed in time sleeps there rather than dropping in the open.
 */
const HOUSE_SLEEP_THRESHOLD = 70;
/** Fatigue (0..100) at which a villager runs out of power and collapses anywhere. */
const FATIGUE_SLEEP_THRESHOLD = 100;
/**
 * In-world ROUNDS in a full day (~480 at the default 180s/tick). The epoch is
 * 06:00, so dawn falls on exact multiples of this — the boundary a sleeper wakes
 * on (see {@link WorldEngine.fallAsleep}) and the daily clock rolls over.
 */
const ROUNDS_PER_DAY = Math.round((24 * 3600) / SIM_SECONDS_PER_TICK);
/**
 * The least a villager sleeps, in rounds (~2h), so one who collapses just before
 * dawn still gets a real rest instead of snapping awake a few minutes later. A
 * normal evening sleeper instead sleeps right through to the next dawn.
 */
const MIN_SLEEP_ROUNDS = Math.round((2 * 3600) / SIM_SECONDS_PER_TICK);
/** How fast boredom creeps up each in-world round — the daily dullness that pulls a villager toward company and the tavern. */
const BOREDOM_RATE = 0.13;
/**
 * How much boredom eases each round while a villager stands in a GATHERING (company).
 * Outpaces the per-round creep, so socializing has a payoff — and so that, once
 * boredom is low, the urge to keep chatting fades on its own (a brake on idle talk).
 */
const GATHERING_BOREDOM_RELIEF = 1.0;

/**
 * How many clock ticks (rounds) a refused-work status NOTICE lingers before it
 * fades. A couple of rounds is enough for the mind to think at least once and read
 * the guidance in its own perceived status.
 */
const NOTICE_TTL_TICKS = 2;

/**
 * How many construction sites may be open at once. A small cap so the village
 * finishes what it starts rather than dotting the map with abandoned shells — a
 * fresh `propose_build` past this is refused with a guiding notice.
 */
const MAX_CONSTRUCTION_SITES = 3;

// ---------------------------------------------------------------------------
// Environment mechanics — the WEATHER and the DAY/NIGHT cycle are not just
// ambient any more: they bend the simulation. Each weather carries a set of
// MULTIPLIERS on the core rates, plus a per-round `rainFill` of water into the
// village's cisterns (rain and storms top up the stores the crops drink).
// ---------------------------------------------------------------------------

interface WeatherEffect {
  /** Multiplier on Greenfield's passive crop conversion (rain waters the field). */
  crop: number;
  /** Multiplier on fatigue accrual (a storm is exhausting; clear skies are easy). */
  fatigue: number;
  /** Multiplier on thirst accrual (cool rain slows it; a heatwave drives it up). */
  thirst: number;
  /** Units of water rained into each water-stocking building per round (0 = none). */
  rainFill: number;
}

const WEATHER_EFFECTS: Record<WeatherKind, WeatherEffect> = {
  clear: { crop: 1, fatigue: 1, thirst: 1, rainFill: 0 },
  rain: { crop: 1.6, fatigue: 1, thirst: 0.6, rainFill: 0.4 },
  storm: { crop: 1.8, fatigue: 1.5, thirst: 0.6, rainFill: 0.8 },
  fog: { crop: 0.8, fatigue: 1.1, thirst: 1, rainFill: 0 },
  heatwave: { crop: 0.7, fatigue: 1.3, thirst: 1.8, rainFill: 0 },
};

/**
 * How much faster fatigue (power) drains in the dark. The body tires sooner at
 * night, so villagers are pulled toward sleeping when the sun is down — which is
 * what makes the day/night cycle read in behaviour, not just lighting.
 */
const NIGHT_FATIGUE_MULTIPLIER = 1.6;

/**
 * Which needs each kind of building relieves just by lingering there. Nothing,
 * now: hunger/thirst are satisfied by CONSUMING food/water (see
 * {@link WorldEngine.stepConsumption}), and fatigue is restored ONLY by SLEEPING
 * (see {@link WorldEngine.stepSleep}) — a house no longer passively rests you.
 * The house entry is kept (with no needs) purely so the status line can still
 * read "Resting at <house>" when a villager idles at home before turning in.
 */
const RELIEVES_AT: Partial<Record<BuildingKind, (keyof VillagerNeeds)[]>> = {
  house: [],
};

// ---------------------------------------------------------------------------
// Gathering detection. Villagers standing within GATHERING_RADIUS tiles of one
// another form a connected social cluster; a cluster of MIN_GATHERING or more is
// surfaced as a Gathering. The radius is kept at/under the sensory radius so that
// every member is already within earshot of the others — i.e. anyone who speaks
// is heard by the whole group.
// ---------------------------------------------------------------------------

const GATHERING_RADIUS = 8;
// Two villagers standing together already make a social cluster worth surfacing —
// with a small roster, waiting for three means a gathering almost never forms and
// the group-coordination prompting never fires. A pair is a conversation.
const MIN_GATHERING = 2;

/** Starting/normalised needs for villagers that arrive without any (e.g. old saves). */
function defaultNeeds(): VillagerNeeds {
  return { hunger: 20, thirst: 20, fatigue: 10, boredom: 20 };
}

/** Clamp a need to its valid 0..100 range. */
function clampNeed(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Strongly-typed map of the events the engine emits. */
interface WorldEngineEvents {
  /** Fired once when the engine starts (and available on demand for new clients). */
  init: (message: WorldInitMessage) => void;
  /** Fired every tick with the lightweight per-frame state. */
  tick: (update: WorldStateUpdate) => void;
  /** Fired when the God Agent changes the village weather. */
  weather: (weather: WeatherKind) => void;
  /** Fired whenever something happens to a building (take/give/work/refusal/…). */
  buildingEvent: (event: BuildingEvent) => void;
}

type EventName = keyof WorldEngineEvents;

export interface WorldEngineOptions {
  /** Simulation rate. Defaults to 10 ticks per second. */
  tickRate?: number;
}

export class WorldEngine {
  public readonly width: number;
  public readonly height: number;
  public readonly tickRate: number;
  /** Villager sensory radius in tiles (see/hear), surfaced to observers in world.init. */
  /** All entities (trees + villagers) keyed by id for O(1) command lookups. */
  private readonly entities = new Map<string, Entity>();

  /**
   * Static occupancy grid (1 = tree, 0 = free). Used to validate God-Hand
   * targets cheaply without scanning every entity. Row-major: index = y*w + x.
   */
  private readonly staticOccupancy: Uint8Array;

  /**
   * Monotonic PHYSICS tick counter since `start()`. Drives the ONLY thing that must
   * stay smooth between rounds — body MOVEMENT. The rate-based mechanics (needs
   * creep, production, the eat/drink cadence) no longer ride this; they advance with
   * the in-world clock instead (see `lastEconomyTick`). NOT the clock (see `clockTick`).
   */
  private tickCount = 0;

  /**
   * The in-world round the rate-based simulation (needs, production, consumption,
   * conversion, cart hauling) was last advanced on. Each physics frame compares it
   * to {@link clockTick}: economy steps run ONCE when the clock has moved on, so they
   * follow simulated time rather than real time — a round stalled on the LLM ages the
   * village by nothing. -1 until the first round; movement runs every frame regardless.
   */
  private lastEconomyTick = -1;

  /** Monotonic count of in-world ROUNDS advanced — drives the eat/drink cadence. */
  private roundCount = 0;

  /**
   * The in-world CLOCK tick — the turn coordinator's logical round, pushed in via
   * {@link setClockTick}. This, not the physics counter, is what stamps every world
   * snapshot and so drives the simulated date/time everywhere. Because it advances
   * only when a round completes, the clock HOLDS while a round waits on the LLM
   * instead of racing ahead on the free-running physics loop.
   */
  private clockTick = 0;

  /**
   * Short-lived STATUS NOTICES, keyed by villager id — a transient line the engine
   * wants surfaced as the villager's status (e.g. "Greenfield is dry — haul water
   * here"). Set when a `work_at` is refused, so the guidance shows as the on-map
   * bubble AND in the mind's own perceived status; consulted by the status step
   * until its `untilTick` (in clock ticks) passes, since {@link deriveStatus} would
   * otherwise overwrite the status every physics tick.
   */
  private readonly notices = new Map<string, { text: string; untilTick: number }>();

  /**
   * Per-villager running tally of a work SESSION's conversion, so `work_finished`
   * can report "farmed N water → M food". Keyed by villager id; cleared when the
   * session ends. Only the input total is tracked (output = input / ratio).
   */
  private readonly workSession = new Map<string, { inputUsed: number }>();

  /**
   * Sleepers' wake schedule, keyed by villager id: `from` is the clock round the
   * villager fell asleep, `until` the round it wakes. Present only while a villager
   * is asleep — used to drain its fatigue (power) smoothly across the night and to
   * wake it at dawn. Engine-internal; the villager carries only the `asleep` flag.
   */
  private readonly sleepUntil = new Map<string, { from: number; until: number; fatigue0: number }>();

  /** Current village-wide weather, set by the God Agent. Broadcast to observers. */
  private weather: WeatherKind = 'clear';

  /**
   * Flavour of an LLM-generated village (theme label + a sentence), carried from
   * the seed into `world.init` so the browser can show what kind of place this is.
   * Empty for the classic hand-authored village.
   */
  private readonly theme: string;
  private readonly setting: string;
  /** Themed ground colours, carried from the seed into world.init (undefined = old save). */
  private readonly palette: TerrainPalette | undefined;

  /** Monotonic counter for God-spawned entity ids, so they never collide. */
  private spawnSeq = 0;

  /** Handle for the tick interval; null while stopped. */
  private loop: ReturnType<typeof setInterval> | null = null;

  /**
   * Composition over inheritance: we OWN an emitter rather than extending it.
   * This lets us expose a fully-typed `on`/`off` surface without fighting
   * EventEmitter's loose base signatures.
   */
  private readonly emitter = new EventEmitter();

  constructor(seed: WorldSeed, options: WorldEngineOptions = {}) {
    this.width = seed.width;
    this.height = seed.height;
    this.tickRate = options.tickRate ?? 10;
    this.theme = seed.theme ?? '';
    this.setting = seed.setting ?? '';
    this.palette = seed.palette;
    this.staticOccupancy = new Uint8Array(this.width * this.height);

    // Load the seed into live state. Clone positions so external seed objects
    // (e.g. a Mongo document) are never mutated by the running simulation.
    for (const tree of seed.trees) {
      this.entities.set(tree.id, { ...tree, position: { ...tree.position } });
      this.markStatic(tree.position.x, tree.position.y);
    }
    // Buildings are static like trees, but occupy a whole rectangular footprint
    // and carry a live resource stock (normalised so old saves get sensible
    // defaults). Only the stock mutates during play; everything else is fixed.
    for (const building of seed.buildings ?? []) {
      this.entities.set(building.id, this.normaliseBuilding(building));
      this.markStaticRect(building.position.x, building.position.y, building.width, building.height);
    }
    // Heal worlds saved before the technical depot existed: every village needs one
    // (it is where the cart fleet is dispatched from), so mint one on free ground near
    // the centre when a loaded world has none. Fresh seeds already include a depot.
    this.ensureDepot();
    for (const villager of seed.villagers) {
      this.entities.set(villager.id, this.normaliseVillager(villager));
    }
    // Carts are mobile like villagers (no footprint to reserve); resume them with
    // their standing orders so a restart keeps the logistics running.
    for (const cart of seed.carts ?? []) {
      this.entities.set(cart.id, this.normaliseCart(cart));
    }

    // Rehydrate the engine's TRANSIENT state from the snapshot, so a restart
    // resumes weather, sleepers, work sessions, status notices, and the spawn
    // counter rather than starting clean. All optional (absent in fresh/old seeds).
    this.restoreTransient(seed);
  }

  /**
   * Reload the live transient maps + scalars from a persisted {@link WorldSeed}.
   * Each field is optional — a freshly generated or pre-persistence seed simply
   * leaves the corresponding state at its empty default.
   */
  private restoreTransient(seed: WorldSeed): void {
    if (seed.weather) this.weather = seed.weather;
    if (typeof seed.spawnSeq === 'number') this.spawnSeq = seed.spawnSeq;
    for (const s of seed.sleepUntil ?? []) {
      this.sleepUntil.set(s.villagerId, { from: s.from, until: s.until, fatigue0: s.fatigue0 });
    }
    for (const w of seed.workSession ?? []) {
      this.workSession.set(w.villagerId, { inputUsed: w.inputUsed });
    }
    for (const n of seed.notices ?? []) {
      this.notices.set(n.villagerId, { text: n.text, untilTick: n.untilTick });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Begin the tick loop. Emits an initial `init` event immediately. */
  start(): void {
    if (this.loop) return; // already running
    this.emit('init', this.getInitMessage());
    const intervalMs = 1000 / this.tickRate;
    this.loop = setInterval(() => this.update(), intervalMs);
  }

  /** Stop the tick loop. Safe to call when already stopped. */
  stop(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  /**
   * Advance the in-world CLOCK to a coordinator round. Called once per round (from
   * the `sim.tick` announcement); the new value is stamped on every subsequent
   * world snapshot, so the simulated date/time steps forward one round at a time and
   * holds steady while the round is busy thinking.
   */
  setClockTick(tick: number): void {
    this.clockTick = tick;
  }

  // -------------------------------------------------------------------------
  // Building activity log
  // -------------------------------------------------------------------------

  /** Stamp and emit one building activity event (clock-tick + wall-clock time). */
  private emitBuildingEvent(
    building: Building,
    kind: BuildingEventKind,
    extra: { actor?: Villager; resource?: ResourceKind; amount?: number; note?: string } = {},
  ): void {
    const { actor, resource, amount, note } = extra;
    this.emit('buildingEvent', {
      buildingId: building.id,
      buildingName: building.name,
      tick: this.clockTick,
      at: new Date().toISOString(),
      kind,
      ...(actor ? { actorId: actor.id, actorName: actor.name } : {}),
      ...(resource ? { resource } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(note ? { note } : {}),
    });
  }

  /** Emit a depleted/filled event when a stock level crosses zero or capacity. */
  private noteStockTransition(
    building: Building,
    resource: ResourceKind,
    before: number,
    after: number,
  ): void {
    if (before > 0 && after <= 0) {
      this.emitBuildingEvent(building, 'depleted', { resource });
    } else if (before < building.capacity && after >= building.capacity) {
      this.emitBuildingEvent(building, 'filled', { resource });
    }
  }

  /** Record a short-lived status notice for a villager, surfaced by deriveStatus. */
  private setNotice(villagerId: string, text: string): void {
    // Hold the notice for a few clock ticks (rounds) — long enough for the mind to
    // think at least once and read it in its own status, then it fades.
    this.notices.set(villagerId, { text, untilTick: this.clockTick + NOTICE_TTL_TICKS });
  }

  /** The active notice text for a villager, or null once it has expired. */
  private noticeFor(villagerId: string): string | null {
    const notice = this.notices.get(villagerId);
    if (!notice) return null;
    if (this.clockTick > notice.untilTick) {
      this.notices.delete(villagerId);
      return null;
    }
    return notice.text;
  }

  // -------------------------------------------------------------------------
  // The simulation step
  // -------------------------------------------------------------------------

  /**
   * Advance the world by exactly one physics tick and broadcast the new state.
   *
   * Two clocks run here. MOVEMENT (bodies walking, carts driving) is stepped every
   * physics frame so it stays smooth. The RATE-BASED economy (needs, production,
   * consumption, conversion, cart load/unload) is stepped only when the in-world
   * clock has advanced since we last ran it — so it follows simulated time, not the
   * wall clock, and a round stalled on the LLM ages the village by nothing.
   */
  private update(): void {
    // A fresh in-world ROUND has begun when the clock has moved past where the
    // economy last ran. Everything rate-based is gated on this; movement is not.
    const newRound = this.clockTick > this.lastEconomyTick;
    if (newRound) {
      this.lastEconomyTick = this.clockTick;
      this.roundCount += 1;
    }

    // The environment this round: the active weather's multipliers, and whether the
    // sun is down (night drains power faster). Computed once for the whole tick.
    const effect = WEATHER_EFFECTS[this.weather];
    const night = simTimeFromTick(this.clockTick).partOfDay === 'night';
    const fatigueMult = effect.fatigue * (night ? NIGHT_FATIGUE_MULTIPLIER : 1);

    // The sources refill, the converters turn input→output (crops grow faster in
    // the rain), and rain/storms trickle water into the cisterns — once per round.
    if (newRound) for (const building of this.buildings()) this.stepProduction(building, effect);
    // Who is in company this round — drives the small free boredom relief of being
    // among neighbours. Computed once for the whole tick rather than per villager.
    const villagers = this.villagers();
    const gathered = new Set<string>();
    for (const g of this.detectGatherings(villagers)) for (const id of g.memberIds) gathered.add(id);
    for (const villager of villagers) {
      // A villager with no power left sleeps: the body lies still and the mind goes
      // dark (the coordinator stops granting it turns). Skip its normal stepping.
      if (this.stepSleep(villager)) continue;
      this.stepTask(villager, newRound); // navigate every frame; convert once per round
      this.stepVillager(villager);
      this.stepNeeds(villager, gathered.has(villager.id), fatigueMult, effect.thirst, newRound);
    }
    // Carts run their standing orders on their own: they DRIVE every physics tick so
    // hauling stays smooth, but only load/unload (mutate stock) once per round.
    for (const cart of this.carts()) this.stepCart(cart, newRound);
    this.tickCount += 1;
    this.emit('tick', this.getStateUpdate());
  }

  /**
   * Drive one cart one tick of its standing order — the autonomous take→deposit loop.
   * Empty, it heads to the SOURCE and loads its resource; loaded, it heads to the
   * DEST and unloads; then it repeats. It DRIVES every physics tick (smooth movement)
   * but only LOADS/UNLOADS — moving real stock — once per in-world round, gated by
   * `accrue`, so hauling throughput follows simulated time like every other rate.
   * Reach (`SERVICE_REACH`), capacity, and stock mutation reuse the very same helpers
   * villagers use, so a cart and a person draw a place dry identically. When it cannot
   * make progress — the source is empty while it sits empty, or the dest is full while
   * it sits loaded — it WAITS in place and retries (the order stands until replaced).
   */
  private stepCart(cart: Cart, accrue: boolean): void {
    if (!cart.order) {
      cart.phase = 'idle';
      cart.target = null;
      cart.waitReason = null;
      return;
    }
    const { fromBuildingId, toBuildingId, resource } = cart.order;
    const from = this.entities.get(fromBuildingId);
    const to = this.entities.get(toBuildingId);
    if (!from || from.type !== 'building' || !to || to.type !== 'building') {
      cart.phase = 'waiting';
      cart.target = null;
      cart.waitReason = 'its source or destination is gone';
      return;
    }

    // Empty cart: fetch from the source. Loaded cart: deliver to the destination.
    if (cart.cargo.length === 0) {
      this.driveCart(cart, from);
      if (accrue && this.rectDistance(cart.position, from) <= SERVICE_REACH) {
        const room = cart.capacity - cart.cargo.length;
        const got = this.drawFromBuilding(from, resource, room);
        for (let i = 0; i < got; i++) cart.cargo.push(resource);
        if (got <= 0) {
          cart.phase = 'waiting';
          cart.waitReason = `${from.name} has no ${resource} to load`;
        } else {
          cart.waitReason = null; // loaded — delivers from next round
        }
      }
    } else {
      this.driveCart(cart, to);
      if (accrue && this.rectDistance(cart.position, to) <= SERVICE_REACH) {
        // A cart can deliver into a normal store OR feed a construction site the
        // material it still needs (finishing it once the last unit is in). Credit the
        // villager who dispatched the cart as the actor/finisher when still around.
        const dispatcher = cart.lastCommandedBy ? this.entities.get(cart.lastCommandedBy) : undefined;
        const actor = dispatcher && dispatcher.type === 'villager' ? dispatcher : undefined;
        const toSite = isConstructionSite(to.kind);
        const gave = toSite
          ? this.addMaterialToSite(to, resource, cart.cargo.length, actor)
          : this.depositToBuilding(to, resource, cart.cargo.length);
        cart.cargo.splice(0, gave);
        if (gave <= 0) {
          cart.phase = 'waiting';
          cart.waitReason = toSite ? `${to.name} no longer needs ${resource}` : `${to.name} is full`;
        } else {
          cart.waitReason = null;
        }
      }
    }
  }

  /**
   * Steer a cart toward a building it is servicing and take one movement step. When
   * already within reach it parks (clears its target) so loading/unloading happens in
   * place; otherwise it aims for a free tile beside the footprint and drives there.
   */
  private driveCart(cart: Cart, building: Building): void {
    const heading = cart.cargo.length === 0 ? 'toSource' : 'toDest';
    if (this.rectDistance(cart.position, building) <= SERVICE_REACH) {
      cart.target = null;
      cart.phase = heading; // arrived; the caller resolves load/unload (or sets waiting)
      return;
    }
    cart.phase = heading;
    const cx = building.position.x + building.width / 2;
    const cy = building.position.y + building.height / 2;
    cart.target = this.nearestFreeTile(cx, cy) ?? { x: Math.round(cx), y: Math.round(cy) };
    this.stepToward(cart);
  }

  /**
   * Passive production each round (the caller gates this on a fresh in-world round).
   * The WATER SOURCE is an inexhaustible spring, so it is simply kept brim-full
   * (villagers can always draw from it). A CONVERTER (Greenfield) trickles its input
   * into output on its own at the slow passive rate; a villager working there speeds
   * this up (see {@link stepTask}). Other buildings (Hall Town storage, temple,
   * houses) produce nothing on their own.
   */
  private stepProduction(building: Building, effect: WeatherEffect): void {
    const source = sourceResource(building.kind);
    if (source) {
      building.stock[source] = building.capacity;
      return;
    }
    // Rain and storms collect water in any building that stores it (Hall Town's
    // cistern, Greenfield's irrigation) — a small, free top-up the dry weathers lack.
    if (effect.rainFill > 0 && buildingStockKinds(building.kind).includes('water')) {
      const before = building.stock.water ?? 0;
      if (before < building.capacity) {
        const after = Math.min(building.capacity, before + effect.rainFill);
        building.stock.water = after;
        this.noteStockTransition(building, 'water', before, after);
      }
    }
    if (isConverter(building.kind)) {
      // Crops convert faster when watered by rain, slower in fog/heat.
      this.convert(building, PASSIVE_CONVERT_RATE * effect.crop);
    }
  }

  /**
   * Run a converter (Greenfield) for up to `maxOutput` units of output this tick:
   * spend `inputPerOutput` units of input (water) per unit of output (food),
   * bounded by the input in stock and the free space for output. Returns the
   * units of output actually produced. Shared by the passive trickle and the
   * faster hands-on work rate.
   */
  private convert(building: Building, maxOutput: number): number {
    const conv = buildingConversion(building.kind);
    if (!conv) return 0;
    const input = building.stock[conv.input] ?? 0;
    const output = building.stock[conv.output] ?? 0;
    const space = building.capacity - output;
    if (space <= 0) return 0;
    const made = Math.max(0, Math.min(maxOutput, space, input / conv.inputPerOutput));
    if (made <= 0) return 0;
    const newInput = input - made * conv.inputPerOutput;
    const newOutput = output + made;
    building.stock[conv.input] = newInput;
    building.stock[conv.output] = newOutput;
    // Log the meaningful threshold crossings (the farm running dry, or its store
    // filling) — not the per-tick trickle, which would flood the log.
    this.noteStockTransition(building, conv.input, input, newInput);
    this.noteStockTransition(building, conv.output, output, newOutput);
    return made;
  }

  /**
   * Drive a villager's standing job (a {@link VillagerTask}). The only kind today is
   * `refill`: walk to the target building if not yet beside it (NAVIGATION runs every
   * physics frame so the approach stays smooth), and once adjacent, stand still and
   * convert its stock — but the conversion (real work) advances only on a fresh
   * in-world round (`accrue`), so output follows simulated time. The task clears
   * itself when the building is full, the target is gone, or the villager has been
   * sent elsewhere (its `target` was changed by a fresh command). This is the engine
   * half of the "villagers must refill empty buildings" loop — a mind only has to
   * issue ONE `work_at`; the body sees the chore through.
   */
  private stepTask(villager: Villager, accrue: boolean): void {
    const task = villager.task;
    if (!task) return;

    const building = this.entities.get(task.buildingId);
    if (!building || building.type !== 'building') {
      villager.task = null; // the place vanished — nothing to do
      return;
    }

    const adjacent = this.rectDistance(villager.position, building) <= SERVICE_REACH;
    if (!adjacent) {
      // Not there yet: head for a free tile beside the building, unless a fresh
      // command already gave the villager somewhere else to be.
      if (!villager.target) {
        const dest = this.nearestFreeTile(
          building.position.x + building.width / 2,
          building.position.y + building.height / 2,
        );
        if (dest) villager.target = dest;
      }
      return;
    }

    // Arrived: stop walking. Work (the conversion) only advances on a fresh round.
    villager.target = null;
    if (!accrue) return;

    // Working Greenfield converts its stocked water into food at the fast hands-on
    // rate (on top of the passive trickle). The job is done when the food store is
    // full or the water has run out — there is nothing more to make. (work_at is
    // gated to converters, so there is always a conversion to run.)
    const conv = buildingConversion(building.kind);
    if (!conv) {
      villager.task = null;
      return;
    }
    const made = this.convert(building, WORKER_CONVERT_RATE);
    const session = this.workSession.get(villager.id);
    if (session) session.inputUsed += made * conv.inputPerOutput;
    const outputFull = (building.stock[conv.output] ?? 0) >= building.capacity;
    const inputGone = (building.stock[conv.input] ?? 0) < conv.inputPerOutput;
    if (outputFull || inputGone) {
      console.log(`[engine] ${villager.id} finished working ${building.name}`);
      villager.task = null;
      // Report the session as one tidy line rather than per-round conversions.
      const used = Math.round(session?.inputUsed ?? 0);
      const note =
        used > 0
          ? `farmed ${used} ${conv.input} → ${Math.round(used / conv.inputPerOutput)} ${conv.output}`
          : `stopped — ${outputFull ? `${conv.output} store full` : `no ${conv.input} left`}`;
      this.emitBuildingEvent(building, 'work_finished', { actor: villager, note });
      this.workSession.delete(villager.id);
    }
  }

  /**
   * Move a single villager one `speed` increment straight toward its target, if any.
   *
   * Villagers do NOT block one another: two may share a tile. Overlap is purely a
   * visual nicety, so the body simply walks the straight line and arrives — no
   * occupancy checks, no avoidance. (An earlier version reserved one villager per
   * tile, which made neighbours freeze on each other's path, and side-stepping to
   * avoid that made clusters "dance"; both are gone now that overlap is allowed.)
   */
  private stepVillager(villager: Villager): void {
    this.stepToward(villager);
  }

  /**
   * Move any mobile body one `speed` increment straight toward its `target`, if any,
   * snapping (and clearing the target) on arrival. Shared by villagers and carts so
   * both walk the world the same way — straight line, no occupancy checks, overlap
   * allowed (see {@link stepVillager}). Carts simply carry a larger `speed`.
   */
  private stepToward(body: { position: Vec2; target: Vec2 | null; speed: number }): void {
    if (!body.target) return;

    const dx = body.target.x - body.position.x;
    const dy = body.target.y - body.position.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= body.speed) {
      // Close enough to arrive this tick: snap exactly and stop.
      body.position.x = body.target.x;
      body.position.y = body.target.y;
      body.target = null;
      return;
    }

    body.position.x += (dx / distance) * body.speed;
    body.position.y += (dy / distance) * body.speed;
  }

  /**
   * The body's SLEEP cycle, run before any other stepping. A villager whose power
   * has run out (fatigue at {@link FATIGUE_SLEEP_THRESHOLD}) collapses into sleep
   * where it stands: it drops its target and any chore, and its mind goes dark —
   * the turn coordinator reads `asleep` off the world stream and grants it no LLM
   * turns. Sleep runs through the night to DAWN (see {@link fallAsleep}), over which
   * its power is restored; at dawn it wakes fully rested. Returns true while the
   * villager is asleep, so the caller skips its movement/needs stepping.
   */
  private stepSleep(villager: Villager): boolean {
    if (villager.asleep) {
      const sched = this.sleepUntil.get(villager.id);
      if (!sched || this.clockTick >= sched.until) {
        // Dawn: wake fully rested and rejoin the living.
        villager.asleep = false;
        this.sleepUntil.delete(villager.id);
        villager.needs.fatigue = 0;
        return false;
      }
      // Still asleep: power returns smoothly across the night, from the level the
      // villager fell asleep at down to nothing by dawn. The body stays put.
      const span = Math.max(1, sched.until - sched.from);
      const remaining = Math.max(0, sched.until - this.clockTick);
      villager.needs.fatigue = clampNeed((sched.fatigue0 * remaining) / span);
      villager.status = 'Sleeping';
      return true;
    }
    // Out of power entirely: collapse into sleep right where they stand — they
    // didn't make it home to a bed in time.
    if (villager.needs.fatigue >= FATIGUE_SLEEP_THRESHOLD) {
      this.fallAsleep(villager, 'collapsed where they stood');
      return true;
    }
    // The NORMAL recovery — and the only way to shed fatigue: sleep at a house. A
    // tired villager standing idle (no errand, no chore) beside a house turns in.
    if (
      villager.needs.fatigue >= HOUSE_SLEEP_THRESHOLD &&
      !villager.target &&
      !villager.task &&
      this.houseNear(villager.position)
    ) {
      this.fallAsleep(villager, 'went to bed at home');
      return true;
    }
    return false;
  }

  /**
   * Put a villager to sleep where it stands, scheduling its wake at the next DAWN —
   * the village sleeps through the night as one and rises together at 06:00. The
   * epoch is 06:00, so dawn ticks are exact multiples of {@link ROUNDS_PER_DAY}; we
   * floor the minimum sleep ({@link MIN_SLEEP_ROUNDS}) so a villager who collapses
   * just before dawn still gets a real rest rather than waking minutes later.
   */
  private fallAsleep(villager: Villager, why: string): void {
    villager.asleep = true;
    villager.target = null;
    villager.task = null;
    this.workSession.delete(villager.id);
    const nextDawn = (Math.floor(this.clockTick / ROUNDS_PER_DAY) + 1) * ROUNDS_PER_DAY;
    const until = Math.max(nextDawn, this.clockTick + MIN_SLEEP_ROUNDS);
    this.sleepUntil.set(villager.id, {
      from: this.clockTick,
      until,
      fatigue0: villager.needs.fatigue,
    });
    villager.status = 'Sleeping';
    console.log(`[engine] ${villager.id} ${why} and fell asleep (wakes at round ${until})`);
  }

  /** A house the villager is standing beside (within reach), or null — its bed. */
  private houseNear(p: Vec2): Building | null {
    for (const b of this.buildings()) {
      if (b.kind !== 'house') continue;
      if (this.rectDistance(p, b) <= SERVICE_REACH) return b;
    }
    return null;
  }

  /**
   * Advance one villager's needs and refresh its status line. The need CREEP and the
   * eat/drink cadence run only on a fresh in-world round (`accrue`), so they follow
   * simulated time, not the physics loop; the STATUS line is refreshed every frame so
   * a body that just arrived or finished a chore reads correctly between rounds.
   *
   * Hunger and thirst creep up; fatigue (power) grows while awake — faster walking,
   * slower idle — and is only paid back by SLEEPING (see {@link stepSleep}). Hunger
   * and thirst are relieved by CONSUMING food/water (backpack, then a stocked
   * building) — see {@link stepConsumption}.
   */
  private stepNeeds(
    villager: Villager,
    inCompany: boolean,
    fatigueMult: number,
    thirstMult: number,
    accrue: boolean,
  ): void {
    if (accrue) {
      const n = villager.needs;
      n.hunger = clampNeed(n.hunger + HUNGER_RATE);
      n.thirst = clampNeed(n.thirst + THIRST_RATE * thirstMult);
      n.fatigue = clampNeed(
        n.fatigue + (villager.target ? FATIGUE_MOVE_RATE : FATIGUE_IDLE_RATE) * fatigueMult,
      );
      n.boredom = clampNeed(n.boredom + BOREDOM_RATE);

      // Being among company eases boredom a little, for free — the simple pleasure of
      // neighbours. (The tavern eases it faster, by serving goods; see stepConsumption.)
      if (inCompany) n.boredom = clampNeed(n.boredom - GATHERING_BOREDOM_RELIEF);

      // A beautiful village is its own quiet pleasure: standing near a villager-raised
      // adornment (a monument, a lamp) eases boredom too — the payoff for building one.
      const ambience = this.ambienceNear(villager.position);
      if (ambience > 0) n.boredom = clampNeed(n.boredom - ambience);

      // Hunger, thirst & boredom: consume one unit on the consumption cadence.
      this.stepConsumption(villager);
    }

    // No building passively relieves fatigue any more — power is restored ONLY by
    // sleeping (see stepSleep). We still find a nearby house so the status line can
    // read "Resting at <house>" when a villager idles at home.
    const service = this.serviceBuildingNear(villager.position.x, villager.position.y);

    // A live notice (e.g. a refused-work nudge) overrides the derived status so the
    // guidance shows on the map and is read by the mind in its own perceived status.
    villager.status =
      this.noticeFor(villager.id) ??
      deriveStatus(villager, service, this.taskBuilding(villager), this.buildingWithinReach(villager.position));
  }

  /**
   * Eating, drinking, and unwinding. Called once per round (gated by the caller);
   * every {@link CONSUME_INTERVAL_ROUNDS} rounds a villager consumes ONE unit for
   * each resourced need that has climbed to {@link NEED_CONSUME_THRESHOLD}. Below
   * that they leave their supplies alone (so a backpack carried for hauling isn't
   * drained by a low need).
   */
  private stepConsumption(villager: Villager): void {
    if (this.roundCount % CONSUME_INTERVAL_ROUNDS !== 0) return;
    this.consumeNeed(villager, 'hunger');
    this.consumeNeed(villager, 'thirst');
    this.consumeNeed(villager, 'boredom');
  }

  /**
   * Consume one unit for a resourced need, if pressing. Hunger→food and
   * thirst→water are satisfied from the BACKPACK first (what the villager carries),
   * then from ANY adjacent building that stocks the resource — Hall Town, but also
   * the spring (water), Greenfield (food) or wherever they happen to be standing.
   * This is what keeps villagers from starving in the middle of a full village:
   * if they are beside a stocked place, they help themselves. Boredom→goods is the
   * exception — relieved only by enjoying goods AT the tavern, never from a backpack.
   */
  private consumeNeed(villager: Villager, need: keyof VillagerNeeds): void {
    if (villager.needs[need] < NEED_CONSUME_THRESHOLD) return; // not pressing yet — save supplies
    const resource = NEED_RESOURCE[need];
    if (!resource) return;

    // 1) From the backpack — what the villager carries on them. Boredom skips this:
    //    you cannot entertain yourself out of a sack of goods.
    if (need !== 'boredom') {
      const idx = villager.backpack.indexOf(resource);
      if (idx >= 0) {
        villager.backpack.splice(idx, 1);
        villager.needs[need] = clampNeed(villager.needs[need] - NEED_RELIEF_PER_UNIT);
        return;
      }
    }

    // 2) Else from an adjacent building that stocks the resource and has a unit to spare.
    const source = this.stockingBuildingNear(villager.position, resource);
    if (source) {
      source.stock[resource] = (source.stock[resource] ?? 0) - 1;
      villager.needs[need] = clampNeed(villager.needs[need] - NEED_RELIEF_PER_UNIT);
    }
  }

  /**
   * A building the villager is standing beside (within reach) that stocks
   * `resource` and has at least one unit. Storage/leisure places (Hall Town, the
   * tavern) are preferred over producers, so a casual top-up drains the larder
   * rather than a converter's fresh output, but any stocked place will do.
   */
  private stockingBuildingNear(p: Vec2, resource: ResourceKind): Building | null {
    let fallback: Building | null = null;
    for (const b of this.buildings()) {
      if (!buildingStockKinds(b.kind).includes(resource)) continue;
      if ((b.stock[resource] ?? 0) < 1) continue;
      if (this.rectDistance(p, b) > SERVICE_REACH) continue;
      if (b.kind === 'hall_town' || b.kind === 'tavern') return b;
      fallback ??= b;
    }
    return fallback;
  }

  /**
   * The total boredom relief radiating onto a point from nearby adornments — the
   * sum of every monument/lamp whose ambience reaches within {@link AMBIENCE_RADIUS}
   * tiles. Summed (not just the nearest) so a square ringed with lamps and a statue
   * is the cheeriest spot in the village. Zero when nothing adorns the area.
   */
  private ambienceNear(p: Vec2): number {
    let total = 0;
    for (const b of this.buildings()) {
      const lift = buildingAmbience(b.kind);
      if (lift <= 0) continue;
      if (this.rectDistance(p, b) <= AMBIENCE_RADIUS) total += lift;
    }
    return total;
  }

  /** The building a villager's refill task targets, if any (for status lines). */
  private taskBuilding(villager: Villager): Building | null {
    if (!villager.task) return null;
    const b = this.entities.get(villager.task.buildingId);
    return b && b.type === 'building' ? b : null;
  }

  /**
   * The nearest building whose function relieves a need that the villager is
   * close enough (within {@link SERVICE_REACH} tiles of its footprint) to use,
   * or null. Villagers never stand on a building tile — those are blocked — so
   * "use" means standing right next to it.
   */
  private serviceBuildingNear(x: number, y: number): Building | null {
    for (const b of this.buildings()) {
      if (!RELIEVES_AT[b.kind]) continue;
      if (this.rectDistance({ x, y }, b) <= SERVICE_REACH) return b;
    }
    return null;
  }

  /**
   * Any building the villager is standing right beside (within {@link SERVICE_REACH}),
   * regardless of whether it relieves a need — used only to give an idle villager a
   * place-appropriate status line ("Looking over the fields", "Standing in the square").
   * The nearest match wins. Null when standing in the open.
   */
  /**
   * True when the point is within {@link SERVICE_REACH} of a technical depot — the
   * cart-control station. From a depot a villager may set the order of ANY cart in
   * the village, so this is the gate that lets {@link handleVillagerCommandCart} skip
   * the "stand next to the cart" rule.
   */
  private atDepot(p: Vec2): boolean {
    for (const b of this.buildings()) {
      if (isDepot(b.kind) && this.rectDistance(p, b) <= SERVICE_REACH) return true;
    }
    return false;
  }

  /**
   * Ensure the world has a technical depot — the cart-control station. Worlds seeded
   * after depots existed already carry one; this mints one on clear ground near the
   * village centre for OLDER saves that predate it, so the cart fleet always has a
   * place to be dispatched from. A no-op when a depot is already present.
   */
  private ensureDepot(): void {
    if (this.buildings().some((b) => isDepot(b.kind))) return;
    const bs = this.buildings();
    const cx = bs.length
      ? Math.round(bs.reduce((s, b) => s + b.position.x + b.width / 2, 0) / bs.length)
      : Math.floor(this.width / 2);
    const cy = bs.length
      ? Math.round(bs.reduce((s, b) => s + b.position.y + b.height / 2, 0) / bs.length)
      : Math.floor(this.height / 2);
    const spec = buildableFor('depot');
    const at = this.findFreeRect(cx, cy, spec.width, spec.height);
    if (!at) {
      console.warn('[engine] ensureDepot: no clear ground near the village centre — skipped');
      return;
    }
    this.spawnSeq += 1;
    const depot: Building = {
      id: `building_depot_${this.spawnSeq}`,
      type: 'building',
      kind: 'depot',
      name: "The Cartwright's Depot",
      function: BUILDING_FUNCTIONS.depot,
      position: { x: at.x, y: at.y },
      width: spec.width,
      height: spec.height,
      color: BUILDING_COLORS.depot,
      capacity: BUILDING_CAPACITY,
      stock: {},
    };
    this.entities.set(depot.id, depot);
    this.markStaticRect(at.x, at.y, spec.width, spec.height);
    console.log(`[engine] ensureDepot: minted ${depot.name} (${depot.id}) at (${at.x}, ${at.y})`);
  }

  private buildingWithinReach(p: Vec2): Building | null {
    let best: Building | null = null;
    let bestDist = Infinity;
    for (const b of this.buildings()) {
      const d = this.rectDistance(p, b);
      if (d <= SERVICE_REACH && d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Chebyshev distance from a point to the nearest tile of a rectangular footprint.
   * Works for any positioned rectangle (a building OR a cart), so proximity checks —
   * "is this villager next to it?" — read the same whether the target is a fixed
   * building or a mobile cart.
   */
  private rectDistance(p: Vec2, b: { position: Vec2; width: number; height: number }): number {
    const ix = Math.round(p.x);
    const iy = Math.round(p.y);
    const dx = Math.max(b.position.x - ix, 0, ix - (b.position.x + b.width - 1));
    const dy = Math.max(b.position.y - iy, 0, iy - (b.position.y + b.height - 1));
    return Math.max(dx, dy);
  }

  // -------------------------------------------------------------------------
  // Command intake (transport-agnostic)
  // -------------------------------------------------------------------------

  /**
   * The ONLY way the outside world influences the simulation. A transport
   * (WebSocket today, RabbitMQ tomorrow) parses an incoming message into a
   * `ClientCommand` and hands it here. Invalid commands are ignored, never
   * thrown, so a malformed client can't crash the engine.
   */
  dispatchCommand(command: ClientCommand): void {
    switch (command.command) {
      case 'force_move':
        this.handleForceMove(command.targetId, command.x, command.y);
        return;
      case 'villager_move':
        // A villager's own intent sets the same destination a God-Hand click would.
        this.handleForceMove(command.villagerId, command.x, command.y);
        return;
      case 'spawn_entity':
        this.handleSpawnEntity(command.entityType, command.x, command.y);
        return;
      case 'set_weather':
        this.handleSetWeather(command.weather);
        return;
      case 'bless_villager':
        this.handleBlessSmite(command.villagerId, 'bless');
        return;
      case 'smite_villager':
        this.handleBlessSmite(command.villagerId, 'smite');
        return;
      case 'villager_work':
        this.handleVillagerWork(command.villagerId, command.buildingId);
        return;
      case 'villager_take':
        this.handleVillagerTake(command.villagerId, command.buildingId, command.resource);
        return;
      case 'villager_give':
        this.handleVillagerGive(command.villagerId, command.buildingId, command.resource);
        return;
      case 'villager_pray':
        this.handleVillagerPray(command.villagerId, command.buildingId, command.message);
        return;
      case 'villager_start_build':
        this.handleVillagerStartBuild(
          command.villagerId,
          command.structure,
          command.name,
          command.x,
          command.y,
          command.description,
        );
        return;
      case 'villager_command_cart':
        this.handleVillagerCommandCart(
          command.villagerId,
          command.cartId,
          command.resource,
          command.fromBuildingId,
          command.toBuildingId,
        );
        return;
      default:
        // Exhaustiveness guard: adding a ClientCommand variant without a case
        // here is now a compile error.
        return assertNever(command);
    }
  }

  private handleForceMove(targetId: string, x: number, y: number): void {
    const entity = this.entities.get(targetId);
    if (!entity || entity.type !== 'villager') {
      console.warn(`[engine] force_move: unknown villager "${targetId}" — ignored`);
      return;
    }
    // Be forgiving about the destination. A mind (or a God-Hand click) will often
    // aim AT a building — e.g. the well's centre tile — but building footprints are
    // blocked, so a literal move there is impossible. Rather than silently dropping
    // the order (which strands the villager and makes it look like it never moves),
    // snap to the nearest free, in-bounds tile, which for a building lands the
    // villager right beside it — exactly where it can use the place.
    const dest = this.nearestFreeTile(x, y);
    if (!dest) {
      console.warn(`[engine] force_move: no free tile near (${x}, ${y}) — ignored`);
      return;
    }
    entity.target = dest;
    // A fresh move order overrides any standing chore: the villager (or the God
    // Hand) wants it to go somewhere, so abandon the refill task it was on.
    entity.task = null;
  }

  /**
   * A villager's intent to WORK at a building, replenishing its resources. We
   * validate the worker and building, refuse buildings with no resource economy
   * (a house has nothing to refill), and otherwise set a `refill` task. The task
   * is then driven each tick by {@link stepTask} — walking the villager over if
   * needed and topping the place up — so this handler just records the intent.
   */
  private handleVillagerWork(villagerId: string, buildingId: string): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') {
      console.warn(`[engine] villager_work: unknown villager "${villagerId}" — ignored`);
      return;
    }
    const building = this.entities.get(buildingId);
    if (!building || building.type !== 'building') {
      console.warn(`[engine] villager_work: unknown building "${buildingId}" — ignored`);
      return;
    }
    if (!isWorkable(building.kind)) {
      // Only a CONVERTER (Greenfield) rewards labour — turning stocked water into
      // food. The water source is free-draw (take_from) and Hall Town is stocked
      // by villagers hauling to it (give_to), neither is "worked".
      console.warn(`[engine] villager_work: ${building.name} has nothing to work — ignored`);
      return;
    }
    // WORK-AVAILABILITY GUARD: a converter can only be worked when it has input to
    // convert AND room for the output. If the farm is dry (no water) or its food
    // store is full, refuse the work outright — don't send the villager to stand at
    // a dead farm. Log it and leave the villager a guiding NOTICE so its mind (and
    // the on-map bubble) sees why, and resolves it (haul water itself, or ask).
    const conv = buildingConversion(building.kind)!;
    const input = building.stock[conv.input] ?? 0;
    const output = building.stock[conv.output] ?? 0;
    if (input < conv.inputPerOutput) {
      const note = `no ${conv.input} to work`;
      console.log(`[engine] villager_work: ${building.name} has ${note} — refused`);
      this.emitBuildingEvent(building, 'work_refused', { actor: villager, note });
      this.setNotice(
        villager.id,
        `${building.name} has no ${conv.input} to work — haul ${conv.input} here, or ask someone to.`,
      );
      return;
    }
    if (output >= building.capacity) {
      const note = `${conv.output} store is full`;
      console.log(`[engine] villager_work: ${building.name}'s ${note} — refused`);
      this.emitBuildingEvent(building, 'work_refused', { actor: villager, note });
      this.setNotice(
        villager.id,
        `${building.name}'s ${conv.output} store is full — nothing to farm right now.`,
      );
      return;
    }
    villager.task = { kind: 'refill', buildingId, label: `Working the ${building.name}` };
    this.workSession.set(villager.id, { inputUsed: 0 });
    console.log(`[engine] ${villager.id} set to work ${building.name}`);
    this.emitBuildingEvent(building, 'work_started', { actor: villager });
  }

  /**
   * A villager's PRAYER at the temple — a petition to the God Agent. The prayer
   * itself reaches the Supervisor over the bus (the AgentService publishes a
   * `villager.pray` intent the aggregator folds into the nightly summary); the
   * engine just validates the supplicant is actually beside the temple and notes
   * it. Outbound divine replies through the temple are a later phase.
   */
  private handleVillagerPray(villagerId: string, buildingId: string, message: string): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') return;
    const building = this.entities.get(buildingId);
    if (!building || building.type !== 'building') return;
    if (building.kind !== 'temple') {
      console.warn(`[engine] villager_pray: ${building.name} is not a temple — ignored`);
      return;
    }
    if (this.rectDistance(villager.position, building) > SERVICE_REACH) {
      console.warn(`[engine] villager_pray: ${villager.id} is not at ${building.name} — ignored`);
      return;
    }
    console.log(`[engine] ${villager.id} prays at ${building.name}: "${message}"`);
  }

  /**
   * A villager TAKES a resource from a building into its backpack — loading up at
   * a producer to haul elsewhere. Bounded by what the building has and the free
   * space in the backpack, and only when standing next to the building.
   */
  private handleVillagerTake(villagerId: string, buildingId: string, resource: ResourceKind): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') return;
    const building = this.entities.get(buildingId);
    if (!building || building.type !== 'building') return;
    if (this.rectDistance(villager.position, building) > SERVICE_REACH) {
      console.warn(`[engine] villager_take: ${villager.id} is not next to ${building.name} — ignored`);
      return;
    }
    if (!buildingStockKinds(building.kind).includes(resource)) {
      console.warn(`[engine] villager_take: ${building.name} holds no ${resource} — ignored`);
      return;
    }
    const room = BACKPACK_CAPACITY - villager.backpack.length;
    const amount = this.drawFromBuilding(building, resource, room, villager);
    if (amount <= 0) {
      console.warn(`[engine] villager_take: nothing to take (${room} free) — ignored`);
      return;
    }
    for (let i = 0; i < amount; i++) villager.backpack.push(resource);
    console.log(`[engine] ${villager.id} took ${amount} ${resource} from ${building.name}`);
  }

  /**
   * Pull up to `room` units of `resource` OUT of a building's stock, returning how
   * many were actually drawn (0 when empty). The single place building stock is
   * decremented for hauling — villagers (`take_from`) AND carts both go through it,
   * so the `take` activity event and the depleted/filled transitions fire identically
   * no matter who emptied the place. The caller owns where the units land (a backpack
   * or a cart's cargo). `actor` rides the activity event when a villager did it.
   */
  private drawFromBuilding(
    building: Building,
    resource: ResourceKind,
    room: number,
    actor?: Villager,
  ): number {
    if (!buildingStockKinds(building.kind).includes(resource)) return 0;
    const before = building.stock[resource] ?? 0;
    const amount = Math.min(Math.max(0, Math.floor(room)), Math.floor(before));
    if (amount <= 0) return 0;
    building.stock[resource] = before - amount;
    this.emitBuildingEvent(building, 'take', { actor, resource, amount });
    this.noteStockTransition(building, resource, before, building.stock[resource] ?? 0);
    return amount;
  }

  /**
   * Push up to `count` units of `resource` INTO a building's stock, returning how
   * many fit (0 when full). The mirror of {@link drawFromBuilding} and the single
   * place stock is incremented for hauling, shared by villagers (`give_to`) and carts.
   * The caller owns removing the given units from its own store.
   */
  private depositToBuilding(
    building: Building,
    resource: ResourceKind,
    count: number,
    actor?: Villager,
  ): number {
    if (!buildingStockKinds(building.kind).includes(resource)) return 0;
    const before = building.stock[resource] ?? 0;
    const room = building.capacity - before;
    const amount = Math.min(Math.max(0, count), Math.floor(room));
    if (amount <= 0) return 0;
    building.stock[resource] = before + amount;
    this.emitBuildingEvent(building, 'give', { actor, resource, amount });
    this.noteStockTransition(building, resource, before, building.stock[resource] ?? 0);
    return amount;
  }

  /**
   * A villager GIVES carried resource to a building — dropping a haul where it is
   * needed (e.g. food into the tavern). Bounded by how much it carries and the
   * building's remaining capacity, and only when standing next to the building.
   */
  private handleVillagerGive(villagerId: string, buildingId: string, resource: ResourceKind): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') return;
    const building = this.entities.get(buildingId);
    if (!building || building.type !== 'building') return;
    if (this.rectDistance(villager.position, building) > SERVICE_REACH) {
      console.warn(`[engine] villager_give: ${villager.id} is not next to ${building.name} — ignored`);
      return;
    }
    // A construction site accepts carried MATERIALS toward its project rather than
    // stocking a resource the usual way — hand off to the build path, which also
    // finishes the structure once every material is in.
    if (isConstructionSite(building.kind) && building.construction) {
      this.contributeToSite(villager, building, resource);
      return;
    }
    if (!buildingStockKinds(building.kind).includes(resource)) {
      console.warn(`[engine] villager_give: ${building.name} cannot hold ${resource} — ignored`);
      return;
    }
    const carried = villager.backpack.filter((r) => r === resource).length;
    const amount = this.depositToBuilding(building, resource, carried, villager);
    if (amount <= 0) {
      console.warn(`[engine] villager_give: nothing to give (${carried} carried) — ignored`);
      return;
    }
    // Remove the `amount` units the building accepted from the backpack, leave the rest.
    let removed = 0;
    villager.backpack = villager.backpack.filter((r) => {
      if (r === resource && removed < amount) {
        removed++;
        return false;
      }
      return true;
    });
    console.log(`[engine] ${villager.id} gave ${amount} ${resource} to ${building.name}`);
  }

  /**
   * A villager STARTS a construction project — raising a new structure the village
   * builds together. We look up what was proposed, find a clear footprint near the
   * chosen tile, and open a `construction_site` building there: a half-built shell
   * that streams its gathered materials as stock and remembers (in `construction`)
   * what it will become. Villagers then haul stone/wood and `give_to` it (see
   * {@link contributeToSite}) until it is complete. Capped at {@link MAX_CONSTRUCTION_SITES}
   * open at once so the map can't fill with abandoned shells; a refused start leaves
   * the proposer a guiding notice rather than failing silently.
   */
  private handleVillagerStartBuild(
    villagerId: string,
    structure: BuildableId,
    name: string,
    x: number,
    y: number,
    description?: string,
  ): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') {
      console.warn(`[engine] start_build: unknown villager "${villagerId}" — ignored`);
      return;
    }
    const spec = buildableFor(structure);
    if (!spec) {
      console.warn(`[engine] start_build: unknown structure "${structure}" — ignored`);
      return;
    }
    const openSites = this.buildings().filter((b) => isConstructionSite(b.kind)).length;
    if (openSites >= MAX_CONSTRUCTION_SITES) {
      this.setNotice(
        villager.id,
        `The village already has ${openSites} building projects underway — finish one before starting another.`,
      );
      console.log(`[engine] start_build: ${openSites} sites already open — refused`);
      return;
    }
    // Find clear ground for the footprint, searching outward from the chosen tile so
    // a spot inside the forest or atop another building lands on the nearest opening.
    const at = this.findFreeRect(x, y, spec.width, spec.height);
    if (!at) {
      this.setNotice(villager.id, `There is no clear ground near (${Math.round(x)}, ${Math.round(y)}) to raise ${spec.label}.`);
      console.log(`[engine] start_build: no clear ${spec.width}x${spec.height} ground near (${x}, ${y}) — refused`);
      return;
    }
    this.spawnSeq += 1;
    const trimmed = name.trim();
    const targetName = trimmed.length > 0 ? trimmed : spec.label.replace(/^a(n)? /, '');
    const trimmedDesc = description?.trim();
    const construction: ConstructionState = {
      // A buildable raises EITHER a fixed building (`kind`) or a mobile cart
      // (`producesCart`) — carry whichever it declares through to completion.
      ...(spec.kind ? { targetKind: spec.kind } : {}),
      ...(spec.producesCart ? { targetCartTier: spec.producesCart } : {}),
      buildable: structure,
      targetName,
      // An INVENTED structure carries its description through to completion, where it
      // becomes the finished landmark's function (what villagers read about the place).
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
      required: { ...spec.cost },
    };
    const site: Building = {
      id: `building_site_${this.spawnSeq}`,
      type: 'building',
      kind: 'construction_site',
      name: `${targetName} (building site)`,
      function: BUILDING_FUNCTIONS.construction_site,
      position: { x: at.x, y: at.y },
      width: spec.width,
      height: spec.height,
      color: BUILDING_COLORS.construction_site,
      // Capacity is the biggest single material need — the progress bars read against it.
      capacity: Math.max(BUILDING_CAPACITY, ...Object.values(spec.cost)),
      stock: {}, // nothing hauled in yet
      construction,
    };
    this.entities.set(site.id, site);
    this.markStaticRect(at.x, at.y, spec.width, spec.height);
    const needs = Object.entries(spec.cost)
      .map(([r, n]) => `${n} ${r}`)
      .join(', ');
    console.log(`[engine] ${villager.id} opened a build site for "${targetName}" at (${at.x}, ${at.y}) — needs ${needs}`);
    this.emitBuildingEvent(site, 'site_opened', { actor: villager, note: `needs ${needs}` });
    // Re-announce the static world so observers learn of the new site (like a tree spawn).
    this.emit('init', this.getInitMessage());
  }

  /**
   * A villager hands carried MATERIALS to a construction site. Only the kinds the
   * project still needs are accepted, and only up to the shortfall (surplus stays in
   * the backpack). Each contribution is logged; when every required material has been
   * gathered the site is finished into its target building (see {@link completeSite}).
   */
  private contributeToSite(villager: Villager, site: Building, resource: ResourceKind): void {
    const construction = site.construction!;
    if (construction.required[resource] === undefined) {
      const wanted = Object.keys(construction.required).join('/');
      this.setNotice(villager.id, `${site.name} needs ${wanted}, not ${resource}.`);
      console.warn(`[engine] contribute: ${site.name} does not need ${resource} — ignored`);
      return;
    }
    const carried = villager.backpack.filter((r) => r === resource).length;
    const amount = this.addMaterialToSite(site, resource, carried, villager);
    if (amount <= 0) {
      console.warn(`[engine] contribute: nothing to add (${carried} carried) — ignored`);
      return;
    }
    let removed = 0;
    villager.backpack = villager.backpack.filter((r) => {
      if (r === resource && removed < amount) {
        removed++;
        return false;
      }
      return true;
    });
    console.log(`[engine] ${villager.id} added ${amount} ${resource} to ${site.name}`);
  }

  /**
   * Add hauled MATERIAL to a construction site's gathered stock, capped at what the
   * project still needs (never overfilled). When the last required unit lands the site
   * finishes into its target structure (see {@link completeSite}). Shared by villagers
   * handing materials over (`give_to`) and carts delivering to a site, so both raise a
   * building identically. Returns how many units were actually accepted; the caller
   * removes that many from its own store (backpack or cargo).
   */
  private addMaterialToSite(
    site: Building,
    resource: ResourceKind,
    count: number,
    actor?: Villager,
  ): number {
    const construction = site.construction;
    if (!construction) return 0;
    const required = construction.required[resource];
    if (required === undefined) return 0;
    const have = site.stock[resource] ?? 0;
    const shortfall = required - have;
    const amount = Math.min(Math.max(0, count), shortfall);
    if (amount <= 0) return 0;
    site.stock[resource] = have + amount;
    this.emitBuildingEvent(site, 'give', { actor, resource, amount });
    // Done when every required material has been fully gathered.
    const complete = Object.entries(construction.required).every(
      ([r, need]) => (site.stock[r as ResourceKind] ?? 0) >= (need ?? 0),
    );
    if (complete) this.completeSite(site, actor);
    return amount;
  }

  /**
   * Finish a construction site: the gathered materials become the structure. The
   * building keeps its footprint and id but takes on its target KIND — with the right
   * colour, function and a fresh (empty) resource stock — so a well begins filling, a
   * new house can be slept in, and a monument starts lifting spirits. The proposer's
   * chosen name is stamped on, the `construction` marker is cleared, and the static
   * world is re-announced so every observer re-renders the finished building.
   */
  private completeSite(site: Building, finisher?: Villager): void {
    const construction = site.construction!;
    // A cart project leaves no building behind: it spawns a mobile cart and the site
    // is removed (its ground freed). Everything below is the building case.
    if (construction.targetCartTier) {
      this.spawnCartFromSite(site, construction.targetCartTier, finisher);
      return;
    }
    const targetKind = construction.targetKind!;
    const targetName = construction.targetName;
    site.kind = targetKind;
    site.name = targetName;
    // An invented landmark wears the villagers' OWN description as its function; every
    // other kind takes the standard per-kind line.
    site.function = construction.description ?? BUILDING_FUNCTIONS[targetKind];
    site.color = BUILDING_COLORS[targetKind];
    site.capacity = BUILDING_CAPACITY;
    // A finished building starts with an EMPTY stock of whatever it now holds (a new
    // well/greenfield fills via production; a store is stocked by hauling) — the build
    // materials were spent raising it, they are not its trading stock.
    const stock: Partial<Record<ResourceKind, number>> = {};
    for (const r of buildingStockKinds(targetKind)) stock[r] = 0;
    site.stock = stock;
    delete site.construction;
    console.log(`[engine] "${targetName}" finished — now a ${targetKind}`);
    this.emitBuildingEvent(site, 'completed', { actor: finisher, note: `raised a ${targetKind}` });
    // Re-announce so observers swap the half-built shell for the finished building.
    this.emit('init', this.getInitMessage());
  }

  /**
   * Finish a CART project: unlike a building, the site leaves nothing fixed behind.
   * We park a fresh mobile {@link Cart} of the right tier on a free tile beside the
   * site, REMOVE the construction shell, and free its reserved ground so the spot can
   * be built on again. The cart spawns idle with no order — a villager sets its first
   * run with `command_cart`. The static world is re-announced to drop the shell; the
   * cart itself appears via the next per-tick state update (carts stream like villagers).
   */
  private spawnCartFromSite(site: Building, tier: CartTier, finisher?: Villager): void {
    const spec = cartSpecFor(tier);
    const centerX = site.position.x + site.width / 2;
    const centerY = site.position.y + site.height / 2;
    // The completed cart leaves the lot — log it and drop the shell, freeing its tiles.
    this.emitBuildingEvent(site, 'completed', { actor: finisher, note: `built ${spec.label}` });
    this.clearStaticRect(site.position.x, site.position.y, site.width, site.height);
    this.entities.delete(site.id);
    // Park beside the now-cleared footprint (fall back to its centre if all is blocked).
    const at = this.nearestFreeTile(centerX, centerY) ?? {
      x: Math.round(centerX),
      y: Math.round(centerY),
    };
    this.spawnSeq += 1;
    // Number carts of this tier so names read "Handcart 1", "Handcart 2", …
    const ordinal = this.carts().filter((c) => c.tier === tier).length + 1;
    const cart: Cart = {
      id: `cart_${this.spawnSeq}`,
      type: 'cart',
      name: `${spec.label} ${ordinal}`,
      tier,
      width: spec.width,
      height: spec.height,
      position: { x: at.x, y: at.y },
      target: null,
      color: spec.color,
      speed: spec.speed,
      capacity: spec.capacity,
      cargo: [],
      order: null,
      phase: 'idle',
      waitReason: null,
      lastCommandedBy: finisher?.id ?? null,
    };
    this.entities.set(cart.id, cart);
    console.log(`[engine] "${site.construction?.targetName ?? cart.name}" finished — ${cart.name} (${cart.id}) rolls out`);
    this.emit('init', this.getInitMessage());
  }

  /**
   * A villager SETS or REPLACES a nearby cart's standing order — the single
   * take→deposit loop it then runs on its own. Validated like the other villager
   * intents (each refusal leaves a notice the mind reads next turn): the villager
   * must be beside the cart, both buildings must exist, the source must stock the
   * resource and the destination must accept it, and the two must differ. Changing
   * the resource empties whatever the cart was carrying (it cannot mix loads).
   */
  private handleVillagerCommandCart(
    villagerId: string,
    cartId: string,
    resource: ResourceKind,
    fromBuildingId: string,
    toBuildingId: string,
  ): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') return;
    const cart = this.entities.get(cartId);
    if (!cart || cart.type !== 'cart') {
      this.setNotice(villager.id, `There is no cart "${cartId}" to command.`);
      console.warn(`[engine] command_cart: unknown cart "${cartId}" — ignored`);
      return;
    }
    // A villager normally sets a cart's order standing beside it — but from the
    // technical depot they may dispatch ANY cart in the village, wherever it is.
    const beside = this.rectDistance(villager.position, cart) <= SERVICE_REACH;
    if (!beside && !this.atDepot(villager.position)) {
      this.setNotice(
        villager.id,
        `Stand next to ${cart.name} — or at the depot — to give it an order.`,
      );
      console.warn(`[engine] command_cart: ${villager.id} is neither next to ${cart.name} nor at a depot — ignored`);
      return;
    }
    if (fromBuildingId === toBuildingId) {
      this.setNotice(villager.id, `A cart's pickup and drop-off must be different places.`);
      return;
    }
    const from = this.entities.get(fromBuildingId);
    const to = this.entities.get(toBuildingId);
    if (!from || from.type !== 'building' || !to || to.type !== 'building') {
      this.setNotice(villager.id, `${cart.name} needs a real place to take from and to give to.`);
      console.warn(`[engine] command_cart: bad buildings ${fromBuildingId}->${toBuildingId} — ignored`);
      return;
    }
    if (!buildingStockKinds(from.kind).includes(resource)) {
      this.setNotice(villager.id, `${from.name} has no ${resource} to load — pick a place that holds it.`);
      return;
    }
    // A cart may deliver to a normal store that stocks the resource, OR to a
    // construction site that still needs this material — so a single dispatch from
    // the depot (e.g. quarry → building site) can feed a project to completion.
    const siteNeeds =
      isConstructionSite(to.kind) && to.construction !== undefined && to.construction.required[resource] !== undefined;
    if (!siteNeeds && !buildingStockKinds(to.kind).includes(resource)) {
      this.setNotice(villager.id, `${to.name} cannot hold ${resource} — pick a place that stocks it.`);
      return;
    }
    // Switching what it hauls clears any old cargo (a cart carries one kind at a time).
    if (cart.cargo.some((r) => r !== resource)) cart.cargo = [];
    cart.order = { fromBuildingId, toBuildingId, resource };
    cart.lastCommandedBy = villager.id;
    cart.phase = 'idle';
    cart.waitReason = null;
    cart.target = null;
    console.log(
      `[engine] ${villager.id} set ${cart.name}: haul ${resource} ${from.name} -> ${to.name}`,
    );
  }

  /**
   * Search outward from (x, y) for a top-left corner where a `w`×`h` footprint of
   * tiles is entirely in-bounds and unoccupied (no tree, building or other site).
   * Returns that corner, or null if nowhere clear is within range. Used to place a
   * construction site forgivingly — a mind names a rough spot and we find real room.
   */
  private findFreeRect(x: number, y: number, w: number, h: number): { x: number; y: number } | null {
    const cx = Math.round(x) - Math.floor(w / 2);
    const cy = Math.round(y) - Math.floor(h / 2);
    const maxRadius = 30;
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
          if (this.rectIsFree(cx + dx, cy + dy, w, h)) return { x: cx + dx, y: cy + dy };
        }
      }
    }
    return null;
  }

  /** True when every tile of the `w`×`h` footprint at (x0, y0) is in-bounds and free. */
  private rectIsFree(x0: number, y0: number, w: number, h: number): boolean {
    if (x0 < 0 || y0 < 0 || x0 + w > this.width || y0 + h > this.height) return false;
    for (let yy = y0; yy < y0 + h; yy++) {
      for (let xx = x0; xx < x0 + w; xx++) {
        if (this.staticOccupancy[yy * this.width + xx] !== 0) return false;
      }
    }
    return true;
  }

  /**
   * The nearest in-bounds, unoccupied tile to (x, y), searched outward in rings.
   * Returns the tile itself when it is already free, or null if the whole local
   * area is blocked (never expected on a sane map). Used to make movement orders
   * forgiving: a target inside a building footprint resolves to a tile beside it.
   */
  private nearestFreeTile(x: number, y: number): { x: number; y: number } | null {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const maxRadius = 8; // a building half-footprint plus margin; plenty in practice
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
          const tx = cx + dx;
          const ty = cy + dy;
          if (this.isValidDestination(tx, ty)) return { x: tx, y: ty };
        }
      }
    }
    return null;
  }

  /**
   * God-Villager intervention: introduce a new entity at (x, y). A tree joins the
   * static terrain (and re-announces `init` so observers learn of it, since the
   * per-tick payload carries only villagers); a spawned villager is picked up by the
   * very next tick automatically. Invalid tiles are ignored, never thrown.
   */
  private handleSpawnEntity(entityType: 'villager' | 'tree', x: number, y: number): void {
    if (!this.isValidDestination(x, y)) {
      console.warn(`[engine] spawn_entity: invalid tile (${x}, ${y}) — ignored`);
      return;
    }
    const ix = Math.round(x);
    const iy = Math.round(y);
    this.spawnSeq += 1;

    if (entityType === 'tree') {
      const tree: Tree = { id: `tree_spawn_${this.spawnSeq}`, type: 'tree', position: { x: ix, y: iy } };
      this.entities.set(tree.id, tree);
      this.markStatic(ix, iy);
      console.log(`[engine] God spawned ${tree.id} at (${ix}, ${iy})`);
      // Re-announce the static world so observers pick up the new tree.
      this.emit('init', this.getInitMessage());
      return;
    }

    const color = SPAWN_VILLAGER_COLORS[this.spawnSeq % SPAWN_VILLAGER_COLORS.length]!;
    const spawnId = `villager_spawn_${this.spawnSeq}`;
    const villager: Villager = {
      id: spawnId,
      name: 'Newcomer',
      type: 'villager',
      position: { x: ix, y: iy },
      target: null,
      color,
      // A deterministic look so a God-spawned newcomer reads as a distinct figure.
      appearance: deriveAppearance(spawnId, color),
      speed: 2,
      status: 'Idle',
      needs: defaultNeeds(),
      backpack: [],
      task: null,
      asleep: false,
    };
    this.entities.set(villager.id, villager);
    console.log(`[engine] God spawned ${villager.id} at (${ix}, ${iy})`);
    // No init needed: the next tick's state update already includes this villager.
  }

  /**
   * A divine BLESSING or SMITING of one villager. A blessing eases every need to
   * nothing and rouses a sleeper, fully restored; a smiting spikes every need
   * toward distress, so the villager must scramble to recover. Both are clamped
   * to the 0..100 range and leave the body where it stands.
   */
  private handleBlessSmite(villagerId: string, kind: 'bless' | 'smite'): void {
    const villager = this.entities.get(villagerId);
    if (!villager || villager.type !== 'villager') {
      console.warn(`[engine] ${kind}: unknown villager "${villagerId}" — ignored`);
      return;
    }
    const n = villager.needs;
    if (kind === 'bless') {
      n.hunger = 0;
      n.thirst = 0;
      n.fatigue = 0;
      n.boredom = 0;
      // A blessing also wakes a sleeper, fully rested.
      if (villager.asleep) {
        villager.asleep = false;
        this.sleepUntil.delete(villager.id);
      }
      console.log(`[engine] God blessed ${villager.id} — needs restored`);
    } else {
      n.hunger = clampNeed(n.hunger + 45);
      n.thirst = clampNeed(n.thirst + 45);
      n.fatigue = clampNeed(n.fatigue + 45);
      n.boredom = clampNeed(n.boredom + 45);
      console.log(`[engine] God smote ${villager.id} — hardship visited`);
    }
  }

  /** God-Villager intervention: set the village-wide weather and broadcast it. */
  private handleSetWeather(weather: WeatherKind): void {
    if (weather === this.weather) return; // no-op, don't spam observers
    this.weather = weather;
    console.log(`[engine] God set weather to "${weather}"`);
    this.emit('weather', weather);
  }

  /** A destination is valid when in-bounds and not occupied by a tree. */
  private isValidDestination(x: number, y: number): boolean {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return false;
    return this.staticOccupancy[iy * this.width + ix] === 0;
  }

  // -------------------------------------------------------------------------
  // Snapshots & messages (consumed by transports and the persistence layer)
  // -------------------------------------------------------------------------

  /** Build the one-time connect payload (dimensions + static terrain). */
  getInitMessage(): WorldInitMessage {
    return {
      kind: 'world.init',
      width: this.width,
      height: this.height,
      tickRate: this.tickRate,
      trees: this.trees().map((t) => this.cloneTree(t)),
      buildings: this.buildings().map((b) => this.cloneBuilding(b)),
      weather: this.weather,
      ...(this.theme ? { theme: this.theme } : {}),
      ...(this.setting ? { setting: this.setting } : {}),
      ...(this.palette ? { palette: this.palette } : {}),
    };
  }

  /** Build the lightweight per-tick payload (moving villagers + social clusters). */
  getStateUpdate(): WorldStateUpdate {
    const villagers = this.villagers();
    return {
      kind: 'world.state_update',
      // The in-world clock follows the round tick, not the physics counter, so time
      // holds while a round waits on the LLM (see `clockTick`).
      tick: this.clockTick,
      villagers: villagers.map((a) => this.cloneVillager(a)),
      carts: this.carts().map((c) => this.cloneCart(c)),
      gatherings: this.detectGatherings(villagers),
      buildingStocks: this.buildingStocks(),
    };
  }

  /** The live stock of every building that has a resource economy (others omitted). */
  private buildingStocks(): BuildingStock[] {
    const out: BuildingStock[] = [];
    for (const b of this.buildings()) {
      // Construction sites stream their gathered MATERIALS (held in `stock`) so the
      // progress shows live, even though they have no static stock-kind table.
      if (buildingStockKinds(b.kind).length === 0 && !isConstructionSite(b.kind)) continue;
      out.push({ id: b.id, stock: { ...b.stock } });
    }
    return out;
  }

  /**
   * Find every GATHERING this tick: a connected cluster (proximity graph, edge =
   * within {@link GATHERING_RADIUS} tiles) of {@link MIN_GATHERING}+ villagers.
   * A simple union-find over the (handful of) villagers is plenty here. Each
   * cluster reports its members, centroid, and the nearest building's name.
   */
  private detectGatherings(villagers: Villager[]): Gathering[] {
    const n = villagers.length;
    if (n < MIN_GATHERING) return [];

    // Union-find: link any two villagers standing within the radius of each other.
    const parent = villagers.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root]!;
      while (parent[i] !== root) {
        const next = parent[i]!;
        parent[i] = root;
        i = next;
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      parent[find(a)] = find(b);
    };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = villagers[i]!.position;
        const b = villagers[j]!.position;
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= GATHERING_RADIUS) union(i, j);
      }
    }

    // Bucket villagers by cluster root.
    const clusters = new Map<number, Villager[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(villagers[i]!);
    }

    const gatherings: Gathering[] = [];
    for (const members of clusters.values()) {
      if (members.length < MIN_GATHERING) continue;
      const memberIds = members.map((m) => m.id).sort();
      const center: Vec2 = {
        x: members.reduce((s, m) => s + m.position.x, 0) / members.length,
        y: members.reduce((s, m) => s + m.position.y, 0) / members.length,
      };
      const building = this.serviceBuildingNear(center.x, center.y) ?? this.buildingAt(center.x, center.y);
      gatherings.push({
        id: `gathering_${memberIds.join('_')}`,
        memberIds,
        center,
        place: building?.name ?? null,
      });
    }
    return gatherings;
  }

  /** The building whose footprint contains (x, y), or null. For naming a gathering's place. */
  private buildingAt(x: number, y: number): Building | null {
    const ix = Math.round(x);
    const iy = Math.round(y);
    for (const b of this.buildings()) {
      if (ix >= b.position.x && ix < b.position.x + b.width && iy >= b.position.y && iy < b.position.y + b.height) {
        return b;
      }
    }
    return null;
  }

  /**
   * Build a full, persistable snapshot of the live world. Used by the
   * persistence layer to write to MongoDB. Returns deep copies so callers can
   * serialize at leisure without racing the tick loop.
   */
  getSnapshot(): WorldSeed {
    return {
      width: this.width,
      height: this.height,
      trees: this.trees().map((t) => this.cloneTree(t)),
      buildings: this.buildings().map((b) => this.cloneBuilding(b)),
      villagers: this.villagers().map((a) => this.cloneVillager(a)),
      carts: this.carts().map((c) => this.cloneCart(c)),
      // Persist the in-world clock so a restart resumes simulated time, not Day 1.
      clock: this.clockTick,
      // Static FLAVOUR fields. The snapshot REPLACES the whole world document on
      // every save, so these must be re-emitted here or they'd be wiped from the
      // DB after the first snapshot — leaving a restart with the wrong ground
      // colours (palette) and a missing theme/setting.
      ...(this.theme ? { theme: this.theme } : {}),
      ...(this.setting ? { setting: this.setting } : {}),
      ...(this.palette ? { palette: this.palette } : {}),
      // Transient state, so a restart resumes weather/sleep/work/notices in place.
      weather: this.weather,
      spawnSeq: this.spawnSeq,
      sleepUntil: [...this.sleepUntil.entries()].map(([villagerId, s]) => ({
        villagerId,
        from: s.from,
        until: s.until,
        fatigue0: s.fatigue0,
      })),
      workSession: [...this.workSession.entries()].map(([villagerId, w]) => ({
        villagerId,
        inputUsed: w.inputUsed,
      })),
      notices: [...this.notices.entries()].map(([villagerId, n]) => ({
        villagerId,
        text: n.text,
        untilTick: n.untilTick,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Typed event surface
  // -------------------------------------------------------------------------

  on<K extends EventName>(event: K, listener: WorldEngineEvents[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends EventName>(event: K, listener: WorldEngineEvents[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private emit<K extends EventName>(
    event: K,
    ...args: Parameters<WorldEngineEvents[K]>
  ): void {
    this.emitter.emit(event, ...args);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private markStatic(x: number, y: number): void {
    this.setStatic(x, y, 1);
  }

  /** Release one tile back to free ground (the inverse of {@link markStatic}). */
  private clearStatic(x: number, y: number): void {
    this.setStatic(x, y, 0);
  }

  private setStatic(x: number, y: number, value: 0 | 1): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && iy >= 0 && ix < this.width && iy < this.height) {
      this.staticOccupancy[iy * this.width + ix] = value;
    }
  }

  /** Mark every tile of a building's footprint as occupied. */
  private markStaticRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let yy = y0; yy < y0 + h; yy++) {
      for (let xx = x0; xx < x0 + w; xx++) {
        this.markStatic(xx, yy);
      }
    }
  }

  /**
   * Release every tile of a footprint back to free ground — the inverse of
   * {@link markStaticRect}. Used when a construction site that spawns a MOBILE cart
   * completes: the site leaves no building behind, so its reserved ground must be
   * freed or future builds would treat it as permanently blocked.
   */
  private clearStaticRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let yy = y0; yy < y0 + h; yy++) {
      for (let xx = x0; xx < x0 + w; xx++) {
        this.clearStatic(xx, yy);
      }
    }
  }

  /** Live villagers as a typed array. */
  private villagers(): Villager[] {
    const result: Villager[] = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'villager') result.push(entity);
    }
    return result;
  }

  /** Live trees as a typed array. */
  private trees(): Tree[] {
    const result: Tree[] = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'tree') result.push(entity);
    }
    return result;
  }

  private cloneVillager(a: Villager): Villager {
    return {
      ...a,
      position: { ...a.position },
      target: a.target ? { ...a.target } : null,
      needs: { ...a.needs },
      backpack: [...a.backpack],
      task: a.task ? { ...a.task } : null,
    };
  }

  /**
   * Deep-copy a seed/spawn villager into live state, filling in any of the
   * Phase-stat fields a source might lack (a hand-written test seed, or a world
   * document saved before needs existed). Positions are cloned so external seed
   * objects are never mutated by the running simulation.
   */
  private normaliseVillager(v: Villager): Villager {
    return {
      ...v,
      name: v.name ?? v.id,
      position: { ...v.position },
      target: v.target ? { ...v.target } : null,
      status: v.status ?? 'Idle',
      // Merge over defaults so a save predating a need (e.g. boredom) still normalises.
      needs: { ...defaultNeeds(), ...(v.needs ?? {}) },
      backpack: Array.isArray(v.backpack) ? v.backpack.slice(0, BACKPACK_CAPACITY) : [],
      task: v.task ? { ...v.task } : null,
      // A villager resumed from a save wakes for the new session; the in-memory
      // wake schedule doesn't survive a restart, so never start a body mid-sleep.
      asleep: false,
    };
  }

  private cloneTree(t: Tree): Tree {
    return { ...t, position: { ...t.position } };
  }

  /** Live buildings as a typed array. */
  private buildings(): Building[] {
    const result: Building[] = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'building') result.push(entity);
    }
    return result;
  }

  private cloneBuilding(b: Building): Building {
    return {
      ...b,
      position: { ...b.position },
      stock: { ...b.stock },
      ...(b.construction
        ? { construction: { ...b.construction, required: { ...b.construction.required } } }
        : {}),
    };
  }

  /**
   * Deep-copy a seed building into live state, filling in the resource fields a
   * source might lack — a hand-written test seed, or a world document saved before
   * the resource economy existed. Missing stock defaults to FULL so a resumed
   * village starts stocked rather than instantly starving; positions are cloned so
   * external seed objects are never mutated by the running simulation.
   */
  private normaliseBuilding(b: Building): Building {
    const capacity = b.capacity ?? BUILDING_CAPACITY;
    // A construction site is mid-project: keep the materials hauled in so far and the
    // project record exactly, rather than defaulting an empty larder to full.
    if (isConstructionSite(b.kind) && b.construction) {
      return {
        ...b,
        position: { ...b.position },
        capacity,
        stock: { ...(b.stock ?? {}) },
        construction: { ...b.construction, required: { ...b.construction.required } },
      };
    }
    const stock: Partial<Record<ResourceKind, number>> = {};
    for (const resource of buildingStockKinds(b.kind)) {
      stock[resource] = b.stock?.[resource] ?? capacity;
    }
    return { ...b, position: { ...b.position }, capacity, stock };
  }

  /** Live carts as a typed array. */
  private carts(): Cart[] {
    const result: Cart[] = [];
    for (const entity of this.entities.values()) {
      if (entity.type === 'cart') result.push(entity);
    }
    return result;
  }

  private cloneCart(c: Cart): Cart {
    return {
      ...c,
      position: { ...c.position },
      target: c.target ? { ...c.target } : null,
      cargo: [...c.cargo],
      order: c.order ? { ...c.order } : null,
    };
  }

  /**
   * Deep-copy a saved cart into live state, backfilling its tier stats from
   * {@link CART_SPECS} (so a save predating a tweak adopts the new capacity/colour)
   * and clamping cargo to capacity. A resumed cart starts `idle` rather than mid-drive
   * or mid-wait — its next tick re-evaluates the standing order cleanly (mirrors how a
   * resumed villager wakes rather than resuming mid-sleep).
   */
  private normaliseCart(c: Cart): Cart {
    const spec = cartSpecFor(c.tier);
    const capacity = c.capacity ?? spec.capacity;
    const cargo = Array.isArray(c.cargo) ? c.cargo.slice(0, capacity) : [];
    return {
      ...c,
      position: { ...c.position },
      target: null,
      width: c.width ?? spec.width,
      height: c.height ?? spec.height,
      color: c.color ?? spec.color,
      speed: c.speed ?? spec.speed,
      capacity,
      cargo,
      order: c.order ? { ...c.order } : null,
      phase: 'idle',
      waitReason: null,
      lastCommandedBy: c.lastCommandedBy ?? null,
    };
  }
}

/** Compile-time exhaustiveness helper: unreachable at runtime for closed unions. */
function assertNever(value: never): void {
  console.warn('[engine] ignored unknown command:', value);
}

/**
 * A short, human line for what the villager is doing this tick. Priority: a
 * standing chore (refilling a building) reads first, then using a service
 * building — noting when the place has run dry — then travel, then idle.
 */
function deriveStatus(
  villager: Villager,
  service: Building | null,
  taskBuilding: Building | null,
  nearBuilding: Building | null,
): string {
  if (villager.task?.kind === 'refill' && taskBuilding) {
    const verb = workVerb(taskBuilding.kind);
    const levels = buildingStockKinds(taskBuilding.kind)
      .map((r) => `${r} ${Math.round(taskBuilding.stock[r] ?? 0)}/${taskBuilding.capacity}`)
      .join(', ');
    return `${capitalize(verb)} at ${taskBuilding.name} (${levels})`;
  }
  if (service) {
    // Fatigue is the only need served by lingering at a building; today that is a
    // house, where a villager rests.
    if (service.kind === 'house') {
      return `Resting at ${service.name}`;
    }
    return `At the ${service.name}`;
  }
  if (villager.target) {
    return `Walking to (${Math.round(villager.target.x)}, ${Math.round(villager.target.y)})`;
  }
  // Idle but standing beside a place: colour the status with what one would be doing
  // there, so a resting villager reads as part of the scene rather than a bare "Idle".
  if (nearBuilding) {
    return idleStatusAt(nearBuilding);
  }
  return 'Idle';
}

/** A place-appropriate idle status for a villager loitering beside a building. */
function idleStatusAt(building: Building): string {
  switch (building.kind) {
    case 'water_source':
      return `Resting by ${building.name}`;
    case 'greenfield':
      return `Looking over the fields at ${building.name}`;
    case 'lumber_source':
      return `Gathering wood at ${building.name}`;
    case 'workshop':
      return `Looking over the work at ${building.name}`;
    case 'hall_town':
      return `Standing in the square by ${building.name}`;
    case 'tavern':
      return `Relaxing at ${building.name}`;
    case 'temple':
      return `Pausing at the steps of ${building.name}`;
    case 'house':
      return `Sitting outside ${building.name}`;
    case 'quarry':
      return `Cutting stone at ${building.name}`;
    case 'construction_site':
      return `Working on ${building.name}`;
    case 'monument':
      return `Admiring ${building.name}`;
    case 'lamp':
      return `Resting in the glow of ${building.name}`;
    default:
      return `Lingering by ${building.name}`;
  }
}

/** Capitalise the first letter of a string (for status lines built from verbs). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
