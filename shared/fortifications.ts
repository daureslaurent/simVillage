/**
 * shared/fortifications.ts
 * ---------------------------------------------------------------------------
 * THE SINGLE SOURCE OF TRUTH for the village's WAR layer — the defensive and
 * offensive structures, the `life` (health) pools every villager and building
 * carries, and the combat constants that turn a raid from a quiet theft into a
 * real contest between two villages.
 *
 * It sits alongside `shared/buildings.ts` (the peace-time economy) and, like it,
 * is intentionally RUNTIME-DEPENDENCY-FREE: only types plus frozen constant
 * tables, safe to import from the engine, the supervisor, and the browser alike.
 *
 * The model in one breath:
 *   - WALLS are impassable 1×1 tiles; a line of them rings a settlement so a raider
 *     can only get in through a GATE (or by battering a breach with a SIEGE RAM).
 *   - A GATE is the ring's one weak point: friends pass freely, a rival passes only
 *     when no DEFENDER is holding it.
 *   - A WATCHTOWER lengthens the village's raid-detection reach (early warning).
 *   - A BARRACKS musters DEFENDERS; a guard posted at a gate/wall fights off raiders.
 *   - A WAR CAMP is the offensive mirror: raiders staged near it strike harder.
 *   - Everything — villager and building — has LIFE. Combat drains it. A wall/gate at
 *     0 life is razed (a breach); a villager at 0 life is DOWNED, not dead: it flees
 *     home and recovers. The village never loses its people, only ground and stores.
 * ---------------------------------------------------------------------------
 */

import type { BuildingKind } from './types';

// ---------------------------------------------------------------------------
// The fortification catalog — which kinds are war structures, and their sides.
// ---------------------------------------------------------------------------

/** Purely DEFENSIVE structures — they protect a settlement, never reach out to harm. */
export const DEFENSIVE_KINDS: readonly BuildingKind[] = ['wall', 'gate', 'watchtower', 'barracks'];

/** Purely OFFENSIVE structures — they exist to press a raid against a rival. */
export const OFFENSIVE_KINDS: readonly BuildingKind[] = ['war_camp', 'siege_ram'];

/** Every fortification kind, defensive and offensive — the full war catalog. */
export const FORTIFICATION_KINDS: readonly BuildingKind[] = [...DEFENSIVE_KINDS, ...OFFENSIVE_KINDS];

/** True when a building kind is any war structure (defensive or offensive). */
export function isFortification(kind: BuildingKind): boolean {
  return (FORTIFICATION_KINDS as readonly string[]).includes(kind);
}

/** True when a building kind is a defensive fortification. */
export function isDefensiveKind(kind: BuildingKind): boolean {
  return (DEFENSIVE_KINDS as readonly string[]).includes(kind);
}

/** True when a building kind is an offensive fortification. */
export function isOffensiveKind(kind: BuildingKind): boolean {
  return (OFFENSIVE_KINDS as readonly string[]).includes(kind);
}

/** True when a building kind is an impassable wall segment — the ring's body. */
export function isWall(kind: BuildingKind): boolean {
  return kind === 'wall';
}

/** True when a building kind is a gate — the passable opening in a wall. */
export function isGate(kind: BuildingKind): boolean {
  return kind === 'gate';
}

/**
 * Whether a finished building's FOOTPRINT physically blocks movement. A WALL blocks
 * (that is its whole purpose); a GATE never does (it is the way through — rivals are
 * stopped at it by a defender, not by the tile). Every other building footprint is
 * already reserved ground regardless, so this table speaks only to the fort kinds.
 */
export function blocksMovement(kind: BuildingKind): boolean {
  return kind === 'wall';
}

// ---------------------------------------------------------------------------
// Footprints — fortifications are placed by a god, not raised on a site, so their
// sizes live here rather than in BUILDABLES. Walls/gates are a single tile so a
// line of them reads as a true wall; the muster buildings are a comfortable block.
// ---------------------------------------------------------------------------

/** Footprint (square, in tiles) for each fortification kind when a god places it. */
export const FORT_FOOTPRINT: Record<string, { width: number; height: number }> = {
  wall: { width: 1, height: 1 },
  gate: { width: 1, height: 1 },
  watchtower: { width: 2, height: 2 },
  barracks: { width: 3, height: 3 },
  war_camp: { width: 3, height: 3 },
  siege_ram: { width: 2, height: 2 },
};

/** The footprint for a fortification kind (defaults to 1×1 for an unlisted kind). */
export function fortFootprint(kind: BuildingKind): { width: number; height: number } {
  return FORT_FOOTPRINT[kind] ?? { width: 1, height: 1 };
}

// ---------------------------------------------------------------------------
// LIFE — the health pools. Every building and villager carries one; combat drains
// it. These caps are the single source the engine seeds from and the client draws
// damage bars against.
// ---------------------------------------------------------------------------

/** A villager's full health. Generous enough that a single skirmish never downs them. */
export const VILLAGER_MAX_LIFE = 100;

/**
 * The life a villager must mend back to before it stops being {@link DOWNED} and
 * rejoins the living — it doesn't pop back up at a sliver, it recovers properly first.
 */
export const VILLAGER_RECOVER_LIFE = 60;

/** Life a downed/peaceful villager mends per in-world round (slow natural healing). */
export const VILLAGER_REGEN_PER_ROUND = 1.5;

/**
 * The full structural health of each building kind. WALLS are stout but a gate is the
 * deliberately softer point; the muster buildings sit between. Ordinary economy/civic
 * buildings (absent here) take the {@link DEFAULT_BUILDING_LIFE} — high, so peacetime
 * play is untouched and only fortifications are realistically contested.
 */
export const BUILDING_MAX_LIFE: Partial<Record<BuildingKind, number>> = {
  wall: 120,
  gate: 80,
  watchtower: 150,
  barracks: 180,
  war_camp: 150,
  siege_ram: 100,
};

/** Health for any building kind not in {@link BUILDING_MAX_LIFE} — a sturdy default. */
export const DEFAULT_BUILDING_LIFE = 200;

/** The full health pool of a building of the given kind. */
export function buildingMaxLife(kind: BuildingKind): number {
  return BUILDING_MAX_LIFE[kind] ?? DEFAULT_BUILDING_LIFE;
}

// ---------------------------------------------------------------------------
// Combat constants — the rates at which life is spent. All are per in-world ROUND
// so the contest advances with simulated time, like the rest of the economy.
// ---------------------------------------------------------------------------

/** How close (Chebyshev tiles) two villagers must be to trade blows. */
export const COMBAT_REACH = 1;

/** Life a defender and a raider each take from one another per round while engaged. */
export const COMBAT_DAMAGE_PER_ROUND = 9;

/** Life a raider strips from a rival WALL/GATE per round while battering it bare-handed. */
export const RAID_WALL_DAMAGE_PER_ROUND = 3;

/** Life a SIEGE RAM strips from a rival wall per round — far faster than bare hands. */
export const SIEGE_RAM_DAMAGE_PER_ROUND = 18;

/** How close a siege ram (or raider) must be to a wall to batter it. */
export const SIEGE_REACH = 2;

/**
 * The detection radius (tiles) a village watches its own ground within for raiders —
 * the base before any watchtower. A raider crossing inside this of a friendly building
 * raises the alarm (a `raid` happening).
 */
export const BASE_DETECTION_RADIUS = 10;

/** Extra detection radius each WATCHTOWER adds — the early-warning payoff. */
export const WATCHTOWER_DETECTION_BONUS = 14;

/** How close a defender must be to a GATE to count as HOLDING it (barring rivals). */
export const GATE_HOLD_REACH = 3;

/** How close a defender must be to a BARRACKS to fight with a mustered edge. */
export const BARRACKS_RALLY_REACH = 8;

/** Damage multiplier a defender fights with while rallied near a friendly barracks. */
export const BARRACKS_DAMAGE_MULT = 1.5;

/** How close a raider must be to a friendly WAR CAMP to strike with a mustered edge. */
export const WAR_CAMP_RALLY_REACH = 8;

/** Damage multiplier a raider fights/batters with while rallied near a friendly war camp. */
export const WAR_CAMP_DAMAGE_MULT = 1.5;

// ---------------------------------------------------------------------------
// Render & description — kept here (not in buildings.ts) so the war layer owns its
// own look and prose, but mirrors the buildings.ts tables so callers read one voice.
// ---------------------------------------------------------------------------

/** Render colour per fortification kind (merged into BUILDING_COLORS by buildings.ts). */
export const FORT_COLORS: Record<string, string> = {
  wall: '#6b6b73',
  gate: '#8a6f3c',
  watchtower: '#7d6b8a',
  barracks: '#7a4a4a',
  war_camp: '#a23f3f',
  siege_ram: '#5a4632',
};

/** One-line purpose per fortification kind (merged into BUILDING_FUNCTIONS). */
export const FORT_FUNCTIONS: Record<string, string> = {
  wall: 'a stout wall segment that bars the way — raiders must find a gate or breach it',
  gate: 'the guarded opening in the wall; friends pass freely, foes only if it goes unheld',
  watchtower: 'a watchtower whose lookouts spot raiders far off, raising the alarm early',
  barracks: 'a barracks where defenders muster and rally to drive off raids',
  war_camp: 'a war camp from which raiders stage and strike at the rival the harder',
  siege_ram: 'a siege ram that batters down a rival wall to force a breach',
};

/**
 * Plain-prose guide lines for a fortification kind — what it is and how it bears on
 * the war. Returns [] for a non-fort kind so callers can simply concat. Mirrors
 * `buildingGuideLines` in shape (first line is the function, then the mechanics).
 */
export function fortificationGuideLines(kind: BuildingKind): string[] {
  if (!isFortification(kind)) return [];
  const fn = FORT_FUNCTIONS[kind] ?? '';
  const lines: string[] = [`The ${kind.replace(/_/g, ' ')} — ${fn}.`];
  switch (kind) {
    case 'wall':
      lines.push('It blocks movement: nothing walks through it. It can be battered down (siege) to a breach.');
      break;
    case 'gate':
      lines.push('It is the way through a wall. A defender standing within a few tiles HOLDS it, barring rivals.');
      break;
    case 'watchtower':
      lines.push('It widens the home village’s watch, so a raiding party is seen — and answered — far sooner.');
      break;
    case 'barracks':
      lines.push('Defenders rally here: a guard posted near it or at a gate fights raiders off with a real edge.');
      break;
    case 'war_camp':
      lines.push('Raiders muster here: those who strike out from near it hit harder and batter walls faster.');
      break;
    case 'siege_ram':
      lines.push('Escort it against a rival wall; over a few rounds it batters the wall’s life to nothing, opening a breach.');
      break;
    default:
      break;
  }
  return lines;
}
