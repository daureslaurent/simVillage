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

import type { Building, BuildingKind, ResourceKind, Villager, Tree, Vec2, WorldSeed } from '../../../shared/types';
import {
  BUILDING_CAPACITY,
  BUILDING_COLORS,
  BUILDING_FUNCTIONS,
  buildingStockKinds,
} from '../../../shared/buildings';

/** Default world size, per the Phase 1 spec. */
export const DEFAULT_WIDTH = 500;
export const DEFAULT_HEIGHT = 500;

/** A small palette so the handful of starter villagers are visually distinct. */
const VILLAGER_COLORS = ['#ff4d4d', '#4dafff', '#ffd24d', '#9b5dff', '#4dffa1', '#ff9f4d'];

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
    // Seed each building partly stocked (40–100%) so some places run dry during
    // play and villagers have a reason to go refill them from the very first day.
    const stock: Partial<Record<ResourceKind, number>> = {};
    for (const r of buildingStockKinds(bp.kind)) {
      stock[r] = randInt(Math.floor(BUILDING_CAPACITY * 0.4), BUILDING_CAPACITY + 1);
    }
    buildings.push({
      id: `building_${bp.kind}_${i}`,
      type: 'building',
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
    return {
      id,
      // Display name is filled in at boot from the persona roster; until then,
      // the id is a safe placeholder.
      name: id,
      type: 'villager',
      position: pos,
      target: null,
      color: VILLAGER_COLORS[i % VILLAGER_COLORS.length]!,
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

  return { width, height, trees, villagers, buildings };
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
