/**
 * shared/simClock.ts
 * ---------------------------------------------------------------------------
 * The simulation CLOCK — the single source of truth for turning the engine's
 * monotonic `tick` counter into an in-world date and time.
 *
 * One tick is one LOGICAL ROUND of the turn coordinator — the unit the in-world
 * clock advances by. It is {@link SIM_SECONDS_PER_TICK} simulated seconds, so the
 * world begins at {@link SIM_EPOCH_ISO} and steps forward that much each round; a
 * villager who has lived 480 ticks has lived one full simulated day. Because the
 * clock is driven by the round tick (not a free-running timer), in-world time HOLDS
 * while a round waits on the LLM and only advances when the round completes.
 *
 * Like `shared/types.ts` and `shared/events.ts`, this file is intentionally
 * RUNTIME-DEPENDENCY-FREE: it declares pure functions over plain numbers and the
 * built-in `Date`, so it is safe to import from the engine, the villager minds,
 * and the browser alike. Everyone derives the same clock from the same `tick`,
 * which keeps the in-world time from ever drifting between services.
 *
 * All arithmetic is done in UTC so the result is identical no matter where the
 * server or a browser happens to run — the "village timezone" is simply UTC.
 * ---------------------------------------------------------------------------
 */

/**
 * Simulated seconds that elapse per tick (one coordinator round) — the world
 * clock's resolution. At 180s a day is 480 rounds; paired with the round floor
 * (~5s+) that keeps an in-world day roughly under an hour of real time, as the
 * original free-running design intended. Raise it for faster days, lower for slower.
 */
export const SIM_SECONDS_PER_TICK = 180;

/** The in-world instant tick 0 corresponds to. The village wakes at dawn, day one. */
export const SIM_EPOCH_ISO = '2025-01-01T06:00:00Z';

/** Epoch as epoch-millis, parsed once. */
const SIM_EPOCH_MS = Date.parse(SIM_EPOCH_ISO);

/** Milliseconds of simulated time in one in-world day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Coarse phase of the day — the granularity a villager actually reasons about. */
export type PartOfDay = 'night' | 'morning' | 'afternoon' | 'evening';

/** A decoded in-world instant, derived purely from a tick. */
export interface SimTime {
  /** The simulated instant as a JS Date (interpret with UTC getters). */
  date: Date;
  /** Whole in-world days elapsed since the epoch, 1-based (the first day is "Day 1"). */
  day: number;
  /** Hour of the in-world day, 0..23. */
  hour: number;
  /** Minute of the in-world hour, 0..59. */
  minute: number;
  /** Coarse part of the day, useful for villager behaviour and the UI. */
  partOfDay: PartOfDay;
}

/** Map an hour-of-day to its coarse {@link PartOfDay}. */
function partOfDay(hour: number): PartOfDay {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * A smooth DAYLIGHT level for a tick — 0 in the dead of night, 1 at midday — so
 * the renderer can fade a night wash and the engine can vary mechanics over the
 * day rather than stepping abruptly between the coarse {@link PartOfDay} bands.
 *
 * Modelled as a raised cosine over the 24h day (peaking at noon, bottoming at
 * midnight), then stretched so dawn/dusk are crisp and midday plateaus bright.
 * The result is a soft sunrise/sunset rather than a switch.
 */
export function daylightFromTick(tick: number): number {
  const t = simTimeFromTick(tick);
  const hours = t.hour + t.minute / 60;
  const base = 0.5 - 0.5 * Math.cos((hours / 24) * 2 * Math.PI); // 0@midnight, 1@noon
  return Math.max(0, Math.min(1, (base - 0.18) / 0.62));
}

/** Decode an engine tick into the in-world date/time it represents. */
export function simTimeFromTick(tick: number): SimTime {
  const ms = SIM_EPOCH_MS + Math.max(0, tick) * SIM_SECONDS_PER_TICK * 1000;
  const date = new Date(ms);
  const day = Math.floor((ms - SIM_EPOCH_MS) / MS_PER_DAY) + 1;
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  return { date, day, hour, minute, partOfDay: partOfDay(hour) };
}

/**
 * The representative wall-clock HOUR each coarse {@link PartOfDay} pins to — the
 * hour an event scheduled loosely "in the morning / afternoon / evening / night"
 * is fixed at. Villagers reason in parts of day, not exact clock times, so the
 * agenda lets a mind say "tomorrow afternoon" and we anchor it here to a concrete
 * hour the simulation can schedule and sort by.
 */
export const PART_OF_DAY_HOUR: Record<PartOfDay, number> = {
  morning: 9,
  afternoon: 15,
  evening: 20,
  night: 2,
};

/**
 * The engine tick at which a given in-world DAY (1-based) and PART OF DAY falls —
 * the inverse of {@link simTimeFromTick} taken at that part's representative hour
 * ({@link PART_OF_DAY_HOUR}). This is what turns a villager's loose "tomorrow
 * afternoon" into a concrete target tick the agenda can schedule, steer toward, and
 * sort a timeline by. In-world days run dawn-to-dawn (the epoch is 06:00), so an
 * hour before 06:00 belongs to the LATE tail of its day, not its start.
 */
export function tickForDayPart(day: number, part: PartOfDay): number {
  const hour = PART_OF_DAY_HOUR[part];
  // Hours elapsed since this in-world day's 06:00 start; pre-dawn hours wrap to its tail.
  const offsetHours = hour >= 6 ? hour - 6 : hour + 18;
  const msOffset = Math.max(0, day - 1) * MS_PER_DAY + offsetHours * 60 * 60 * 1000;
  return Math.round(msOffset / (SIM_SECONDS_PER_TICK * 1000));
}

/** Zero-pad a 0..59 (or 0..23) clock component to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "HH:MM" wall-clock time for a tick, e.g. "06:00". */
export function formatSimTimeOfDay(tick: number): string {
  const t = simTimeFromTick(tick);
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * A compact in-world stamp for HUDs and prompts, e.g. "Day 3 · 14:25".
 * This is the everyday label the simulation shows instead of a raw tick.
 */
export function formatSimClock(tick: number): string {
  const t = simTimeFromTick(tick);
  return `Day ${t.day} · ${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * A fuller, human in-world stamp including the calendar date and the part of
 * day, e.g. "Day 3 (2025-01-03) · 14:25, afternoon". Used where there is room
 * for the long form (the villager's perception, a tooltip).
 */
export function formatSimDateTime(tick: number): string {
  const t = simTimeFromTick(tick);
  const ymd = t.date.toISOString().slice(0, 10); // YYYY-MM-DD, always UTC
  return `Day ${t.day} (${ymd}) · ${pad2(t.hour)}:${pad2(t.minute)}, ${t.partOfDay}`;
}
