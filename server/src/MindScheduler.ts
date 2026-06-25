/**
 * server/src/MindScheduler.ts
 * ---------------------------------------------------------------------------
 * The village's MIND SCHEDULER — who thinks, when, and how many at once.
 *
 * This replaces the old lockstep round-robin (one mind at a time, fixed
 * per-action cooldown). Minds now think in PARALLEL across the LLM endpoint pool,
 * and decide WHEN to think on a "hybrid heartbeat + interrupt" rule:
 *
 *   - INTERRUPT — a mind that senses something change around it (spoken to, a
 *     neighbour comes near, a need turns urgent) publishes `mind.wants_turn` with
 *     an urgency; the scheduler raises its priority and grants it a window as soon
 *     as an endpoint is free. A high-enough urgency even bypasses its cooldown, so
 *     a villager can REPLY the moment it's addressed.
 *   - HEARTBEAT — a mind that's had nothing happen still gets a slow baseline turn
 *     every {@link IDLE_HEARTBEAT_MS}, so idle villagers keep living.
 *
 * Concurrency is bounded by the pool's CAPACITY (= number of endpoints): the
 * scheduler keeps at most that many grants in flight, picking the highest-urgency,
 * then stalest, ready minds. After a mind acts, it rests a cooldown sized by the
 * action it took (starting work rests longest; speaking barely at all). The
 * scheduler owns no world state — it tracks each mind's urgency/cooldown/last-turn,
 * mirrors the asleep set off the world stream, and announces each cycle on
 * `simulation.events` (`sim.tick`) for the debug window.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import {
  EXCHANGES,
  type MindWantsTurnEvent,
  type SimTurnDoneEvent,
  type WorldMapUpdatedEvent,
} from '../../shared/events';

export interface MindSchedulerOptions {
  /**
   * How many minds may think AT ONCE — the pool's parallel capacity (= number of
   * endpoints). The scheduler never keeps more than this many grants in flight.
   * Defaults to 1 (serial, like the old coordinator) if discovery failed.
   */
  capacity: number;
  /** A mind with nothing happening still thinks at least this often, in ms. Default 30s. */
  idleHeartbeatMs?: number;
  /** Urgency at/above which a mind is considered "wants to think now". Default 0.4. */
  interruptThreshold?: number;
  /** Urgency at/above which an interrupt BYPASSES the post-action cooldown. Default 0.9. */
  bypassCooldownUrgency?: number;
  /** Per-action rest after acting, in ms, keyed by decision kind. Sensible defaults below. */
  cooldownByKindMs?: Record<string, number>;
  /** Default rest after acting when the kind has no specific entry, in ms. Default 8s. */
  defaultCooldownMs?: number;
  /** Safety cap: free a grant whose ack never came after this long, in ms. Default 140s. */
  turnTimeoutMs?: number;
  /** How often the dispatch loop runs, in ms. Default 250ms. */
  cycleMs?: number;
}

/** Per-mind scheduling state. */
interface MindState {
  /** Latest interrupt urgency (0..1), reset to 0 when granted a turn. */
  urgency: number;
  /** Wall-clock time this mind may next be granted (post-action cooldown). */
  cooldownUntil: number;
  /** Wall-clock time of its last grant (0 = never), for heartbeat + staleness. */
  lastGrantedAt: number;
  /** When the in-flight grant was issued, or 0 when not thinking — for the timeout. */
  grantedAt: number;
}

export class MindScheduler {
  private readonly capacity: number;
  private readonly idleHeartbeatMs: number;
  private readonly interruptThreshold: number;
  private readonly bypassCooldownUrgency: number;
  private readonly cooldownByKindMs: Record<string, number>;
  private readonly defaultCooldownMs: number;
  private readonly turnTimeoutMs: number;
  private readonly cycleMs: number;

  /** Every mind that has a live brain (added by the registry), with its state. */
  private readonly minds = new Map<string, MindState>();
  /** Minds asleep right now (mirrored off the world stream) — never granted a turn. */
  private readonly asleep = new Set<string>();
  /** The latest in-world tick, off the world stream, used to stamp grants. */
  private tick = 0;

  private loop: ReturnType<typeof setInterval> | null = null;
  /** Signature of the last `sim.tick` we published, so we only re-emit on a real change. */
  private lastAnnounce = '';

  constructor(
    private readonly bus: EventBus,
    options: MindSchedulerOptions,
  ) {
    this.capacity = Math.max(1, options.capacity);
    this.idleHeartbeatMs = options.idleHeartbeatMs ?? 30_000;
    this.interruptThreshold = options.interruptThreshold ?? 0.4;
    this.bypassCooldownUrgency = options.bypassCooldownUrgency ?? 0.9;
    this.defaultCooldownMs = options.defaultCooldownMs ?? 8_000;
    this.cooldownByKindMs = options.cooldownByKindMs ?? {
      // Starting work keeps the body at the task in the engine, so rest longest.
      work_at: 20_000,
      build: 18_000,
      // Speaking rests barely at all, so a reply can land promptly and a dialogue flows.
      say: 3_000,
      // Private deliberation is cheap — think one turn, act the next.
      reason: 2_000,
      // Moving somewhere takes time to walk; no need to re-think every step.
      move_to: 6_000,
    };
    this.turnTimeoutMs = options.turnTimeoutMs ?? 140_000;
    this.cycleMs = options.cycleMs ?? 250;
  }

  async start(): Promise<void> {
    // A mind asks for an out-of-turn window: record its urgency (keep the highest).
    await this.bus.subscribe<MindWantsTurnEvent>(EXCHANGES.simulation, 'mind.wants_turn', (event) => {
      const state = this.minds.get(event.payload.villagerId);
      if (state) state.urgency = Math.max(state.urgency, clamp01(event.payload.urgency));
    });

    // A mind finished its turn: free its slot and start its cooldown, sized by action.
    await this.bus.subscribe<SimTurnDoneEvent>(EXCHANGES.simulation, 'sim.turn_done', (event) =>
      this.onTurnDone(event.payload),
    );

    // Track the live tick + who is asleep off the world stream. A sleeper's mind is
    // dark, so it is never a candidate until the engine wakes it.
    await this.bus.subscribe<WorldMapUpdatedEvent>(
      EXCHANGES.worldEvents,
      'world.map_updated',
      (event) => {
        this.tick = event.payload.tick;
        this.asleep.clear();
        for (const v of event.payload.villagers) if (v.asleep) this.asleep.add(v.id);
      },
    );

    this.loop = setInterval(() => this.dispatch(), this.cycleMs);
    console.log(
      `[scheduler] minds run in parallel — capacity ${this.capacity}, ` +
        `heartbeat ${this.idleHeartbeatMs}ms, interrupt ≥${this.interruptThreshold}`,
    );
  }

  stop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  /** Register a live mind so it starts taking turns (called by the registry on spawn). */
  add(villagerId: string): void {
    if (this.minds.has(villagerId)) return;
    // lastGrantedAt = 0 makes a fresh mind immediately heartbeat-eligible, so a
    // newly spawned villager comes alive on the next cycle.
    this.minds.set(villagerId, { urgency: 0, cooldownUntil: 0, lastGrantedAt: 0, grantedAt: 0 });
    console.log(`[scheduler] mind added: ${villagerId} (${this.minds.size} live)`);
  }

  /** Drop a mind (called by the registry on despawn) so it's no longer granted turns. */
  remove(villagerId: string): void {
    if (this.minds.delete(villagerId)) {
      console.log(`[scheduler] mind removed: ${villagerId} (${this.minds.size} live)`);
    }
  }

  // -------------------------------------------------------------------------

  /** One dispatch cycle: free hung grants, then grant ready minds up to capacity. */
  private dispatch(): void {
    const now = Date.now();

    // Reclaim slots whose ack never arrived (a hung mind), so the clock can't freeze.
    for (const [id, s] of this.minds) {
      if (s.grantedAt > 0 && now - s.grantedAt > this.turnTimeoutMs) {
        s.grantedAt = 0;
        s.cooldownUntil = now + this.defaultCooldownMs;
        console.warn(`[scheduler] turn timed out for ${id}; reclaiming slot`);
      }
    }

    let inFlight = 0;
    for (const s of this.minds.values()) if (s.grantedAt > 0) inFlight++;

    const ready = this.readyMinds(now);
    for (const id of ready) {
      if (inFlight >= this.capacity) break;
      this.grant(id, now);
      inFlight++;
    }

    this.announce(now);
  }

  /** Ready minds (off cooldown / urgent enough / due a heartbeat), best candidate first. */
  private readyMinds(now: number): string[] {
    const ready: Array<{ id: string; s: MindState }> = [];
    for (const [id, s] of this.minds) {
      if (s.grantedAt > 0 || this.asleep.has(id)) continue; // busy or sleeping
      const cooled = now >= s.cooldownUntil;
      const wants = s.urgency >= this.interruptThreshold;
      const bypass = s.urgency >= this.bypassCooldownUrgency; // urgent enough to skip rest
      const heartbeat = now - s.lastGrantedAt >= this.idleHeartbeatMs;
      if ((cooled && (wants || heartbeat)) || bypass) ready.push({ id, s });
    }
    // Highest urgency first; then the mind that has waited longest (stalest).
    ready.sort((a, b) => b.s.urgency - a.s.urgency || a.s.lastGrantedAt - b.s.lastGrantedAt);
    return ready.map((r) => r.id);
  }

  /** Grant `id` an LLM window: stamp it in-flight and publish the turn. */
  private grant(id: string, now: number): void {
    const s = this.minds.get(id)!;
    s.grantedAt = now;
    s.lastGrantedAt = now;
    s.urgency = 0; // consumed by this turn
    this.bus.publish(EXCHANGES.simulation, makeEvent('sim.turn_granted', { villagerId: id, tick: this.tick }));
  }

  /** A mind acked its turn: free the slot, start its cooldown sized by the action. */
  private onTurnDone(payload: { villagerId: string; acted: boolean; decisionKind?: string }): void {
    const s = this.minds.get(payload.villagerId);
    if (!s) return;
    s.grantedAt = 0;
    // Only acting earns a rest; a skipped/idle turn stays eligible (it may need to
    // react again right away). Cooldown length follows the action taken.
    if (payload.acted) {
      const base = (payload.decisionKind && this.cooldownByKindMs[payload.decisionKind]) || this.defaultCooldownMs;
      s.cooldownUntil = Date.now() + base;
    }
  }

  /**
   * Publish `sim.tick` (who's thinking + who's cooling) for the debug window — but
   * ONLY when the picture changed (the in-world tick advanced, or the thinking/cooling
   * sets shifted). The dispatch cycle runs 4×/s; without this gate it would spam every
   * client and wreck the panel's sec/tick gauge. An idle village goes quiet until the
   * clock ticks (~every SIM_TICK_REAL_MS), which is the cadence the panel should show.
   */
  private announce(now: number): void {
    const acting: string[] = [];
    const cooldown: Record<string, number> = {};
    for (const [id, s] of this.minds) {
      if (s.grantedAt > 0) acting.push(id);
      const remainingMs = s.cooldownUntil - now;
      if (remainingMs > 0) cooldown[id] = Math.ceil(remainingMs / 1000); // seconds left
    }
    const signature = `${this.tick}|${acting.sort().join(',')}|${Object.keys(cooldown).sort().join(',')}`;
    if (signature === this.lastAnnounce) return;
    this.lastAnnounce = signature;
    this.bus.publish(EXCHANGES.simulation, makeEvent('sim.tick', { tick: this.tick, acting, cooldown }));
  }
}

/** Clamp a number to the 0..1 urgency range. */
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
