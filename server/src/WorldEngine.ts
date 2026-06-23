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
  WeatherKind,
  WorldInitMessage,
  WorldSeed,
  WorldStateUpdate,
} from '../../shared/types';
import { BACKPACK_CAPACITY } from '../../shared/types';
import {
  AMBIENCE_RADIUS,
  BUILDING_CAPACITY,
  BUILDING_COLORS,
  BUILDING_FUNCTIONS,
  cartSpecFor,
  NEED_RESOURCE,
  CONSUME_INTERVAL_TICKS,
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

/** How fast hunger and thirst creep up every tick. */
const HUNGER_RATE = 0.04;
const THIRST_RATE = 0.06;
/**
 * Fatigue is the villager's POWER, spent by being awake. It grows faster while
 * walking and slower while idle, but it always grows: staying awake costs power.
 * The ONLY way to pay it back is to SLEEP (see {@link WorldEngine.stepSleep}) — a
 * tired villager sleeps at a house, and one that runs all the way out collapses
 * into a forced sleep where it stands. No building passively rests you any more.
 */
const FATIGUE_MOVE_RATE = 0.05;
const FATIGUE_IDLE_RATE = 0.02;

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
 * A full night's sleep, in coordinator ROUNDS (the in-world clock's unit): about
 * 7 in-world hours. The clock advances one round at a time, so a sleeper wakes
 * after this many rounds have elapsed regardless of how long each took in real time.
 */
const SLEEP_ROUNDS = Math.round((7 * 3600) / SIM_SECONDS_PER_TICK);
/** How fast boredom creeps up every tick — the daily dullness that pulls a villager toward company and the tavern. */
const BOREDOM_RATE = 0.03;
/**
 * How much boredom eases per tick while a villager stands in a GATHERING (company).
 * A gentle, free relief so socializing has a payoff — and so that, once boredom is
 * low, the urge to keep chatting fades on its own (a natural brake on idle talk).
 */
const GATHERING_BOREDOM_RELIEF = 0.4;

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
// MULTIPLIERS on the core rates, plus a small per-tick `rainFill` of water into
// the village's cisterns (rain and storms top up the stores the crops drink).
// ---------------------------------------------------------------------------

interface WeatherEffect {
  /** Multiplier on Greenfield's passive crop conversion (rain waters the field). */
  crop: number;
  /** Multiplier on fatigue accrual (a storm is exhausting; clear skies are easy). */
  fatigue: number;
  /** Multiplier on thirst accrual (cool rain slows it; a heatwave drives it up). */
  thirst: number;
  /** Units of water rained into each water-stocking building per tick (0 = none). */
  rainFill: number;
}

const WEATHER_EFFECTS: Record<WeatherKind, WeatherEffect> = {
  clear: { crop: 1, fatigue: 1, thirst: 1, rainFill: 0 },
  rain: { crop: 1.6, fatigue: 1, thirst: 0.6, rainFill: 0.05 },
  storm: { crop: 1.8, fatigue: 1.5, thirst: 0.6, rainFill: 0.09 },
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
   * Monotonic PHYSICS tick counter since `start()`. Drives the real-time mechanics
   * that must keep running smoothly between rounds — body movement, needs creep,
   * production, the eat/drink cadence. NOT the in-world clock (see `clockTick`).
   */
  private tickCount = 0;

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
    for (const villager of seed.villagers) {
      this.entities.set(villager.id, this.normaliseVillager(villager));
    }
    // Carts are mobile like villagers (no footprint to reserve); resume them with
    // their standing orders so a restart keeps the logistics running.
    for (const cart of seed.carts ?? []) {
      this.entities.set(cart.id, this.normaliseCart(cart));
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

  /** Advance the world by exactly one tick and broadcast the new state. */
  private update(): void {
    // The environment this tick: the active weather's multipliers, and whether the
    // sun is down (night drains power faster). Computed once for the whole tick.
    const effect = WEATHER_EFFECTS[this.weather];
    const night = simTimeFromTick(this.clockTick).partOfDay === 'night';
    const fatigueMult = effect.fatigue * (night ? NIGHT_FATIGUE_MULTIPLIER : 1);

    // The sources refill, the converters turn input→output (crops grow faster in
    // the rain), and rain/storms trickle water into the cisterns.
    for (const building of this.buildings()) this.stepProduction(building, effect);
    // Who is in company this tick — drives the small free boredom relief of being
    // among neighbours. Computed once for the whole tick rather than per villager.
    const villagers = this.villagers();
    const gathered = new Set<string>();
    for (const g of this.detectGatherings(villagers)) for (const id of g.memberIds) gathered.add(id);
    for (const villager of villagers) {
      // A villager with no power left sleeps: the body lies still and the mind goes
      // dark (the coordinator stops granting it turns). Skip its normal stepping.
      if (this.stepSleep(villager)) continue;
      this.stepTask(villager); // may steer movement / work a building this tick
      this.stepVillager(villager);
      this.stepNeeds(villager, gathered.has(villager.id), fatigueMult, effect.thirst);
    }
    // Carts run their standing orders on their own, every physics tick — they keep
    // hauling even while minds wait on the LLM between rounds.
    for (const cart of this.carts()) this.stepCart(cart);
    this.tickCount += 1;
    this.emit('tick', this.getStateUpdate());
  }

  /**
   * Drive one cart one tick of its standing order — the autonomous take→deposit loop.
   * Empty, it heads to the SOURCE and loads its resource; loaded, it heads to the
   * DEST and unloads; then it repeats. Movement, reach (`SERVICE_REACH`), capacity,
   * and stock mutation reuse the very same helpers villagers use, so a cart and a
   * person draw a place dry identically. When it cannot make progress — the source is
   * empty while it sits empty, or the dest is full while it sits loaded — it WAITS in
   * place and retries every tick (the order stands until a villager replaces it).
   */
  private stepCart(cart: Cart): void {
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
      if (this.rectDistance(cart.position, from) <= SERVICE_REACH) {
        const room = cart.capacity - cart.cargo.length;
        const got = this.drawFromBuilding(from, resource, room);
        for (let i = 0; i < got; i++) cart.cargo.push(resource);
        if (got <= 0) {
          cart.phase = 'waiting';
          cart.waitReason = `${from.name} has no ${resource} to load`;
        } else {
          cart.waitReason = null; // loaded — delivers from next tick
        }
      }
    } else {
      this.driveCart(cart, to);
      if (this.rectDistance(cart.position, to) <= SERVICE_REACH) {
        const gave = this.depositToBuilding(to, resource, cart.cargo.length);
        cart.cargo.splice(0, gave);
        if (gave <= 0) {
          cart.phase = 'waiting';
          cart.waitReason = `${to.name} is full`;
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
   * Passive production each tick. The WATER SOURCE is an inexhaustible spring, so
   * it is simply kept brim-full (villagers can always draw from it). A CONVERTER
   * (Greenfield) trickles its input into output on its own at the slow passive
   * rate; a villager working there speeds this up (see {@link stepTask}). Other
   * buildings (Hall Town storage, temple, houses) produce nothing on their own.
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
   * Drive a villager's standing job (a {@link VillagerTask}) one tick. The only
   * kind today is `refill`: walk to the target building if not yet beside it, and
   * once adjacent, stand still and top up its stock a little each tick. The task
   * clears itself when the building is full, the target is gone, or the villager
   * has been sent elsewhere (its `target` was changed by a fresh command). This is
   * the engine half of the "villagers must refill empty buildings" loop — a mind
   * only has to issue ONE `work_at`; the body sees the chore through.
   */
  private stepTask(villager: Villager): void {
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

    // Arrived: stop walking and work. Working Greenfield converts its stocked
    // water into food at the fast hands-on rate (on top of the passive trickle).
    // The job is done when the food store is full or the water has run out — there
    // is nothing more to make. (work_at is gated to converters, so there is always
    // a conversion to run.)
    villager.target = null;
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
      // Report the session as one tidy line rather than per-tick conversions.
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
   * turns. Sleep lasts {@link SLEEP_ROUNDS} clock rounds (~7 in-world hours), over
   * which its power is restored; at dawn it wakes fully rested. Returns true while
   * the villager is asleep, so the caller skips its movement/needs stepping.
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

  /** Put a villager to sleep where it stands, scheduling its dawn wake (~7h on). */
  private fallAsleep(villager: Villager, why: string): void {
    villager.asleep = true;
    villager.target = null;
    villager.task = null;
    this.workSession.delete(villager.id);
    this.sleepUntil.set(villager.id, {
      from: this.clockTick,
      until: this.clockTick + SLEEP_ROUNDS,
      fatigue0: villager.needs.fatigue,
    });
    villager.status = 'Sleeping';
    console.log(`[engine] ${villager.id} ${why} and fell asleep (wakes at round ${this.clockTick + SLEEP_ROUNDS})`);
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
   * Advance one villager's needs by a tick and refresh its status line. Hunger
   * and thirst always creep up; fatigue (power) always grows while awake — faster
   * walking, slower idle — and is only paid back by RESTING at a house or by
   * SLEEPING once it runs out (see {@link stepSleep}). Hunger and thirst are
   * relieved by CONSUMING food/water (from the backpack, then Hall Town) — see
   * {@link stepConsumption}. The status line reports whichever is happening.
   */
  private stepNeeds(
    villager: Villager,
    inCompany: boolean,
    fatigueMult: number,
    thirstMult: number,
  ): void {
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

    // No building passively relieves fatigue any more — power is restored ONLY by
    // sleeping (see stepSleep). We still find a nearby house so the status line can
    // read "Resting at <house>" when a villager idles at home.
    const service = this.serviceBuildingNear(villager.position.x, villager.position.y);

    // Hunger, thirst & boredom: consume one unit on the consumption cadence.
    this.stepConsumption(villager);

    // A live notice (e.g. a refused-work nudge) overrides the derived status so the
    // guidance shows on the map and is read by the mind in its own perceived status.
    villager.status =
      this.noticeFor(villager.id) ??
      deriveStatus(villager, service, this.taskBuilding(villager), this.buildingWithinReach(villager.position));
  }

  /**
   * Eating, drinking, and unwinding. Every {@link CONSUME_INTERVAL_TICKS} ticks a
   * villager consumes ONE unit for each resourced need that has climbed to
   * {@link NEED_CONSUME_THRESHOLD}. Below that they leave their supplies alone (so
   * a backpack carried for hauling isn't drained by a low need).
   */
  private stepConsumption(villager: Villager): void {
    if (this.tickCount % CONSUME_INTERVAL_TICKS !== 0) return;
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
    const construction: ConstructionState = {
      // A buildable raises EITHER a fixed building (`kind`) or a mobile cart
      // (`producesCart`) — carry whichever it declares through to completion.
      ...(spec.kind ? { targetKind: spec.kind } : {}),
      ...(spec.producesCart ? { targetCartTier: spec.producesCart } : {}),
      buildable: structure,
      targetName,
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
    const required = construction.required[resource];
    if (!required) {
      const wanted = Object.keys(construction.required).join('/');
      this.setNotice(villager.id, `${site.name} needs ${wanted}, not ${resource}.`);
      console.warn(`[engine] contribute: ${site.name} does not need ${resource} — ignored`);
      return;
    }
    const have = site.stock[resource] ?? 0;
    const shortfall = required - have;
    const carried = villager.backpack.filter((r) => r === resource).length;
    const amount = Math.min(carried, shortfall);
    if (amount <= 0) {
      console.warn(`[engine] contribute: nothing to add (${carried} carried, ${shortfall} short) — ignored`);
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
    site.stock[resource] = have + amount;
    console.log(`[engine] ${villager.id} added ${amount} ${resource} to ${site.name} (${site.stock[resource]}/${required})`);
    this.emitBuildingEvent(site, 'give', { actor: villager, resource, amount });
    // Done when every required material has been fully gathered.
    const complete = Object.entries(construction.required).every(
      ([r, need]) => (site.stock[r as ResourceKind] ?? 0) >= (need ?? 0),
    );
    if (complete) this.completeSite(site, villager);
  }

  /**
   * Finish a construction site: the gathered materials become the structure. The
   * building keeps its footprint and id but takes on its target KIND — with the right
   * colour, function and a fresh (empty) resource stock — so a well begins filling, a
   * new house can be slept in, and a monument starts lifting spirits. The proposer's
   * chosen name is stamped on, the `construction` marker is cleared, and the static
   * world is re-announced so every observer re-renders the finished building.
   */
  private completeSite(site: Building, finisher: Villager): void {
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
    site.function = BUILDING_FUNCTIONS[targetKind];
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
  private spawnCartFromSite(site: Building, tier: CartTier, finisher: Villager): void {
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
      lastCommandedBy: finisher.id,
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
    if (this.rectDistance(villager.position, cart) > SERVICE_REACH) {
      this.setNotice(villager.id, `You must stand next to ${cart.name} to give it an order.`);
      console.warn(`[engine] command_cart: ${villager.id} is not next to ${cart.name} — ignored`);
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
    if (isConstructionSite(to.kind) || !buildingStockKinds(to.kind).includes(resource)) {
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
    const villager: Villager = {
      id: `villager_spawn_${this.spawnSeq}`,
      name: 'Newcomer',
      type: 'villager',
      position: { x: ix, y: iy },
      target: null,
      color,
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
