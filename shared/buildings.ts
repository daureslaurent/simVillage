/**
 * shared/buildings.ts
 * ---------------------------------------------------------------------------
 * THE SINGLE SOURCE OF TRUTH for the village's RESOURCE ECONOMY.
 *
 * The economy is two short PARALLEL chains that the whole settlement turns on:
 *
 *     Water Source  --(haul)-->  Greenfield  --(haul)-->  Hall Town  --> villagers
 *      water (inf.)    water       2 water -> 1 food       food/water     eat/drink
 *
 *     Grove         --(haul)-->  Workshop    --(haul)-->  Tavern     --> villagers
 *      wood (inf.)     wood        2 wood -> 1 goods         goods       relieve boredom
 *
 *   - The WATER SOURCE / GROVE are inexhaustible SOURCES: villagers draw water /
 *     gather wood from them freely (no work) into their backpacks.
 *   - GREENFIELD / WORKSHOP are CONVERTERS: they turn a stocked input into an
 *     output (water→food, wood→goods). Both trickle slowly on their own and
 *     convert much faster while a villager works there.
 *   - HALL TOWN is the granary/cistern (food + water); the TAVERN stocks goods.
 *     Villagers eat/drink from Hall Town and enjoy goods at the Tavern.
 *   - The TEMPLE and HOUSES have no resource economy.
 *
 * This file declares, in one place that the engine, the world generator, the
 * villager minds, and the browser all import, WHICH resources each building kind
 * deals in, how water becomes food, and how a need maps to the resource it draws
 * down. Like `shared/events.ts` it is intentionally RUNTIME-DEPENDENCY-FREE: only
 * types plus frozen constant tables, safe to import from any environment.
 * ---------------------------------------------------------------------------
 */

import type { BuildableId, BuildingKind, CartTier, ResourceKind, VillagerNeeds } from './types';

/**
 * Which resource a need draws down when it is relieved. Drinking consumes
 * `water`, eating consumes `food`; resting at a house costs nothing (`null`), so
 * a home always relieves fatigue no matter the stores.
 */
export const NEED_RESOURCE: Record<keyof VillagerNeeds, ResourceKind | null> = {
  thirst: 'water',
  hunger: 'food',
  fatigue: null,
  // Boredom is relieved by enjoying `goods` — but ONLY at the tavern, never from a
  // backpack (you cannot entertain yourself out of a sack). The engine consumes a
  // unit of goods from the tavern's stock when a bored villager lingers there.
  boredom: 'goods',
};

/**
 * The resources each KIND of building stocks. A building kind absent from this
 * table (the temple, a house) has no resource economy: it neither depletes nor
 * needs refilling. Kept aligned with {@link NEED_RESOURCE} (thirst↔water,
 * hunger↔food).
 */
export const BUILDING_STOCKS: Partial<Record<BuildingKind, ResourceKind[]>> = {
  water_source: ['water'],
  greenfield: ['water', 'food'],
  lumber_source: ['wood'],
  workshop: ['wood', 'goods'],
  hall_town: ['water', 'food'],
  tavern: ['goods'],
  quarry: ['stone'],
  // NOTE: `construction_site` is deliberately ABSENT. A site's stock holds the
  // materials hauled in, but which kinds it accepts (and how many) are per-project
  // (its {@link ConstructionState.required}), not per-kind — the engine handles
  // give_to/streaming for sites specially rather than through this static table.
};

/** Default maximum units of EACH resource a building can hold. */
export const BUILDING_CAPACITY = 50;

/**
 * How close (Chebyshev tiles, measured from the building's FOOTPRINT edge) a
 * villager must be to "use" a building — work_at / take_from / give_to / pray_at,
 * and the auto-consume-from-an-adjacent-store. A small radius rather than a single
 * tile: villagers need not land on the exact bordering cell (movement snapping and
 * a neighbour already occupying that tile would otherwise leave them one step short
 * and get their action refused). Shared by the engine (the rule), the villager minds
 * (so the prompt's "you are HERE, act now" matches), and the client (which draws this
 * interaction radius around each building).
 */
export const SERVICE_REACH = 3;

/**
 * How far back a building's ACTIVITY LOG reaches, in clock (round) ticks. Events
 * older than this fall out of the rolling window. Sized to ~5 simulated hours
 * (5 × 3600 sim-sec ÷ SIM_SECONDS_PER_TICK = 18000 ÷ 180 = 100 ticks) — recent
 * enough for villagers to coordinate over without unbounded growth. Kept here as a
 * plain constant; the 100 is derived from the clock scale, restated to avoid a
 * runtime import of simClock into this dependency-free module.
 */
export const BUILDING_LOG_WINDOW_TICKS = 100;

// ---------------------------------------------------------------------------
// Production chain rates
// ---------------------------------------------------------------------------

/**
 * A converter turns INPUT resource into OUTPUT resource at a fixed cost ratio:
 * `inputPerOutput` units of input are consumed to make one unit of output.
 * Greenfield is the village's only converter — it eats water to grow food.
 */
export interface Conversion {
  input: ResourceKind;
  output: ResourceKind;
  /** Units of `input` consumed per unit of `output` produced (0.5 water → 1 food). */
  inputPerOutput: number;
}

/**
 * Which building kinds convert one resource into another, and at what cost.
 * Greenfield is deliberately water-THRIFTY: a little water grows a lot of food
 * (one water → two food), so villagers aren't bound to the spring all day hauling
 * and have time left over for one another.
 */
export const BUILDING_CONVERTS: Partial<Record<BuildingKind, Conversion>> = {
  greenfield: { input: 'water', output: 'food', inputPerOutput: 0.5 },
  // The workshop mirrors the farm: wood-thrifty, so a little gathered wood yields
  // plenty of goods and the crafter is not bound to the grove all day.
  workshop: { input: 'wood', output: 'goods', inputPerOutput: 0.5 },
};

/**
 * The resource an inexhaustible SOURCE yields — water from the spring, wood from
 * the grove. The engine tops a source's stock to capacity every tick so villagers
 * can always draw from it freely. A kind absent here is not a source.
 */
export const SOURCE_RESOURCE: Partial<Record<BuildingKind, ResourceKind>> = {
  water_source: 'water',
  lumber_source: 'wood',
  quarry: 'stone',
};

/**
 * Output units produced per tick by a converter with NO villager working — the
 * slow passive trickle of an unattended farm. Capped by available input + space.
 */
export const PASSIVE_CONVERT_RATE = 0.05;

/**
 * Output units produced per tick by a converter WITH a villager working there —
 * the fast hands-on rate. Tends the {@link Conversion} much quicker than passive.
 */
export const WORKER_CONVERT_RATE = 0.5;

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------

/** A villager consumes one unit of a resource every this many ticks. */
export const CONSUME_INTERVAL_TICKS = 5;

/** How much one consumed unit lowers the matching need (0..100 pressure). */
export const NEED_RELIEF_PER_UNIT = 30;

/**
 * A villager only eats or drinks once the need has climbed to AT LEAST this
 * pressure — they do not nibble at a low need. This keeps a backpack of water or
 * food intact for HAULING (a villager carrying supplies to Greenfield or Hall
 * Town won't sip it all away en route) and only spends it when genuinely needed.
 * Sits well under the "critical" mark (~85), so a villager with supplies tops up
 * at moderate need and never reaches distress while food/water is to hand.
 */
export const NEED_CONSUME_THRESHOLD = 45;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The conversion a building kind performs, if any. */
export function buildingConversion(kind: BuildingKind): Conversion | undefined {
  return BUILDING_CONVERTS[kind];
}

/** True when a building kind converts one resource into another (e.g. greenfield). */
export function isConverter(kind: BuildingKind): boolean {
  return BUILDING_CONVERTS[kind] !== undefined;
}

/** True when a building kind is the inexhaustible water spring. */
export function isWaterSource(kind: BuildingKind): boolean {
  return kind === 'water_source';
}

/** True when a building kind is an inexhaustible SOURCE (spring or grove). */
export function isSource(kind: BuildingKind): boolean {
  return SOURCE_RESOURCE[kind] !== undefined;
}

/** The resource an inexhaustible source yields, if it is one. */
export function sourceResource(kind: BuildingKind): ResourceKind | undefined {
  return SOURCE_RESOURCE[kind];
}

/** The resource kinds a given building kind stocks (empty for non-economy buildings). */
export function buildingStockKinds(kind: BuildingKind): ResourceKind[] {
  return BUILDING_STOCKS[kind] ?? [];
}

/**
 * True when WORKING at this building kind does something. Only converters reward
 * work — a villager labours at Greenfield to speed water→food. The water source
 * is free-draw (a `take_from`, not work) and storage/civic places aren't worked.
 */
export function isWorkable(kind: BuildingKind): boolean {
  return isConverter(kind);
}

/**
 * The human verb for working at a building kind — what a villager DOES there.
 * Flavour only: drives status lines and the work-action bubble so the loop reads
 * naturally ("Tending the fields at Greenfield") rather than generically.
 */
export function workVerb(kind: BuildingKind): string {
  switch (kind) {
    case 'greenfield':
      return 'tending the fields';
    case 'workshop':
      return 'working the forge';
    default:
      return 'working';
  }
}

/** True when the building has no stock left of ANY resource it is supposed to hold. */
export function isDepleted(
  kind: BuildingKind,
  stock: Partial<Record<ResourceKind, number>>,
): boolean {
  const kinds = buildingStockKinds(kind);
  if (kinds.length === 0) return false; // no economy → never "empty"
  return kinds.every((r) => (stock[r] ?? 0) <= 0);
}

// ---------------------------------------------------------------------------
// Render & description tables — the SINGLE source of truth for how every
// building kind looks and what it is FOR. Kept here (not in the world seed) so
// BOTH the generator AND the engine (which mints finished buildings when a
// construction site completes) stamp identical colour/function onto a building.
// ---------------------------------------------------------------------------

/** Render colour per building kind (any CSS colour string). */
export const BUILDING_COLORS: Record<BuildingKind, string> = {
  water_source: '#5b8db8',
  greenfield: '#7a9a4d',
  lumber_source: '#3f6b3a',
  workshop: '#8a5a3c',
  hall_town: '#9a5b7d',
  tavern: '#c08a3e',
  temple: '#b8a45b',
  house: '#9c7b5b',
  quarry: '#8c8f96',
  construction_site: '#c9b063',
  monument: '#b9c2cc',
  lamp: '#e8c95a',
};

/**
 * What each KIND of building is for, in one plain line — stamped onto a building's
 * `function` field so villagers (and the map tool) know WHY they would visit, not
 * just its category. Per-kind because the purpose is the same for every forge; a
 * building's `name` is what's per-instance.
 */
export const BUILDING_FUNCTIONS: Record<BuildingKind, string> = {
  water_source: 'an inexhaustible spring where anyone may freely draw water',
  greenfield: 'fields where stocked water is worked into food by farming',
  lumber_source: 'a grove where anyone may freely gather wood',
  workshop: 'a forge where stocked wood is worked into goods by crafting',
  hall_town: 'the town hall where food and water are stored for the whole village',
  tavern: 'the inn where villagers gather to enjoy goods and shake off boredom',
  temple: 'where villagers pray, petitioning the watching god',
  house: 'a home where villagers rest and sleep',
  quarry: 'a quarry where anyone may freely cut stone for building',
  construction_site: 'a building site — haul stone and wood here to raise it',
  monument: 'a proud monument that lifts the spirits of all who pass by',
  lamp: 'a standing lamp that warms and brightens its corner of the village',
};

// ---------------------------------------------------------------------------
// Buildable structures — what the village can RAISE together.
// ---------------------------------------------------------------------------

/**
 * A structure villagers can choose to build. It finishes into EITHER a fixed
 * building (`kind`) OR a mobile cart (`producesCart`) — exactly one is set. `cost`
 * is the materials a construction site must gather; `width`/`height` is the
 * footprint of the SITE (a cart leaves once built, freeing it). `label`/`why` feed
 * the prompt and UI so a mind knows what it is proposing and why it is worth the
 * village's effort.
 */
export interface Buildable {
  /** The finished building kind this becomes. Set for building buildables only. */
  kind?: BuildingKind;
  /** The cart tier this spawns once built. Set for cart buildables only (see {@link CART_SPECS}). */
  producesCart?: CartTier;
  /** Human noun for the thing, e.g. "a house", "a statue". */
  label: string;
  /** One line on what raising it gives the village — the reason to build it. */
  why: string;
  /** Footprint in tiles (the construction site reserves it). */
  width: number;
  height: number;
  /** Materials required to complete it, by resource kind. */
  cost: Partial<Record<ResourceKind, number>>;
}

/**
 * THE registry of what villagers may raise, keyed by the friendly {@link BuildableId}
 * the build tool exposes. Costs lean on STONE (the quarry's yield) so building gives
 * the new stone chain a purpose, with a little wood or goods so projects draw on the
 * other chains too — a build is a whole-village effort. Footprints match the seed's
 * own houses/spring so a finished structure sits naturally among them.
 */
export const BUILDABLES: Record<BuildableId, Buildable> = {
  house: {
    kind: 'house',
    label: 'a new house',
    why: 'another home so villagers have somewhere of their own to rest and sleep',
    width: 4,
    height: 4,
    cost: { stone: 12, wood: 8 },
  },
  well: {
    kind: 'water_source',
    label: 'a well',
    why: 'a fresh spring of water closer to where it is needed',
    width: 3,
    height: 3,
    cost: { stone: 16 },
  },
  statue: {
    kind: 'monument',
    label: 'a statue',
    why: 'a proud monument that gladdens every villager who passes near it',
    width: 2,
    height: 2,
    cost: { stone: 20, goods: 5 },
  },
  lamp: {
    kind: 'lamp',
    label: 'a standing lamp',
    why: 'a warm light that cheers its corner of the village',
    width: 1,
    height: 1,
    cost: { goods: 6, stone: 4 },
  },
  handcart: {
    producesCart: 'handcart',
    label: 'a handcart',
    why: 'a small self-driving cart that hauls one resource between two places on its own, sparing the round trip',
    width: 2,
    height: 2,
    cost: { wood: 6, goods: 4 },
  },
  freight: {
    producesCart: 'freight',
    label: 'a freight cart',
    why: 'a large self-driving cart that moves heavy loads of one resource between two places on its own',
    width: 2,
    height: 2,
    cost: { wood: 18, goods: 10, stone: 8 },
  },
};

/** The buildable spec for an id (always defined for a valid {@link BuildableId}). */
export function buildableFor(id: BuildableId): Buildable {
  return BUILDABLES[id];
}

// ---------------------------------------------------------------------------
// Carts — the stats each tier carries once raised.
// ---------------------------------------------------------------------------

/** The fixed stats of a {@link CartTier}: how much it carries, how fast, its look. */
export interface CartSpec {
  /** Human noun, e.g. "Handcart" — used to name and label spawned carts. */
  label: string;
  /** Units of cargo per trip. */
  capacity: number;
  /** Grid cells moved per tick (fast — carts outrun villagers). */
  speed: number;
  /** Render color. */
  color: string;
  /** Footprint in tiles (square). */
  width: number;
  height: number;
}

/**
 * THE registry of cart stats by tier — the single source of truth a spawned cart
 * and a resumed (loaded) cart both read, so a tweak here applies everywhere. A
 * handcart is small and nimble; a freight cart trades nothing on speed but carries
 * far more for its far steeper {@link BUILDABLES} cost.
 */
export const CART_SPECS: Record<CartTier, CartSpec> = {
  handcart: { label: 'Handcart', capacity: 6, speed: 10, color: '#8c6f4a', width: 2, height: 2 },
  freight: { label: 'Freight Cart', capacity: 20, speed: 10, color: '#b5894d', width: 2, height: 2 },
};

/** The stats for a cart tier (always defined for a valid {@link CartTier}). */
export function cartSpecFor(tier: CartTier): CartSpec {
  return CART_SPECS[tier];
}

/** True when a building kind is an in-progress construction site. */
export function isConstructionSite(kind: BuildingKind): boolean {
  return kind === 'construction_site';
}

// ---------------------------------------------------------------------------
// Ambience — the passive lift a villager-raised adornment gives its surroundings.
// ---------------------------------------------------------------------------

/**
 * How much boredom (0..100 pressure) a villager standing within {@link AMBIENCE_RADIUS}
 * tiles of an adornment sheds per tick — the simple pleasure of a beautiful village.
 * A monument lifts spirits more than a single lamp. Kinds absent here have no ambience.
 * This is the gameplay PAYOFF for building decorations: they make the place nicer to be.
 */
export const BUILDING_AMBIENCE: Partial<Record<BuildingKind, number>> = {
  monument: 0.5,
  lamp: 0.25,
};

/** How far (Chebyshev tiles, from the footprint edge) an adornment's ambience reaches. */
export const AMBIENCE_RADIUS = 6;

/** The per-tick boredom relief a building kind radiates, or 0 if it is not an adornment. */
export function buildingAmbience(kind: BuildingKind): number {
  return BUILDING_AMBIENCE[kind] ?? 0;
}
