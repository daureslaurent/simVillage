/**
 * server/src/world/seed.ts
 * ---------------------------------------------------------------------------
 * World generation lives OUTSIDE the engine on purpose. The engine is a pure
 * state machine constructed from a `WorldSeed`; where that seed comes from
 * (random generation here, or a MongoDB document) is somebody else's concern.
 * This keeps the engine deterministic and trivial to test.
 *
 * The generator lays out a small VILLAGE: a cluster of named buildings around a
 * central well (the square), the villagers spawned just around that square so
 * they actually meet, and a scattering of trees forming a forest around it all.
 * ---------------------------------------------------------------------------
 */

import type { Building, BuildingKind, Cart, ResourceKind, TerrainPalette, Villager, Tree, Vec2, WorldSeed } from '../../../shared/types';
import { DEFAULT_TERRAIN_PALETTE, DEFAULT_VILLAGE_ID, RIVAL_VILLAGE_ID } from '../../../shared/types';
import { deriveAppearance } from '../../../shared/appearance';
import {
  BUILDING_CAPACITY,
  BUILDING_COLORS,
  BUILDING_FUNCTIONS,
  buildingStockKinds,
  cartSpecFor,
} from '../../../shared/buildings';

/** Default world size, per the Phase 1 spec. */
export const DEFAULT_WIDTH = 500;
export const DEFAULT_HEIGHT = 500;

/** A small palette so the handful of starter villagers are visually distinct. */
const VILLAGER_COLORS = ['#ff4d4d', '#4dafff', '#ffd24d', '#9b5dff', '#4dffa1', '#ff9f4d'];

/** A cooler palette for the RIVAL village (v3 P5), so the two sides read apart on the map. */
const RIVAL_VILLAGER_COLORS = ['#1f9e8a', '#7b68ee', '#2e8bd0', '#5fa83a', '#c060c0', '#3aa0a0'];

/**
 * The resources a villager might start out carrying. The backpack holds
 * simulation resources only (see {@link Villager.backpack}); each entry is one
 * unit. Drawn from the kinds villagers actually haul between buildings.
 */
const STARTER_ITEMS: ResourceKind[] = ['food', 'water'];

/**
 * The village blueprint: each building's kind, label and footprint, positioned
 * by an offset (in tiles) from the map centre. Hand-placed so the result reads
 * like a settlement gathered around a well, not a random scatter.
 */
interface BuildingBlueprint {
  kind: BuildingKind;
  name: string;
  /** Footprint in tiles. */
  w: number;
  h: number;
  /** Top-left offset from the map centre, in tiles. */
  dx: number;
  dy: number;
}

const VILLAGE_BLUEPRINT: BuildingBlueprint[] = [
  // The spring at the heart of the square, where everyone gathers and draws water.
  { kind: 'water_source', name: 'The Old Spring', w: 3, h: 3, dx: -1, dy: -1 },
  // The farm that turns water into food, out among its broad fields to the NW.
  { kind: 'greenfield', name: 'Greenfield Farmstead', w: 13, h: 9, dx: -34, dy: -28 },
  // The grove where wood is gathered, off in the SE so the village spreads out.
  { kind: 'lumber_source', name: 'The Greywood Grove', w: 9, h: 9, dx: 30, dy: 24 },
  // The quarry where stone is cut for building, off in the SW to balance the grove.
  { kind: 'quarry', name: 'The Stonecutters\' Quarry', w: 7, h: 7, dx: -34, dy: 22 },
  // The forge that turns wood into goods, on the east side between grove and square.
  { kind: 'workshop', name: 'Emberfall Forge', w: 7, h: 6, dx: 18, dy: 6 },
  // The town hall stores the village's food and water; placed just off the square.
  { kind: 'hall_town', name: 'Town Hall', w: 8, h: 6, dx: -6, dy: 9 },
  // The inn just off the square, where the village gathers of an evening.
  { kind: 'tavern', name: 'The Rolling Pin Inn', w: 7, h: 5, dx: -12, dy: -10 },
  // The temple, where villagers go to pray to the watching god.
  { kind: 'temple', name: 'Temple of the Dawn', w: 6, h: 9, dx: 16, dy: -14 },
  // The technical depot, just off the square: from here a villager can dispatch ANY
  // robot-cart in the village, so the whole haulage fleet is driven from one place.
  { kind: 'depot', name: 'The Cartwright\'s Depot', w: 4, h: 4, dx: 4, dy: 6 },
  // A few homes around the square where villagers rest — one for roughly every
  // villager, ringing the square so no one sleeps far from the well.
  { kind: 'house', name: 'Hollin Cottage', w: 4, h: 4, dx: 26, dy: -4 },
  { kind: 'house', name: 'Marsh Cottage', w: 4, h: 4, dx: 24, dy: 16 },
  { kind: 'house', name: 'Birchwood Cottage', w: 4, h: 4, dx: -16, dy: 18 },
  { kind: 'house', name: 'Fern Cottage', w: 4, h: 4, dx: -28, dy: 4 },
  { kind: 'house', name: 'Larkspur Cottage', w: 4, h: 4, dx: 8, dy: -24 },
];

/** Inclusive-low / exclusive-high random integer in [min, max). */
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

/** Pick `count` distinct random starter items (clamped to what's available). */
function pickItems(count: number): string[] {
  const pool = [...STARTER_ITEMS];
  const out: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    out.push(pool.splice(randInt(0, pool.length), 1)[0]!);
  }
  return out;
}

/** Encode a tile as a string key for fast occupancy lookup during generation. */
function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export interface GenerateOptions {
  width?: number;
  height?: number;
  treeCount?: number;
  /**
   * Villager ids to spawn, in order — supply the roster's ids so each spawned
   * body lines up with a mind/profile. Defaults to `villager_1 .. villager_5`.
   */
  villagerIds?: string[];
}

/**
 * Produce a fresh random world: the village buildings around the central square,
 * the villagers spawned just around it, and a forest of trees filling the rest.
 */
export function generateSeed(options: GenerateOptions = {}): WorldSeed {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const treeCount = options.treeCount ?? 400;
  const villagerIds =
    options.villagerIds ?? ['villager_1', 'villager_2', 'villager_3', 'villager_4', 'villager_5', 'villager_6'];

  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  // Track occupied tiles so nothing spawns on top of a building or another object.
  const occupied = new Set<string>();

  // 1. Buildings first — they anchor the village and claim their footprints.
  const buildings: Building[] = [];
  for (let i = 0; i < VILLAGE_BLUEPRINT.length; i++) {
    const bp = VILLAGE_BLUEPRINT[i]!;
    const x = clamp(cx + bp.dx, 0, width - bp.w);
    const y = clamp(cy + bp.dy, 0, height - bp.h);
    // Seed each building lightly stocked (15–45%) so the larder starts BELOW the
    // brain's maintenance targets — villagers have real work to do from tick one
    // instead of standing idle on a full world.
    const stock: Partial<Record<ResourceKind, number>> = {};
    for (const r of buildingStockKinds(bp.kind)) {
      stock[r] = randInt(Math.floor(BUILDING_CAPACITY * 0.15), Math.floor(BUILDING_CAPACITY * 0.45) + 1);
    }
    buildings.push({
      id: `building_${bp.kind}_${i}`,
      type: 'building',
      villageId: DEFAULT_VILLAGE_ID,
      kind: bp.kind,
      name: bp.name,
      function: BUILDING_FUNCTIONS[bp.kind],
      position: { x, y },
      width: bp.w,
      height: bp.h,
      color: BUILDING_COLORS[bp.kind],
      capacity: BUILDING_CAPACITY,
      stock,
    });
    for (let yy = y; yy < y + bp.h; yy++) {
      for (let xx = x; xx < x + bp.w; xx++) occupied.add(tileKey(xx, yy));
    }
  }

  // 2. Trees: a forest filling the map, but kept out of the village core so the
  //    square stays walkable and legible.
  const trees: Tree[] = [];
  for (let i = 0; i < treeCount; i++) {
    const pos = freeTileOutside(width, height, occupied, cx, cy, 40);
    if (!pos) break;
    occupied.add(tileKey(pos.x, pos.y));
    trees.push({ id: `tree_${i}`, type: 'tree', position: pos });
  }

  // 3. Villagers: gathered around the well so they meet and talk.
  const villagers: Villager[] = villagerIds.map((id, i) => {
    const pos = freeTileNear(width, height, occupied, cx, cy, 14);
    occupied.add(tileKey(pos.x, pos.y));
    const color = VILLAGER_COLORS[i % VILLAGER_COLORS.length]!;
    return {
      id,
      // Display name is filled in at boot from the persona roster; until then,
      // the id is a safe placeholder.
      name: id,
      type: 'villager',
      villageId: DEFAULT_VILLAGE_ID,
      position: pos,
      target: null,
      color,
      // A deterministic figure derived from the id (LLM-built worlds overwrite this
      // with the persona's generated look), keyed to the map colour so they agree.
      appearance: deriveAppearance(id, color),
      speed: 2, // grid cells per tick
      status: 'Idle',
      // Start with mild, differing needs so the bars are alive from tick one.
      needs: {
        hunger: randInt(10, 45),
        thirst: randInt(10, 45),
        fatigue: randInt(5, 35),
        boredom: randInt(10, 40),
      },
      // A small, random starter inventory (0–2 items), capped well under the limit.
      backpack: pickItems(randInt(0, 3)),
      // Everyone starts free; tasks are taken on at runtime (e.g. via work_at).
      task: null,
      // Everyone wakes with the village; sleep is entered at runtime when power runs out.
      asleep: false,
    };
  });

  // 4. A single cheap handcart parked near the square, so the village has a
  //    robot-cart to command from day one. It spawns idle with no order — a
  //    villager sets its first take→deposit run with `command_cart`.
  const carts: Cart[] = [];
  {
    const spec = cartSpecFor('handcart');
    const at = freeTileNear(width, height, occupied, cx, cy, 10);
    for (let yy = at.y; yy < at.y + spec.height; yy++) {
      for (let xx = at.x; xx < at.x + spec.width; xx++) occupied.add(tileKey(xx, yy));
    }
    carts.push({
      id: 'cart_0',
      type: 'cart',
      villageId: DEFAULT_VILLAGE_ID,
      name: `${spec.label} 1`,
      tier: 'handcart',
      width: spec.width,
      height: spec.height,
      position: at,
      target: null,
      color: spec.color,
      speed: spec.speed,
      capacity: spec.capacity,
      cargo: [],
      order: null,
      phase: 'idle',
      waitReason: null,
      lastCommandedBy: null,
    });
  }

  return { width, height, trees, villagers, buildings, carts, palette: DEFAULT_TERRAIN_PALETTE };
}

// ---------------------------------------------------------------------------
// v3 P5 — TWO villages: a home settlement and a rival, on a wider shared map
// (design §10, soft competition). Each cluster is the same hand-authored blueprint,
// laid down around its own centre and stamped with its `villageId`, so every entity
// is owned by exactly one side. They sit far apart with a contested middle the gods
// can send raiders across. Building/cart ids are namespaced by village so the two
// clusters' ids never collide.
// ---------------------------------------------------------------------------

/** One placed village cluster: its owned buildings, villagers and cart. */
interface VillageCluster {
  buildings: Building[];
  villagers: Villager[];
  carts: Cart[];
}

/**
 * Lay one village's blueprint down around (cx, cy): its buildings (claiming their
 * footprints in the shared `occupied` set), its villagers gathered at the square, and a
 * starter handcart. Everything is stamped with `villageId`, and building/cart ids are
 * namespaced by it so a second cluster on the same map never collides. Trees are NOT
 * placed here — the caller fills the rest of the map around all clusters at once.
 */
function placeVillageCluster(opts: {
  cx: number;
  cy: number;
  villageId: string;
  villagerIds: string[];
  width: number;
  height: number;
  occupied: Set<string>;
  /** Villager colour palette for this side (home vs rival read apart). */
  colors: readonly string[];
}): VillageCluster {
  const { cx, cy, villageId, villagerIds, width, height, occupied, colors } = opts;

  const buildings: Building[] = [];
  for (let i = 0; i < VILLAGE_BLUEPRINT.length; i++) {
    const bp = VILLAGE_BLUEPRINT[i]!;
    const x = clamp(cx + bp.dx, 0, width - bp.w);
    const y = clamp(cy + bp.dy, 0, height - bp.h);
    buildings.push({
      id: `building_${villageId}_${bp.kind}_${i}`,
      type: 'building',
      villageId,
      kind: bp.kind,
      name: bp.name,
      function: BUILDING_FUNCTIONS[bp.kind],
      position: { x, y },
      width: bp.w,
      height: bp.h,
      color: BUILDING_COLORS[bp.kind],
      capacity: BUILDING_CAPACITY,
      stock: seedStock(bp.kind),
    });
    claimFootprint(occupied, x, y, bp.w, bp.h);
  }

  const villagers: Villager[] = villagerIds.map((id, i) => {
    const pos = freeTileNear(width, height, occupied, cx, cy, 14);
    occupied.add(tileKey(pos.x, pos.y));
    const color = colors[i % colors.length]!;
    return {
      id,
      name: id,
      type: 'villager',
      villageId,
      position: pos,
      target: null,
      color,
      appearance: deriveAppearance(id, color),
      speed: 2,
      status: 'Idle',
      needs: {
        hunger: randInt(10, 45),
        thirst: randInt(10, 45),
        fatigue: randInt(5, 35),
        boredom: randInt(10, 40),
      },
      backpack: pickItems(randInt(0, 3)),
      task: null,
      asleep: false,
    };
  });

  const carts: Cart[] = [];
  {
    const spec = cartSpecFor('handcart');
    const at = freeTileNear(width, height, occupied, cx, cy, 10);
    claimFootprint(occupied, at.x, at.y, spec.width, spec.height);
    carts.push({
      id: `cart_${villageId}_0`,
      type: 'cart',
      villageId,
      name: `${spec.label} 1`,
      tier: 'handcart',
      width: spec.width,
      height: spec.height,
      position: at,
      target: null,
      color: spec.color,
      speed: spec.speed,
      capacity: spec.capacity,
      cargo: [],
      order: null,
      phase: 'idle',
      waitReason: null,
      lastCommandedBy: null,
    });
  }

  return { buildings, villagers, carts };
}

export interface RivalSeedOptions {
  width?: number;
  height?: number;
  treeCount?: number;
}

/**
 * Produce a TWO-village world: the home settlement ({@link DEFAULT_VILLAGE_ID}) on the
 * west and a rival ({@link RIVAL_VILLAGE_ID}) on the east of a wide shared map, with a
 * forest filling the contested middle and edges. Each side owns its own buildings,
 * villagers and cart. The rosters supply the ids for each side (so each lines up with a
 * mind/profile); names are stamped at boot like the single-village seed.
 */
export function generateRivalSeed(
  homeIds: string[],
  rivalIds: string[],
  options: RivalSeedOptions = {},
): WorldSeed {
  // A wider map than the single village, so two clusters sit comfortably apart with a
  // contested middle a raiding party must cross.
  const width = options.width ?? 760;
  const height = options.height ?? 500;
  const treeCount = options.treeCount ?? 500;
  const occupied = new Set<string>();

  const cores = [
    { cx: Math.floor(width * 0.24), cy: Math.floor(height / 2) },
    { cx: Math.floor(width * 0.76), cy: Math.floor(height / 2) },
  ];
  const home = placeVillageCluster({
    cx: cores[0]!.cx,
    cy: cores[0]!.cy,
    villageId: DEFAULT_VILLAGE_ID,
    villagerIds: homeIds,
    width,
    height,
    occupied,
    colors: VILLAGER_COLORS,
  });
  const rival = placeVillageCluster({
    cx: cores[1]!.cx,
    cy: cores[1]!.cy,
    villageId: RIVAL_VILLAGE_ID,
    villagerIds: rivalIds,
    width,
    height,
    occupied,
    colors: RIVAL_VILLAGER_COLORS,
  });

  // Trees fill the rest, kept clear of BOTH cluster cores so each square stays walkable.
  const trees: Tree[] = [];
  for (let i = 0; i < treeCount; i++) {
    const pos = freeTileAwayFromCores(width, height, occupied, cores, 32);
    if (!pos) break;
    occupied.add(tileKey(pos.x, pos.y));
    trees.push({ id: `tree_${i}`, type: 'tree', position: pos });
  }

  return {
    width,
    height,
    trees,
    villagers: [...home.villagers, ...rival.villagers],
    buildings: [...home.buildings, ...rival.buildings],
    carts: [...home.carts, ...rival.carts],
    palette: DEFAULT_TERRAIN_PALETTE,
  };
}

/** A free tile at least `keepOut` tiles from EVERY cluster core (keeps both squares clear). */
function freeTileAwayFromCores(
  width: number,
  height: number,
  occupied: Set<string>,
  cores: { cx: number; cy: number }[],
  keepOut: number,
): Vec2 | null {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const x = randInt(0, width);
    const y = randInt(0, height);
    if (occupied.has(tileKey(x, y))) continue;
    if (cores.some((c) => fromCenter(x, y, c.cx, c.cy) < keepOut)) continue;
    return { x, y };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM-generated worlds: assemble a valid WorldSeed from a building PLAN.
//
// The generator (see `llmGenerate.ts`) decides WHAT exists and roughly WHERE; this
// turns that plan into a real, collision-free, in-bounds seed using the same
// stocking/cart logic as the hand-authored village above. The model's coordinates
// are treated as a PROPOSAL: any footprint that lands out of bounds or on top of
// another is repaired to the nearest free spot, so a shaky local-model layout can
// never produce an invalid map.
// ---------------------------------------------------------------------------

/** One building the generator asked for: a kind + name + a proposed footprint. */
export interface BuildingPlanItem {
  kind: BuildingKind;
  name: string;
  /** Proposed top-left tile and footprint (tiles). Repaired if invalid/overlapping. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A whole generated world, pre-validation: map size, terrain density, buildings. */
export interface WorldPlan {
  width: number;
  height: number;
  treeCount: number;
  buildings: BuildingPlanItem[];
  /** Flavour carried through to the seed (and on to the browser). */
  theme?: string;
  setting?: string;
  /** Themed ground colours; defaults to {@link DEFAULT_TERRAIN_PALETTE} when omitted. */
  palette?: TerrainPalette;
  /**
   * Gap (tiles) to keep BETWEEN buildings when the village is packed. Small on
   * purpose — 1–3 — so the settlement reads as a tight cluster rather than a
   * scatter. Defaults to {@link DEFAULT_VILLAGE_MARGIN}.
   */
  margin?: number;
}

/** Default gap between packed buildings — tight enough to look like a real village. */
export const DEFAULT_VILLAGE_MARGIN = 2;

/** The resources a freshly-seeded building of this kind starts partly stocked with. */
function seedStock(kind: BuildingKind): Partial<Record<ResourceKind, number>> {
  const stock: Partial<Record<ResourceKind, number>> = {};
  for (const r of buildingStockKinds(kind)) {
    stock[r] = randInt(Math.floor(BUILDING_CAPACITY * 0.15), Math.floor(BUILDING_CAPACITY * 0.45) + 1);
  }
  return stock;
}

/** Mark every tile of a w×h footprint at (x,y) occupied. */
function claimFootprint(occupied: Set<string>, x: number, y: number, w: number, h: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) occupied.add(tileKey(xx, yy));
  }
}

/** True when a w×h footprint, GROWN by `margin` tiles on every side, hits nothing. */
function footprintFreeWithMargin(
  occupied: Set<string>,
  x: number,
  y: number,
  w: number,
  h: number,
  margin: number,
): boolean {
  for (let yy = y - margin; yy < y + h + margin; yy++) {
    for (let xx = x - margin; xx < x + w + margin; xx++) {
      if (occupied.has(tileKey(xx, yy))) return false;
    }
  }
  return true;
}

/** A building positioned by the packer: its plan entry + clamped footprint + final tile. */
interface PlacedBuilding {
  bp: BuildingPlanItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pack the planned buildings into a TIGHT village cluster around the map centre.
 *
 * The local model is poor at spacing — left to its own coordinates it scatters the
 * buildings across the map. So we keep only the DIRECTION the model intended for
 * each building (its bearing from the cluster's centroid: "the temple is east, the
 * farm is north-west") and discard its distance, then re-lay every building as close
 * to the centre as it will go along that bearing, leaving just a `margin`-tile gap
 * to its neighbours. The result reads as a real settlement gathered around a square,
 * while still honouring the model's sense of where each thing belongs.
 *
 * Buildings are placed centre-outward (closest-to-centroid first) so the core fills
 * solidly and later buildings ring it. Returns final footprints; never overlaps.
 */
function packVillage(
  items: BuildingPlanItem[],
  width: number,
  height: number,
  margin: number,
  opts: {
    /** Centre to pack around; defaults to the map centre. */
    cx?: number;
    cy?: number;
    /**
     * A SHARED occupancy set to pack into, so several clusters laid on one map never
     * overlap each other. Defaults to a fresh set (a lone village). Buildings placed
     * here are claimed into it.
     */
    occupied?: Set<string>;
  } = {},
): PlacedBuilding[] {
  const cx = opts.cx ?? width / 2;
  const cy = opts.cy ?? height / 2;

  // Each building's intended bearing + distance from the model's own centroid.
  const centers = items.map((bp) => ({ bp, mx: bp.x + bp.w / 2, my: bp.y + bp.h / 2 }));
  const gx = centers.reduce((s, c) => s + c.mx, 0) / Math.max(1, centers.length);
  const gy = centers.reduce((s, c) => s + c.my, 0) / Math.max(1, centers.length);
  const ranked = centers.map((c, i) => {
    const dx = c.mx - gx;
    const dy = c.my - gy;
    const dist = Math.hypot(dx, dy);
    // A stable fallback angle (golden-ratio spread) for a building sitting dead on
    // the centroid, so co-located buildings still fan out instead of stacking.
    const angle = dist < 0.5 ? i * 2.399963 : Math.atan2(dy, dx);
    return { c, dist, angle, i };
  });
  // Big buildings first within the core, then closest-to-centroid, so the anchor
  // structures take the middle and the rest pack snugly around them.
  ranked.sort((a, b) => a.dist - b.dist || b.c.bp.w * b.c.bp.h - a.c.bp.w * a.c.bp.h);

  const occupied = opts.occupied ?? new Set<string>();
  const placed: PlacedBuilding[] = [];
  const maxR = Math.max(width, height);

  for (const { c, angle } of ranked) {
    const w = clamp(Math.round(c.bp.w), 1, Math.min(40, width));
    const h = clamp(Math.round(c.bp.h), 1, Math.min(40, height));
    let spot: Vec2 | null = null;
    // Walk outward from the centre along the intended bearing; take the first radius
    // where the footprint (plus its margin) is clear and in bounds.
    for (let r = 0; r <= maxR && !spot; r++) {
      const px = Math.round(cx + Math.cos(angle) * r - w / 2);
      const py = Math.round(cy + Math.sin(angle) * r - h / 2);
      if (px < 0 || py < 0 || px + w > width || py + h > height) continue;
      if (footprintFreeWithMargin(occupied, px, py, w, h, margin)) spot = { x: px, y: py };
    }
    // Pathological fallback: a full scan ignoring the bearing, then clamp.
    if (!spot) {
      for (let y = 0; y <= height - h && !spot; y++) {
        for (let x = 0; x <= width - w && !spot; x++) {
          if (footprintFreeWithMargin(occupied, x, y, w, h, margin)) spot = { x, y };
        }
      }
    }
    const at = spot ?? { x: clamp(Math.round(c.mx - w / 2), 0, width - w), y: clamp(Math.round(c.my - h / 2), 0, height - h) };
    claimFootprint(occupied, at.x, at.y, w, h);
    placed.push({ bp: c.bp, x: at.x, y: at.y, w, h });
  }
  return placed;
}

/**
 * Assemble a valid {@link WorldSeed} from a generated {@link WorldPlan} and the
 * roster ids. Mirrors {@link generateSeed}'s stocking, villager spawn and cart
 * logic, but takes the buildings (kind/name) from the plan and PACKS them into a
 * tight village cluster (see {@link packVillage}); villagers gather at its centre.
 */
export function buildSeedFromPlan(plan: WorldPlan, villagerIds: string[]): WorldSeed {
  const width = clamp(Math.round(plan.width), 100, 2000);
  const height = clamp(Math.round(plan.height), 100, 2000);
  const margin = clamp(Math.round(plan.margin ?? DEFAULT_VILLAGE_MARGIN), 0, 8);
  const occupied = new Set<string>();

  // 1. Buildings — packed tightly around the map centre, honouring each one's
  //    intended bearing but closing the gaps the model leaves between them.
  const buildings: Building[] = packVillage(plan.buildings, width, height, margin).map((pb, i) => {
    claimFootprint(occupied, pb.x, pb.y, pb.w, pb.h);
    return {
      id: `building_${pb.bp.kind}_${i}`,
      type: 'building',
      villageId: DEFAULT_VILLAGE_ID,
      kind: pb.bp.kind,
      name: pb.bp.name,
      function: BUILDING_FUNCTIONS[pb.bp.kind],
      position: { x: pb.x, y: pb.y },
      width: pb.w,
      height: pb.h,
      color: BUILDING_COLORS[pb.bp.kind],
      capacity: BUILDING_CAPACITY,
      stock: seedStock(pb.bp.kind),
    };
  });

  // The village centroid: the average of the building footprint centres, so trees
  // keep clear of the settlement and folk spawn in its midst regardless of layout.
  const cx = buildings.length
    ? Math.round(buildings.reduce((s, b) => s + b.position.x + b.width / 2, 0) / buildings.length)
    : Math.floor(width / 2);
  const cy = buildings.length
    ? Math.round(buildings.reduce((s, b) => s + b.position.y + b.height / 2, 0) / buildings.length)
    : Math.floor(height / 2);

  // The radius of the packed village from its centre, so we ring it with a clearing
  // and trees grow as a forest AROUND the settlement rather than inside its lanes.
  const villageRadius = buildings.reduce((max, b) => {
    const corner = Math.max(
      Math.hypot(b.position.x - cx, b.position.y - cy),
      Math.hypot(b.position.x + b.width - cx, b.position.y + b.height - cy),
    );
    return Math.max(max, corner);
  }, 12);
  const clearing = villageRadius + 6; // a little breathing room past the outer buildings

  // 2. Trees: fill free tiles, but keep a buffer clear around every building so
  //    entrances stay walkable. We pad the occupancy set with a 1-tile skirt.
  const treeBlocked = new Set(occupied);
  for (const b of buildings) {
    for (let yy = b.position.y - 1; yy <= b.position.y + b.height; yy++) {
      for (let xx = b.position.x - 1; xx <= b.position.x + b.width; xx++) {
        treeBlocked.add(tileKey(xx, yy));
      }
    }
  }
  const trees: Tree[] = [];
  const treeCount = clamp(Math.round(plan.treeCount), 0, Math.floor((width * height) / 20));
  for (let i = 0; i < treeCount; i++) {
    let placed: Vec2 | null = null;
    for (let attempt = 0; attempt < 10000 && !placed; attempt++) {
      const x = randInt(0, width);
      const y = randInt(0, height);
      const key = tileKey(x, y);
      if (treeBlocked.has(key)) continue;
      // Keep the whole village square + its lanes clear, so the cluster reads cleanly
      // and the forest begins at the settlement's edge.
      if (Math.hypot(x - cx, y - cy) < clearing) continue;
      placed = { x, y };
    }
    if (!placed) break;
    treeBlocked.add(tileKey(placed.x, placed.y));
    occupied.add(tileKey(placed.x, placed.y));
    trees.push({ id: `tree_${i}`, type: 'tree', position: placed });
  }

  // 3. Villagers gathered around the centroid so they meet and talk.
  const villagers: Villager[] = villagerIds.map((id, i) => {
    const pos = freeTileNear(width, height, occupied, cx, cy, 16);
    occupied.add(tileKey(pos.x, pos.y));
    const color = VILLAGER_COLORS[i % VILLAGER_COLORS.length]!;
    return {
      id,
      name: id,
      type: 'villager',
      villageId: DEFAULT_VILLAGE_ID,
      position: pos,
      target: null,
      color,
      appearance: deriveAppearance(id, color),
      speed: 2,
      status: 'Idle',
      needs: {
        hunger: randInt(10, 45),
        thirst: randInt(10, 45),
        fatigue: randInt(5, 35),
        boredom: randInt(10, 40),
      },
      backpack: pickItems(randInt(0, 3)),
      task: null,
      asleep: false,
    };
  });

  // 4. One handcart parked near the square, exactly as the classic seed does.
  const carts: Cart[] = [];
  {
    const spec = cartSpecFor('handcart');
    const at = freeTileNear(width, height, occupied, cx, cy, 10);
    claimFootprint(occupied, at.x, at.y, spec.width, spec.height);
    carts.push({
      id: 'cart_0',
      type: 'cart',
      villageId: DEFAULT_VILLAGE_ID,
      name: `${spec.label} 1`,
      tier: 'handcart',
      width: spec.width,
      height: spec.height,
      position: at,
      target: null,
      color: spec.color,
      speed: spec.speed,
      capacity: spec.capacity,
      cargo: [],
      order: null,
      phase: 'idle',
      waitReason: null,
      lastCommandedBy: null,
    });
  }

  const seed: WorldSeed = {
    width,
    height,
    trees,
    villagers,
    buildings,
    carts,
    palette: plan.palette ?? DEFAULT_TERRAIN_PALETTE,
  };
  if (plan.theme) seed.theme = plan.theme;
  if (plan.setting) seed.setting = plan.setting;
  return seed;
}

// ---------------------------------------------------------------------------
// LLM-generated TWO-village worlds: lay two generated PLANS down as a home + a
// rival cluster on a wide shared map (the LLM counterpart of `generateRivalSeed`,
// which uses the fixed blueprint). Each plan keeps its own theme/buildings/roster;
// both are packed around their own core into one shared occupancy set so the
// clusters never overlap, with a forest filling the contested middle.
// ---------------------------------------------------------------------------

/**
 * Pack one generated {@link WorldPlan} into a cluster around (cx, cy): its buildings
 * (ids namespaced + stamped with `villageId`, claimed into the shared `occupied`
 * set), its villagers gathered at the packed centroid, and a starter handcart.
 * Returns the cluster plus its radius, so the caller can keep trees clear of it.
 */
function clusterFromPlan(opts: {
  plan: WorldPlan;
  villageId: string;
  villagerIds: string[];
  width: number;
  height: number;
  cx: number;
  cy: number;
  margin: number;
  occupied: Set<string>;
  colors: readonly string[];
}): { cluster: VillageCluster; radius: number } {
  const { plan, villageId, villagerIds, width, height, cx, cy, margin, occupied, colors } = opts;

  const placed = packVillage(plan.buildings, width, height, margin, { cx, cy, occupied });
  const buildings: Building[] = placed.map((pb, i) => ({
    id: `building_${villageId}_${pb.bp.kind}_${i}`,
    type: 'building',
    villageId,
    kind: pb.bp.kind,
    name: pb.bp.name,
    function: BUILDING_FUNCTIONS[pb.bp.kind],
    position: { x: pb.x, y: pb.y },
    width: pb.w,
    height: pb.h,
    color: BUILDING_COLORS[pb.bp.kind],
    capacity: BUILDING_CAPACITY,
    stock: seedStock(pb.bp.kind),
  }));

  // The packed centroid + radius: villagers spawn in its midst, trees keep clear of it.
  const ccx = buildings.length
    ? Math.round(buildings.reduce((s, b) => s + b.position.x + b.width / 2, 0) / buildings.length)
    : cx;
  const ccy = buildings.length
    ? Math.round(buildings.reduce((s, b) => s + b.position.y + b.height / 2, 0) / buildings.length)
    : cy;
  const radius = buildings.reduce((max, b) => {
    const corner = Math.max(
      Math.hypot(b.position.x - ccx, b.position.y - ccy),
      Math.hypot(b.position.x + b.width - ccx, b.position.y + b.height - ccy),
    );
    return Math.max(max, corner);
  }, 12);

  const villagers: Villager[] = villagerIds.map((id, i) => {
    const pos = freeTileNear(width, height, occupied, ccx, ccy, 16);
    occupied.add(tileKey(pos.x, pos.y));
    const color = colors[i % colors.length]!;
    return {
      id,
      name: id,
      type: 'villager',
      villageId,
      position: pos,
      target: null,
      color,
      appearance: deriveAppearance(id, color),
      speed: 2,
      status: 'Idle',
      needs: {
        hunger: randInt(10, 45),
        thirst: randInt(10, 45),
        fatigue: randInt(5, 35),
        boredom: randInt(10, 40),
      },
      backpack: pickItems(randInt(0, 3)),
      task: null,
      asleep: false,
    };
  });

  const carts: Cart[] = [];
  {
    const spec = cartSpecFor('handcart');
    const at = freeTileNear(width, height, occupied, ccx, ccy, 10);
    claimFootprint(occupied, at.x, at.y, spec.width, spec.height);
    carts.push({
      id: `cart_${villageId}_0`,
      type: 'cart',
      villageId,
      name: `${spec.label} 1`,
      tier: 'handcart',
      width: spec.width,
      height: spec.height,
      position: at,
      target: null,
      color: spec.color,
      speed: spec.speed,
      capacity: spec.capacity,
      cargo: [],
      order: null,
      phase: 'idle',
      waitReason: null,
      lastCommandedBy: null,
    });
  }

  return { cluster: { buildings, villagers, carts }, radius };
}

/**
 * Assemble a valid TWO-village {@link WorldSeed} from two generated plans — the home
 * settlement ({@link DEFAULT_VILLAGE_ID}) on the west and a rival ({@link
 * RIVAL_VILLAGE_ID}) on the east of a wide shared map, with a forest filling the
 * contested middle. The map ground takes the HOME plan's palette (one ground covers
 * the shared valley); each cluster keeps its own buildings, names and roster.
 */
export function buildRivalSeedFromPlans(
  home: { plan: WorldPlan; villagerIds: string[] },
  rival: { plan: WorldPlan; villagerIds: string[] },
  options: RivalSeedOptions = {},
): WorldSeed {
  const width = options.width ?? 760;
  const height = options.height ?? 500;
  const occupied = new Set<string>();

  const cores = [
    { cx: Math.floor(width * 0.24), cy: Math.floor(height / 2) },
    { cx: Math.floor(width * 0.76), cy: Math.floor(height / 2) },
  ];
  const homeCluster = clusterFromPlan({
    plan: home.plan,
    villageId: DEFAULT_VILLAGE_ID,
    villagerIds: home.villagerIds,
    width,
    height,
    cx: cores[0]!.cx,
    cy: cores[0]!.cy,
    margin: clamp(Math.round(home.plan.margin ?? DEFAULT_VILLAGE_MARGIN), 0, 8),
    occupied,
    colors: VILLAGER_COLORS,
  });
  const rivalCluster = clusterFromPlan({
    plan: rival.plan,
    villageId: RIVAL_VILLAGE_ID,
    villagerIds: rival.villagerIds,
    width,
    height,
    cx: cores[1]!.cx,
    cy: cores[1]!.cy,
    margin: clamp(Math.round(rival.plan.margin ?? DEFAULT_VILLAGE_MARGIN), 0, 8),
    occupied,
    colors: RIVAL_VILLAGER_COLORS,
  });

  // Trees fill the rest, kept clear of BOTH cluster cores by each one's own radius, so
  // the two squares + their lanes stay walkable and the forest holds the middle.
  const clearings = [
    { cx: cores[0]!.cx, cy: cores[0]!.cy, keepOut: homeCluster.radius + 6 },
    { cx: cores[1]!.cx, cy: cores[1]!.cy, keepOut: rivalCluster.radius + 6 },
  ];
  const treeCount = clamp(
    Math.round((home.plan.treeCount ?? 0) + (rival.plan.treeCount ?? 0)),
    0,
    Math.floor((width * height) / 20),
  );
  const trees: Tree[] = [];
  for (let i = 0; i < treeCount; i++) {
    const pos = freeTileClearOfCores(width, height, occupied, clearings);
    if (!pos) break;
    occupied.add(tileKey(pos.x, pos.y));
    trees.push({ id: `tree_${i}`, type: 'tree', position: pos });
  }

  const seed: WorldSeed = {
    width,
    height,
    trees,
    villagers: [...homeCluster.cluster.villagers, ...rivalCluster.cluster.villagers],
    buildings: [...homeCluster.cluster.buildings, ...rivalCluster.cluster.buildings],
    carts: [...homeCluster.cluster.carts, ...rivalCluster.cluster.carts],
    // Two grounds on one map: the home palette paints WEST of the midline, the rival
    // palette EAST, so each settlement reads in its own terrain. The split is the
    // territory midline, halfway between the two cores.
    palette: home.plan.palette ?? DEFAULT_TERRAIN_PALETTE,
    rivalPalette: rival.plan.palette ?? DEFAULT_TERRAIN_PALETTE,
    paletteSplitX: Math.floor(width / 2),
  };
  if (home.plan.theme) seed.theme = home.plan.theme;
  if (home.plan.setting) seed.setting = home.plan.setting;
  return seed;
}

/** A free tile at least each core's `keepOut` tiles away from every core centre. */
function freeTileClearOfCores(
  width: number,
  height: number,
  occupied: Set<string>,
  cores: { cx: number; cy: number; keepOut: number }[],
): Vec2 | null {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const x = randInt(0, width);
    const y = randInt(0, height);
    if (occupied.has(tileKey(x, y))) continue;
    if (cores.some((c) => Math.hypot(x - c.cx, y - c.cy) < c.keepOut)) continue;
    return { x, y };
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Chebyshev distance from (x,y) to the village centre. */
function fromCenter(x: number, y: number, cx: number, cy: number): number {
  return Math.max(Math.abs(x - cx), Math.abs(y - cy));
}

/** A free tile at least `keepOut` tiles from the centre (so the core stays clear). */
function freeTileOutside(
  width: number,
  height: number,
  occupied: Set<string>,
  cx: number,
  cy: number,
  keepOut: number,
): Vec2 | null {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const x = randInt(0, width);
    const y = randInt(0, height);
    if (occupied.has(tileKey(x, y))) continue;
    if (fromCenter(x, y, cx, cy) < keepOut) continue;
    return { x, y };
  }
  return null;
}

/** A free tile within `radius` tiles of the centre — for the village folk. */
function freeTileNear(
  width: number,
  height: number,
  occupied: Set<string>,
  cx: number,
  cy: number,
  radius: number,
): Vec2 {
  for (;;) {
    const x = clamp(cx + randInt(-radius, radius + 1), 0, width - 1);
    const y = clamp(cy + randInt(-radius, radius + 1), 0, height - 1);
    if (!occupied.has(tileKey(x, y))) return { x, y };
  }
}
