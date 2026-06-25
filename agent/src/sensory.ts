/**
 * agent/src/sensory.ts
 * ---------------------------------------------------------------------------
 * Phase 3 — "The Brains". Sensory ingestion.
 *
 * A villager's mind does NOT get a god's-eye view of the world. It only ever
 * perceives what is physically near its body. This module is that filter: it
 * consumes the authoritative `world.events` stream (the same stream the browser
 * renders) and reduces each full world snapshot down to a small, local
 * `Perception` — the handful of villagers and objects within a few tiles of THIS
 * villager — which is all the LLM is ever shown.
 *
 * It is pure, transport-free state: `AgentService` feeds it parsed envelopes
 * and reads back perceptions. Distance is Chebyshev (king-move) tiles, which is
 * the natural "radius" on a square grid.
 * ---------------------------------------------------------------------------
 */

import type { Villager, VillagerNeeds, Tree, Building, CartPhase, ResourceKind, Vec2, WeatherKind } from '../../shared/types';
import type { WorldInitPayload, WorldMapUpdatedPayload } from '../../shared/events';
import { isDepleted, isDepot, SERVICE_REACH } from '../../shared/buildings';
import { sightRadius, hearingRadius, BASE_SENSE_RADIUS } from '../../shared/perception';

/**
 * The bright-and-clear maximum sensing radius (tiles). The ACTUAL sight and
 * hearing reach are derived per-tick from the time of day and the weather (see
 * {@link ../../shared/perception}); this is just their clear-midday ceiling.
 */
export const DEFAULT_SENSE_RADIUS = BASE_SENSE_RADIUS;

/** Another villager the perceiving villager can currently sense. */
export interface PerceivedVillager {
  id: string;
  /** Display name, e.g. "Mira the Blacksmith" — what the mind should call them. */
  name: string;
  position: Vec2;
  /** Chebyshev distance in tiles from the perceiving villager. */
  distance: number;
  /** True if that villager is presently moving toward a target. */
  moving: boolean;
  /** True when within SIGHT this tick — the mind can see them (dimmed at night/in fog). */
  canSee: boolean;
  /** True when within HEARING this tick — close enough to speak to and be heard by. */
  canHear: boolean;
}

/** A static object (today only trees) the villager can sense. */
export interface PerceivedObject {
  id: string;
  type: 'tree';
  position: Vec2;
  distance: number;
}

/** A village building the villager can sense, with its name so it can be discussed. */
export interface PerceivedBuilding {
  id: string;
  kind: string;
  name: string;
  /** What the place is for, so the mind knows why it might matter. */
  function: string;
  /** Chebyshev distance to the nearest tile of the building's footprint. */
  distance: number;
  /** The centre tile — a concrete `move_to` target for "go to this place". */
  position: Vec2;
  /** Live resource stock, by kind (empty for buildings with no resource economy). */
  stock: Partial<Record<ResourceKind, number>>;
  /** Max each resource can hold, so the mind reads stock as a level not a raw count. */
  capacity: number;
  /** True when the place has run dry and can no longer serve until refilled. */
  empty: boolean;
  /**
   * For a construction site only: the materials it still needs to be raised, by kind
   * (its project's totals). Lets the mind see "haul wood here to finish it" rather than
   * guess. Absent on finished buildings.
   */
  needs?: Partial<Record<ResourceKind, number>>;
}

/** A robot-cart the villager can sense, with its order/state so the mind can read it. */
export interface PerceivedCart {
  id: string;
  /** Display name, e.g. "Handcart 1". */
  name: string;
  /** Tier, so the mind knows it is small ("handcart") or large ("freight"). */
  tier: string;
  /** Chebyshev distance to the nearest tile of the cart. */
  distance: number;
  /** The cart's tile — a `move_to` target for walking over to command it. */
  position: Vec2;
  /** How many units it carries now and the most it can. */
  cargoCount: number;
  capacity: number;
  /** The resource currently aboard, or null when empty. */
  cargoResource: string | null;
  /** The standing order, by readable place names, or null when it has none yet. */
  order: { resource: string; fromName: string; toName: string } | null;
  /** What it is doing right now (idle / driving / waiting). */
  phase: CartPhase;
  /** Why it is waiting, when it is (e.g. "the spring has no water"), else null. */
  waitReason: string | null;
  /** True when the villager is close enough to set this cart's order this turn. */
  canCommand: boolean;
}

/**
 * One entry in the village MAP — the whole-settlement reference a mind can pull
 * up via the `consult_map` tool. Unlike a {@link PerceivedBuilding} it is NOT
 * distance-filtered: every building is listed regardless of where the villager
 * stands, with the centre tile so the mind can `move_to` it.
 */
export interface MapEntry {
  id: string;
  kind: string;
  name: string;
  function: string;
  /** The centre tile of the building's footprint — a good `move_to` target. */
  position: Vec2;
  /** Live resource stock, by kind (empty for buildings with no resource economy). */
  stock: Partial<Record<ResourceKind, number>>;
  /** Max each resource can hold. */
  capacity: number;
  /** True when the place has run dry and can no longer serve until refilled. */
  empty: boolean;
  /** For a construction site only: the materials it still needs to be raised, by kind. */
  needs?: Partial<Record<ResourceKind, number>>;
}

/** The local, body-centred snapshot handed to the LLM. */
export interface Perception {
  /** The tick this perception was derived from. */
  tick: number;
  /** The village-wide weather in force this tick (folded into the body block). */
  weather: WeatherKind;
  /** How far the villager can SEE this tick, in tiles (varies with light + weather). */
  sightRadius: number;
  /** How far the villager can HEAR this tick, in tiles (varies with weather). */
  hearingRadius: number;
  /**
   * The villager's own body: where it is, whether it is already walking, the
   * engine-narrated status line, its physical needs, and what it is carrying.
   * This is how a mind stays coherent with the body it inhabits.
   */
  self: {
    id: string;
    position: Vec2;
    idle: boolean;
    /** Whether the body is asleep right now — the mind is dark until it wakes at dawn. */
    asleep: boolean;
    status: string;
    needs: VillagerNeeds;
    backpack: string[];
    /**
     * The gathering this villager is part of this tick (2+ villagers clustered
     * together), or null when it stands apart. Lets the mind speak to the group
     * and remember the company it keeps. `withIds` is the stable key set (for
     * dedup); `withNames` is the same companions by display name, for prose.
     */
    gathering: { withIds: string[]; withNames: string[]; place: string | null } | null;
  };
  /** Other villagers within the sensory radius, nearest first. */
  nearbyVillagers: PerceivedVillager[];
  /** Objects within the sensory radius, nearest first. */
  nearbyObjects: PerceivedObject[];
  /** Village buildings within the sensory radius, nearest first. */
  nearbyBuildings: PerceivedBuilding[];
  /**
   * Robot-carts within the sensory radius, nearest first. When standing at a technical
   * depot ({@link atDepot}) this instead lists EVERY cart in the village, since a depot
   * can dispatch any of them.
   */
  nearbyCarts: PerceivedCart[];
  /**
   * True when the villager is standing at the technical depot — the cart-control
   * station — and so may set the order of ANY cart in {@link nearbyCarts}, not just
   * the ones it is physically beside.
   */
  atDepot: boolean;
}

/** Chebyshev (king-move) distance — the radius metric on a square grid. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Holds just enough world state to answer "what can I sense right now?".
 *
 * Trees arrive once via `world.init` and are remembered. Villager positions are
 * replaced wholesale every `world.map_updated`. The perceiving villager's own body
 * is found by id within that update; until it appears (or if it is ever
 * removed), `perceive()` returns null and the mind simply waits.
 */
export class WorldView {
  private trees: Tree[] = [];
  private buildings: Building[] = [];
  private dimensions: { width: number; height: number } | null = null;
  /**
   * Live building stock, keyed by building id. Buildings arrive once via
   * `world.init` (with their starting stock); their stock then drifts every tick,
   * streamed as `buildingStocks`. We hold the latest here and overlay it onto the
   * static building list so the mind always senses current levels — including when
   * a place has run dry and can no longer serve until someone refills it.
   */
  private liveStock = new Map<string, Partial<Record<ResourceKind, number>>>();

  /** The village-wide weather, learned from `world.init` and `world.weather_changed`. */
  private weather: WeatherKind = 'clear';

  /**
   * Latest id -> display name for every villager seen in the world stream. A
   * villager knows the names of the people it lives among, so the mind reasons
   * and speaks in names ("Mira") rather than raw ids ("villager_2"). Refreshed
   * every snapshot; falls back to the id for anyone not yet seen.
   */
  private readonly names = new Map<string, string>();

  constructor(private readonly selfId: string) {}

  /** The display name of a villager id, or the id itself when not yet known. */
  nameOf(id: string): string {
    return this.names.get(id) ?? id;
  }

  /** Grid bounds, once known — useful for the orchestrator to frame the prompt. */
  get bounds(): { width: number; height: number } | null {
    return this.dimensions;
  }

  /**
   * The whole-village map: every building's name, function, kind and CENTRE
   * tile, regardless of distance. This is the god's-eye reference a mind can
   * deliberately pull up via the `consult_map` tool — the one place it is
   * allowed to see beyond its senses, because a villager is assumed to know the
   * layout of the town it lives in.
   */
  villageMap(): MapEntry[] {
    return this.buildings.map((b) => {
      const stock = this.stockOf(b);
      return {
        id: b.id,
        kind: b.kind,
        name: b.name,
        function: b.function ?? '',
        position: {
          x: Math.floor(b.position.x + b.width / 2),
          y: Math.floor(b.position.y + b.height / 2),
        },
        stock,
        capacity: b.capacity ?? 0,
        empty: isDepleted(b.kind, stock),
        ...(b.construction ? { needs: b.construction.required } : {}),
      };
    });
  }

  /** Record a weather change (from `world.weather_changed`), folded into perception. */
  applyWeather(weather: WeatherKind): void {
    this.weather = weather;
  }

  /** The latest known stock of a building: the live overlay if we have one, else its seed stock. */
  private stockOf(b: Building): Partial<Record<ResourceKind, number>> {
    return this.liveStock.get(b.id) ?? b.stock ?? {};
  }

  /** Record the static world: dimensions + trees + buildings. Called on `world.init`. */
  applyInit(payload: WorldInitPayload): void {
    this.dimensions = { width: payload.width, height: payload.height };
    this.trees = payload.trees;
    this.buildings = payload.buildings ?? [];
    this.weather = payload.weather ?? 'clear';
    // Seed the live-stock overlay from the buildings' own starting stock, so a
    // mind senses correct levels even before the first per-tick stock update.
    this.liveStock.clear();
    for (const b of this.buildings) {
      if (b.stock) this.liveStock.set(b.id, { ...b.stock });
    }
  }

  /**
   * Fold a per-tick world snapshot into a local perception, or null when this
   * villager's body is not present in the snapshot (not yet spawned / despawned).
   */
  perceive(payload: WorldMapUpdatedPayload): Perception | null {
    const self = payload.villagers.find((a) => a.id === this.selfId);
    if (!self) return null;

    // Refresh the name book from this snapshot, so the mind always knows its
    // neighbours by name (every villager carries its display name on the wire).
    for (const a of payload.villagers) this.names.set(a.id, a.name ?? a.id);

    // Fold this tick's building-stock stream into our live overlay before we read
    // any building, so perceived levels (and "empty" flags) are current.
    for (const bs of payload.buildingStocks ?? []) {
      this.liveStock.set(bs.id, bs.stock);
    }

    // Sensing reach is NOT fixed: it shrinks at night and in murk (sight) and
    // when a storm drowns out voices (hearing). Derive both from this tick's
    // time-of-day and weather — the same pure helpers the engine and browser use.
    const sight = sightRadius(payload.tick, this.weather);
    const hearing = hearingRadius(payload.tick, this.weather);
    const senseReach = Math.max(sight, hearing);

    const nearbyVillagers = payload.villagers
      .filter((a): a is Villager => a.id !== this.selfId)
      .map((a) => {
        const distance = chebyshev(self.position, a.position);
        return {
          id: a.id,
          name: a.name ?? a.id,
          position: a.position,
          distance,
          moving: a.target !== null,
          canSee: distance <= sight,
          canHear: distance <= hearing,
        };
      })
      // Keep anyone we can either see OR hear; the flags say which.
      .filter((a) => a.distance <= senseReach)
      .sort((a, b) => a.distance - b.distance);

    const nearbyObjects: PerceivedObject[] = this.trees
      .map((t) => ({
        id: t.id,
        type: 'tree' as const,
        position: t.position,
        distance: chebyshev(self.position, t.position),
      }))
      .filter((o) => o.distance <= sight)
      .sort((a, b) => a.distance - b.distance);

    const nearbyBuildings: PerceivedBuilding[] = this.buildings
      .map((b) => {
        const stock = this.stockOf(b);
        return {
          id: b.id,
          kind: b.kind,
          name: b.name,
          function: b.function ?? '',
          distance: rectDistance(self.position, b),
          position: {
            x: Math.floor(b.position.x + b.width / 2),
            y: Math.floor(b.position.y + b.height / 2),
          },
          stock,
          capacity: b.capacity ?? 0,
          empty: isDepleted(b.kind, stock),
          ...(b.construction ? { needs: b.construction.required } : {}),
        };
      })
      .filter((b) => b.distance <= sight)
      .sort((a, b) => a.distance - b.distance);

    // Standing at the technical depot lets a villager dispatch ANY cart in the
    // village, so when at a depot every cart is commandable AND visible (no need to
    // see it), not just the ones within reach.
    const atDepot = this.buildings.some(
      (b) => isDepot(b.kind) && rectDistance(self.position, b) <= SERVICE_REACH,
    );

    const nearbyCarts: PerceivedCart[] = (payload.carts ?? [])
      .map((c) => {
        const distance = rectDistance(self.position, c);
        return {
          id: c.id,
          name: c.name,
          tier: c.tier,
          distance,
          position: { x: Math.round(c.position.x), y: Math.round(c.position.y) },
          cargoCount: c.cargo.length,
          capacity: c.capacity,
          cargoResource: c.cargo[0] ?? null,
          order: c.order
            ? {
                resource: c.order.resource,
                fromName: this.buildingName(c.order.fromBuildingId),
                toName: this.buildingName(c.order.toBuildingId),
              }
            : null,
          phase: c.phase,
          waitReason: c.waitReason,
          canCommand: atDepot || distance <= SERVICE_REACH,
        };
      })
      .filter((c) => atDepot || c.distance <= sight)
      .sort((a, b) => a.distance - b.distance);

    const myGathering = (payload.gatherings ?? []).find((g) => g.memberIds.includes(this.selfId));
    const withIds = myGathering ? myGathering.memberIds.filter((id) => id !== this.selfId) : [];
    const gathering = myGathering
      ? { withIds, withNames: withIds.map((id) => this.nameOf(id)), place: myGathering.place }
      : null;

    return {
      tick: payload.tick,
      weather: this.weather,
      sightRadius: sight,
      hearingRadius: hearing,
      self: {
        id: self.id,
        position: self.position,
        idle: self.target === null,
        asleep: self.asleep ?? false,
        status: self.status ?? 'Idle',
        needs: self.needs ?? { hunger: 0, thirst: 0, fatigue: 0 },
        backpack: self.backpack ?? [],
        gathering,
      },
      nearbyVillagers,
      nearbyObjects,
      nearbyBuildings,
      nearbyCarts,
      atDepot,
    };
  }

  /** A building's display name from its id, or the id itself when unknown. */
  private buildingName(id: string): string {
    return this.buildings.find((b) => b.id === id)?.name ?? id;
  }
}

/** Chebyshev distance from a point to the nearest tile of a rectangular footprint (building or cart). */
function rectDistance(p: Vec2, b: { position: Vec2; width: number; height: number }): number {
  const dx = Math.max(b.position.x - p.x, 0, p.x - (b.position.x + b.width - 1));
  const dy = Math.max(b.position.y - p.y, 0, p.y - (b.position.y + b.height - 1));
  return Math.max(dx, dy);
}
