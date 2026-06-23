/**
 * agent/src/memory/narrative.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". Turning events into narrated memories.
 *
 * A memory is not stored as a struct — it is stored as a SENTENCE, the way the
 * villager would recall it ("At 10:00 AM, Bob told me he is hungry"). That
 * narrative string is what gets embedded and, later, what gets injected back
 * into the prompt, so the model reasons over prose rather than over JSON.
 *
 * Everything here is pure: it maps an event + a clock into a string. The clock
 * is THE simulation clock — `shared/simClock.ts` — where one tick is a fixed
 * span of in-world time (10 sim-seconds). `SimClock` here is a thin façade over
 * it so a villager's MEMORIES ("At 2:25 PM, Bob told me...") are stamped with
 * exactly the same time its PERCEPTION shows it ("Day 3 · 14:25"); the two can
 * never drift, because both derive from the same shared clock and the same tick.
 * ---------------------------------------------------------------------------
 */

import type { Vec2 } from '../../../shared/types';
import type { MemoryKind } from './MemoryStore';
import { simTimeFromTick } from '../../../shared/simClock';

/**
 * Maps simulation ticks onto the in-world day, delegating entirely to the
 * shared clock. Kept as a small class (rather than free functions) so existing
 * consumers — `MemoryStream`, the `ReflectionLoop` — keep their `clock.x(tick)`
 * call sites unchanged.
 */
export class SimClock {
  /** Fraction of the current in-world day elapsed, in [0, 1). */
  fractionOfDay(tick: number): number {
    const { hour, minute } = simTimeFromTick(tick);
    return (hour * 60 + minute) / (24 * 60);
  }

  /** Which day number this tick falls on (1-based, matching the perception clock). */
  dayNumber(tick: number): number {
    return simTimeFromTick(tick).day;
  }

  /** A 12-hour label like "2:25 PM" for the time-of-day of this tick. */
  timeLabel(tick: number): string {
    const { hour, minute } = simTimeFromTick(tick);
    const period = hour < 12 ? 'AM' : 'PM';
    const hours12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hours12}:${String(minute).padStart(2, '0')} ${period}`;
  }

  /** True during the in-world night (00:00–05:59) — when the villager reflects. */
  isNight(tick: number): boolean {
    return simTimeFromTick(tick).partOfDay === 'night';
  }
}

/** The structured facts of a memory before it is narrated + embedded. */
export interface MemorySeed {
  kind: MemoryKind;
  text: string;
  tick: number;
  timestamp: number;
  importance: number;
  participants?: string[];
  location?: Vec2;
}

/** Default salience per kind — reflections matter most, ambient sights least. */
const BASE_IMPORTANCE: Record<MemoryKind, number> = {
  observation: 0.2,
  conversation: 0.5,
  // A private deliberation sits above mere chatter: it is the villager's own
  // worked-out intent, so it should outrank the group's talk in recall and help
  // a mind follow through on what it decided rather than re-negotiating it.
  reasoning: 0.65,
  // Reasoned-out knowledge sits just below a full reflection: more durable and
  // actionable than a single observation, so it should win recall slots.
  fact: 0.75,
  procedure: 0.8,
  reflection: 0.9,
  // Implanted ideas outrank everything so they dominate the very next recall.
  implanted: 1.0,
};

/** Narrate "someone nearby said something aloud", from the listener's point of view. */
export function narrateHeardSpeech(
  args: { speakerId: string; speakerName?: string; message: string; tick: number; location?: Vec2 },
  clock: SimClock,
): MemorySeed {
  const { speakerId, speakerName, message, tick, location } = args;
  return {
    kind: 'conversation',
    text: `At ${clock.timeLabel(tick)}, ${speakerName ?? speakerId} said nearby: "${message}"`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.conversation,
    participants: [speakerId],
    ...(location ? { location } : {}),
  };
}

/** Narrate "I said something aloud" from the speaker's point of view. */
export function narrateOwnSpeech(
  args: { message: string; tick: number; location?: Vec2 },
  clock: SimClock,
): MemorySeed {
  const { message, tick, location } = args;
  return {
    kind: 'conversation',
    text: `At ${clock.timeLabel(tick)}, I said aloud: "${message}"`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.conversation,
    ...(location ? { location } : {}),
  };
}

/**
 * Narrate a PRIVATE deliberation — the `reason` move. Stored close to verbatim in
 * the villager's own inner voice (no "I noticed"/"someone said" framing) because it
 * is the mind talking to itself. Recalled on later turns so a villager follows the
 * thread of its own thinking, and fed into the nightly reflection.
 */
export function narrateReasoning(
  args: { thought: string; tick: number; location?: Vec2 },
  clock: SimClock,
): MemorySeed {
  const { thought, tick, location } = args;
  return {
    kind: 'reasoning',
    text: `At ${clock.timeLabel(tick)}, I thought to myself: ${thought}`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.reasoning,
    ...(location ? { location } : {}),
  };
}

/** Narrate first-sighting of a thing (a new neighbour or a new building/object). */
export function narrateObservation(
  args: { description: string; tick: number; subjectId?: string; location?: Vec2 },
  clock: SimClock,
): MemorySeed {
  const { description, tick, subjectId, location } = args;
  return {
    kind: 'observation',
    text: `At ${clock.timeLabel(tick)}, I noticed ${description}.`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.observation,
    ...(subjectId ? { participants: [subjectId] } : {}),
    ...(location ? { location } : {}),
  };
}

/**
 * Narrate an implanted memory — the "Inception". Stored VERBATIM in the
 * villager's own voice with no "I noticed"/"I reflected" framing, because to
 * them it is simply something they now believe they remember. Maximum
 * importance, so the very next recall surfaces it at the top of the prompt.
 */
export function narrateImplant(
  args: { memory: string; tick: number; source: 'supervisor' | 'user' },
  _clock: SimClock,
): MemorySeed {
  return {
    kind: 'implanted',
    text: args.memory,
    tick: args.tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.implanted,
  };
}

/**
 * Narrate a fact the villager reasoned out at night — a durable piece of world
 * knowledge ("the well by the square is dry"). Stored close to verbatim so it
 * embeds and recalls as the plain statement it is, lightly stamped with the day
 * it was learned.
 */
export function narrateFact(
  args: { fact: string; tick: number },
  clock: SimClock,
): MemorySeed {
  const { fact, tick } = args;
  return {
    kind: 'fact',
    text: `I know that ${fact} (realised on day ${clock.dayNumber(tick)}).`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.fact,
  };
}

/**
 * Narrate a procedure the villager distilled at night — practical know-how for
 * accomplishing something in the world ("to eat, I walk to the bakery and
 * interact with it").
 */
export function narrateProcedure(
  args: { procedure: string; tick: number },
  clock: SimClock,
): MemorySeed {
  const { procedure, tick } = args;
  return {
    kind: 'procedure',
    text: `I have learned how to do something: ${procedure} (day ${clock.dayNumber(tick)}).`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.procedure,
  };
}

/** Narrate a nightly synthesis — the high-importance "Core Belief / Updated Goal". */
export function narrateReflection(
  args: { synthesis: string; tick: number },
  clock: SimClock,
): MemorySeed {
  const { synthesis, tick } = args;
  return {
    kind: 'reflection',
    text: `On the night of day ${clock.dayNumber(tick)}, I reflected: ${synthesis}`,
    tick,
    timestamp: Date.now(),
    importance: BASE_IMPORTANCE.reflection,
  };
}
