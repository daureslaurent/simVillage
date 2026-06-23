/**
 * shared/perception.ts
 * ---------------------------------------------------------------------------
 * How far a villager can SENSE the world — split into SIGHT and HEARING, and
 * varied by the time of day and the weather.
 *
 * Like {@link ./simClock} this file is intentionally RUNTIME-DEPENDENCY-FREE:
 * it is a handful of pure functions over a `tick` and a {@link WeatherKind}, so
 * the engine, the villager minds, and the browser can all DERIVE the same two
 * radii from the same inputs. Nobody streams a sensing radius over the wire any
 * more — everyone computes it locally and identically, exactly as everyone
 * derives the clock from the tick.
 *
 * The model, in words:
 *   • SIGHT shrinks at night and in murk. It scales with the smooth daylight
 *     curve (bright at noon, dim at midnight) AND the weather (fog blinds, a
 *     storm's rain greys things out, a heatwave shimmers). You see furthest on a
 *     clear afternoon, least in a midnight fog.
 *   • HEARING does NOT care about light — you hear just as far in the dark — but
 *     a storm's wind and thunder drown distant voices, and rain dulls them a
 *     little. Fog, famously, carries sound, so it leaves hearing untouched.
 *
 * Both are floored so a villager is never struck deaf or blind: there is always
 * a small bubble of awareness around the body.
 * ---------------------------------------------------------------------------
 */

import type { WeatherKind } from './types';
import { daylightFromTick } from './simClock';

/**
 * The baseline sensing radius, in tiles, on a clear midday — the reach both
 * sight and hearing are scaled DOWN from. This is the old single `senseRadius`
 * default (8), kept as the bright-and-clear maximum.
 */
export const BASE_SENSE_RADIUS = 8;

/** A villager is never blinded/deafened below this many tiles of awareness. */
export const MIN_SIGHT_RADIUS = 2;
export const MIN_HEARING_RADIUS = 2;

/** Per-weather sight multiplier (1 = full reach, <1 = murk cuts vision). */
const WEATHER_SIGHT: Record<WeatherKind, number> = {
  clear: 1.0,
  rain: 0.8,
  storm: 0.55,
  fog: 0.4, // the great blinder
  heatwave: 0.85, // shimmering haze
};

/** Per-weather hearing multiplier (1 = full reach, <1 = noise drowns voices). */
const WEATHER_HEARING: Record<WeatherKind, number> = {
  clear: 1.0,
  rain: 0.85,
  storm: 0.5, // wind + thunder drown distant speech
  fog: 1.0, // fog carries sound
  heatwave: 1.0,
};

/**
 * How much of full sight survives the dark: at midnight (daylight 0) a villager
 * still sees this fraction of its weather-adjusted range; at noon (daylight 1)
 * it sees all of it. Keeps night dim without rendering villagers stone-blind.
 */
const NIGHT_SIGHT_FLOOR = 0.35;

/** Round a scaled radius to whole tiles, never below `min`. */
function clampRadius(value: number, min: number): number {
  return Math.max(min, Math.round(value));
}

/**
 * How far this villager can SEE this tick, in tiles. Scaled by both the daylight
 * curve and the weather's sight multiplier, floored at {@link MIN_SIGHT_RADIUS}.
 */
export function sightRadius(tick: number, weather: WeatherKind): number {
  const daylight = daylightFromTick(tick); // 0 at midnight … 1 at noon
  const lightFactor = NIGHT_SIGHT_FLOOR + (1 - NIGHT_SIGHT_FLOOR) * daylight;
  return clampRadius(BASE_SENSE_RADIUS * WEATHER_SIGHT[weather] * lightFactor, MIN_SIGHT_RADIUS);
}

/**
 * How far this villager can HEAR this tick, in tiles. Independent of light;
 * scaled only by the weather's hearing multiplier, floored at
 * {@link MIN_HEARING_RADIUS}.
 */
export function hearingRadius(_tick: number, weather: WeatherKind): number {
  // `_tick` is unused today (light doesn't affect hearing) but kept in the
  // signature so callers can pass (tick, weather) uniformly with sightRadius.
  return clampRadius(BASE_SENSE_RADIUS * WEATHER_HEARING[weather], MIN_HEARING_RADIUS);
}
