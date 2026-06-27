/**
 * client/src/react/villageModel.ts
 * ---------------------------------------------------------------------------
 * The client-side MULTI-VILLAGE view-model. The wire delivers village data in
 * scattered pieces — a 0..100 scoreboard, a per-village census, prayers/acts/
 * alerts each tagged with a `villageId`, and a flat entity list whose members
 * carry their own `villageId`. This module folds all of that into one
 * {@link VillageVM} per village, the single shape every React panel renders.
 *
 * It is PURE and framework-free (no React import) so it can be unit-reasoned and
 * memoised by the store. Built for N villages (3+), never hard-coded to two: the
 * village id set is the UNION of every source, so a third settlement appears the
 * moment any of its data does.
 * ---------------------------------------------------------------------------
 */

import type {
  DigestEvent,
  ResourceKind,
  SupervisorActionMessage,
  SupervisorPrayerMessage,
  TerrainPalette,
  VillageCensus,
  VillageScoreboard,
  VillageScorePillars,
} from '../../../shared/types';
import { DEFAULT_VILLAGE_ID, RIVAL_VILLAGE_ID } from '../../../shared/types';
import type { WorldView } from '../NetworkClient';

/** One world alert (raid/famine/…) as the UI carries it, with a stable id for keys. */
export interface AlertVM {
  /** A synthetic id (villageId + tick + seq) so React lists stay keyed/stable. */
  id: string;
  villageId: string;
  event: DigestEvent;
}

/** The fully-merged view of a single village — what every panel renders against. */
export interface VillageVM {
  id: string;
  /** Display name: the scoreboard's label if known, else a friendly fallback. */
  name: string;
  /** Themed ground palette (home → `palette`, rival → `rivalPalette`); null if unknown. */
  palette: TerrainPalette | null;
  /** Headcount: census when present, else a live count of entities tagged to the village. */
  population: number;
  /** Stored resources across the village's buildings (census; empty until the first pulse). */
  resources: Partial<Record<ResourceKind, number>>;
  /** Standing structures by kind (census). */
  structures: { kind: string; count: number }[];
  /** How many structures are fortifications (census). */
  fortCount: number;
  /** Blended 0..100 standing, or null before the first scoreboard. */
  score: number | null;
  /** The growth/social/defense breakdown, or null before the first scoreboard. */
  pillars: VillageScorePillars | null;
  /** True when this village leads the scoreboard (and there is a rival to lead). */
  isLeader: boolean;
  /** This village's pending/!resolved prayers, newest first. */
  prayers: SupervisorPrayerMessage[];
  /** This village's recent divine acts, newest first. */
  actions: SupervisorActionMessage[];
  /** This village's recent world alerts, newest first. */
  alerts: AlertVM[];
}

/** Everything the selector needs to assemble the per-village view-models. */
export interface VillageModelInput {
  view: WorldView;
  scoreboard: VillageScoreboard | null;
  census: VillageCensus[];
  prayers: SupervisorPrayerMessage[];
  actions: SupervisorActionMessage[];
  alerts: AlertVM[];
}

/** A readable default name for a village when the scoreboard hasn't labelled it yet. */
function fallbackName(villageId: string): string {
  if (villageId === DEFAULT_VILLAGE_ID) return 'Home village';
  if (villageId === RIVAL_VILLAGE_ID) return 'Rival village';
  // village_2 → "Village 2"; otherwise just title-case the id.
  const n = /village_(\d+)/.exec(villageId)?.[1];
  return n ? `Village ${n}` : villageId;
}

/** The ground palette a village reads in (home = west, rival = east). */
function paletteFor(villageId: string, view: WorldView): TerrainPalette | null {
  if (villageId === DEFAULT_VILLAGE_ID) return view.palette;
  if (villageId === RIVAL_VILLAGE_ID) return view.rivalPalette;
  return null; // >2-village palettes aren't sent yet
}

/**
 * Fold every per-village source into one {@link VillageVM} array, sorted by score
 * (leader first), then population, then id — stable and head-to-head readable.
 */
export function selectVillages(input: VillageModelInput): VillageVM[] {
  const { view, scoreboard, census, prayers, actions, alerts } = input;

  // 1) The village id set = union of every source, so a new village shows the moment
  //    any of its data arrives. (Trees are neutral terrain and carry no villageId.)
  const ids = new Set<string>();
  for (const s of scoreboard?.scores ?? []) ids.add(s.villageId);
  for (const c of census) ids.add(c.villageId);
  for (const v of view.villagers) ids.add(v.villageId ?? DEFAULT_VILLAGE_ID);
  for (const b of view.buildings) ids.add(b.villageId ?? DEFAULT_VILLAGE_ID);
  // A brand-new world (no entities yet) still shows the home village so the UI isn't blank.
  if (ids.size === 0) ids.add(DEFAULT_VILLAGE_ID);

  // 2) Index the per-village inputs once.
  const censusById = new Map(census.map((c) => [c.villageId, c]));
  const scoreById = new Map((scoreboard?.scores ?? []).map((s) => [s.villageId, s]));
  const leaderId =
    scoreboard && scoreboard.scores.length > 1 ? scoreboard.scores[0]!.villageId : null;

  // Live entity counts as a population fallback before the first census pulse.
  const liveCount = new Map<string, number>();
  for (const v of view.villagers) {
    const id = v.villageId ?? DEFAULT_VILLAGE_ID;
    liveCount.set(id, (liveCount.get(id) ?? 0) + 1);
  }

  const bucket = <T extends { villageId: string }>(items: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const it of items) {
      const arr = m.get(it.villageId) ?? [];
      arr.push(it);
      m.set(it.villageId, arr);
    }
    return m;
  };
  const prayersBy = bucket(prayers);
  const actionsBy = bucket(actions);
  const alertsBy = bucket(alerts);

  // 3) Build each VM.
  const vms: VillageVM[] = [...ids].map((id) => {
    const c = censusById.get(id);
    const s = scoreById.get(id);
    return {
      id,
      name: s?.villageName ?? fallbackName(id),
      palette: paletteFor(id, view),
      population: c?.population ?? liveCount.get(id) ?? 0,
      resources: c?.resources ?? {},
      structures: c?.structures ?? [],
      fortCount: c?.fortCount ?? 0,
      score: s?.overall ?? null,
      pillars: s?.pillars ?? null,
      isLeader: id === leaderId,
      prayers: prayersBy.get(id) ?? [],
      actions: actionsBy.get(id) ?? [],
      alerts: alertsBy.get(id) ?? [],
    };
  });

  // 4) Sort: leader/score first, then bigger village, then id for stability.
  vms.sort((a, b) => {
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sb !== sa) return sb - sa;
    if (b.population !== a.population) return b.population - a.population;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return vms;
}
