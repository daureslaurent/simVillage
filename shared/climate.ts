/**
 * shared/climate.ts
 * ---------------------------------------------------------------------------
 * The simulation CLIMATE — pure functions that turn a `tick` (and the current
 * {@link WeatherKind}) into the village's SEASON and TEMPERATURE.
 *
 * Like `shared/simClock.ts`, this file is intentionally RUNTIME-DEPENDENCY-FREE:
 * it is a handful of pure functions over plain numbers, so the engine, the
 * villager minds, and the browser all derive the SAME climate from the SAME
 * tick — no streaming, no drift. Temperature is a deterministic blend of three
 * forces the user can feel:
 *
 *   1. SEASON  — a slow baseline that cycles spring → summer → autumn → winter.
 *   2. DAY/NIGHT — a diurnal swing driven by the shared daylight curve (warm
 *      mid-afternoon, cold before dawn).
 *   3. WEATHER — a per-weather nudge (rain & storm chill, a heatwave bakes).
 *
 * All values are in degrees Celsius. The "village timezone" is UTC (see simClock).
 * ---------------------------------------------------------------------------
 */

import type { WeatherKind } from './types';
import { simTimeFromTick, daylightFromTick } from './simClock';

/** The four seasons, in calendar order. Day 1 of the village is the first day of spring. */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** Seasons in cycle order, so a season index maps straight back to a name. */
export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'] as const;

/**
 * In-world DAYS each season lasts. Kept short on purpose: a day is under an hour
 * of real time, so a 3-day season lets a single play session pass through the
 * whole year (12 days) and actually FEEL the climate turn. Raise for slower years.
 */
export const SIM_DAYS_PER_SEASON = 3;

/** Whole in-world days that make one full year (all four seasons). */
export const SIM_DAYS_PER_YEAR = SIM_DAYS_PER_SEASON * SEASONS.length;

/** The mid-season baseline temperature (°C) each season settles around. */
const SEASON_BASE_C: Record<Season, number> = {
  spring: 13,
  summer: 27,
  autumn: 12,
  winter: 1,
};

/**
 * How wide the DAY/NIGHT temperature swing is (°C, peak-to-baseline) per season —
 * clear summer days bake then cool hard overnight, winter barely moves.
 */
const SEASON_DIURNAL_AMPLITUDE: Record<Season, number> = {
  spring: 7,
  summer: 9,
  autumn: 6,
  winter: 4,
};

/** Per-weather temperature nudge (°C) layered on top of season + time of day. */
const WEATHER_TEMP_DELTA: Record<WeatherKind, number> = {
  clear: 0,
  rain: -3,
  storm: -5,
  fog: -1,
  heatwave: 9,
};

/** Decode a tick into the in-world {@link Season} it falls in (cycles every year). */
export function seasonFromTick(tick: number): Season {
  const day = simTimeFromTick(tick).day; // 1-based
  const index = Math.floor((day - 1) / SIM_DAYS_PER_SEASON) % SEASONS.length;
  return SEASONS[index];
}

/**
 * The village TEMPERATURE (°C) at a tick under the given weather — a deterministic
 * blend of the season baseline, the diurnal day/night swing, and the weather nudge.
 * The daylight curve (0 at midnight … 1 at noon) is re-centred so dawn/dusk read as
 * average and the swing straddles the baseline rather than only adding heat.
 */
export function temperatureFromTick(tick: number, weather: WeatherKind): number {
  const season = seasonFromTick(tick);
  const daylight = daylightFromTick(tick); // 0 deep night … 1 midday
  const diurnal = (daylight - 0.45) * 2 * SEASON_DIURNAL_AMPLITUDE[season];
  const celsius = SEASON_BASE_C[season] + diurnal + WEATHER_TEMP_DELTA[weather];
  return Math.round(celsius);
}
