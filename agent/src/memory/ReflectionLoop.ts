/**
 * agent/src/memory/ReflectionLoop.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The nightly reflection cron.
 *
 * The reflection synthesis (MemoryStream.reflect) is the *what*; this is the
 * *when*. It is a background job that fires once per simulated night.
 *
 * The trigger is TICK-DRIVEN, not wall-clock-driven: "night" is a property of
 * the simulation's day/night cycle (`SimClock.isNight`), so the loop is fed the
 * world's tick stream and fires the first time it sees night on a day it has not
 * yet reflected on. That de-bounce (one reflection per `dayNumber`) is the whole
 * trick — ticks arrive many times a second, but a villager sleeps once a night.
 *
 * Reflection is fire-and-forget and self-guarded: a slow LLM night-think must
 * never block the sensory/think loop, and a failed reflection is logged and
 * retried next night rather than crashing the mind.
 * ---------------------------------------------------------------------------
 */

import type { KnownPerson, MemoryStream, Reflection } from './MemoryStream';

export interface ReflectionLoopOptions {
  /** The villager's identity, passed into each synthesis prompt. */
  profile: { name: string; traits: string[]; goal: string };
  /** Called with the synthesis when a night's reflection succeeds. */
  onReflection?: (reflection: Reflection) => void;
  /**
   * The people this villager might re-judge tonight (the roster minus self),
   * resolved fresh each night so newcomers are included. Their canonical names
   * are listed in the prompt and used to resolve the reflection's RELATION lines.
   */
  knownPeople?: () => KnownPerson[];
}

/**
 * A tick-fed, once-per-night reflection scheduler. Drive it by calling
 * `onTick(tick)` from wherever the villager already sees world ticks; it decides
 * when a new night has begun and kicks off `MemoryStream.reflect`.
 */
export class ReflectionLoop {
  /** The last day number we have already reflected on (-1 = none yet). */
  private lastReflectedDay = -1;
  /** Guards against overlapping night-thinks if one runs long. */
  private reflecting = false;

  constructor(
    private readonly stream: MemoryStream,
    private readonly options: ReflectionLoopOptions,
  ) {}

  /**
   * Feed the current simulation tick. Fires a reflection the first time we
   * observe night on a day we have not yet reflected on. Cheap to call every
   * tick — it short-circuits unless a fresh night has just begun.
   */
  onTick(tick: number): void {
    if (this.reflecting) return;
    const clock = this.stream.clock;
    if (!clock.isNight(tick)) return;

    const day = clock.dayNumber(tick);
    if (day <= this.lastReflectedDay) return; // already slept on this day
    this.lastReflectedDay = day;

    // Fire-and-forget: never block the caller's tick handler on the LLM.
    void this.runReflection(tick);
  }

  private async runReflection(tick: number): Promise<void> {
    this.reflecting = true;
    try {
      const reflection = await this.stream.reflect(
        tick,
        this.options.profile,
        this.options.knownPeople?.() ?? [],
      );
      if (reflection && this.options.onReflection) this.options.onReflection(reflection);
    } catch (err) {
      console.warn('[reflection] night-think failed, will retry next night:', errMsg(err));
    } finally {
      this.reflecting = false;
    }
  }
}

/**
 * Alternative driver for deployments with no tick stream handy: run reflection
 * on a fixed wall-clock interval instead (e.g. "every real 10 minutes"). Returns
 * a stop handle. Most villagers should prefer the tick-driven `ReflectionLoop`.
 */
export function startWallClockReflection(
  stream: MemoryStream,
  options: ReflectionLoopOptions & { intervalMs: number; tick?: () => number },
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void stream
      .reflect(options.tick?.() ?? 0, options.profile)
      .then((r) => {
        if (r && options.onReflection) options.onReflection(r);
      })
      .catch((err) => console.warn('[reflection] interval night-think failed:', errMsg(err)))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  // Don't keep the process alive solely for reflection.
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
