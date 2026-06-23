/**
 * server/src/TurnCoordinator.ts
 * ---------------------------------------------------------------------------
 * The simulation's LOGICAL CLOCK — turn-based "ticks" heartbeaten by the LLM.
 *
 * Unlike the world engine's physics tick (which moves bodies several times a
 * second), this is a coarse, turn-based round:
 *
 *   - A TICK is one round in which every ELIGIBLE villager gets exactly one LLM
 *     window. The coordinator grants those windows ONE AT A TIME and waits for
 *     each villager's ack before granting the next, so the single shared llama is
 *     never hit by two minds at once (this also dissolves the thundering-herd
 *     aborts you get when five minds fire together). The tick is therefore paced
 *     by real LLM responses — it is "heartbeaten by the llm response".
 *
 *   - COOLDOWN: when a villager actually ACTS (move/speak/interact) it then sits
 *     out the next `cooldownTicks` rounds — it cannot use the LLM during them —
 *     before becoming eligible again. A turn that merely skips does not trigger a
 *     cooldown. This throttles each mind and staggers LLM load across rounds.
 *
 * The coordinator owns no world state: it tracks only the current tick and each
 * villager's cooldown, drives the round loop, and announces every round on
 * `simulation.events` (`sim.tick`) for observers (the debug window).
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES, type SimTurnDoneEvent, type WorldMapUpdatedEvent } from '../../shared/events';

export interface TurnCoordinatorOptions {
  /** The villager ids that take turns, in grant order. */
  roster: string[];
  /** Rounds a villager rests after acting before it may use the LLM again. */
  cooldownTicks?: number;
  /**
   * Per-action overrides of {@link cooldownTicks}, keyed by decision kind. Lets the
   * cooldown match the action: a sustained one rests longer (starting `work_at` keeps
   * the villager at the task in the engine, so it should not re-think for a while),
   * while speech rests barely at all so a conversation can actually flow — a villager
   * must be able to REPLY quickly to what was just said, not once every few rounds.
   * Defaults to `{ work_at: 5, say: 1, reason: 1 }` — private deliberation (`reason`)
   * rests barely at all, so a villager can think one turn and act the next.
   */
  cooldownByKind?: Record<string, number>;
  /**
   * Safety cap on how long to wait for one villager's turn ack before moving on,
   * so a hung mind can't freeze the clock. Must exceed the LLM call timeout.
   */
  turnTimeoutMs?: number;
  /**
   * MINIMUM wall-clock duration of one round (ms). A round lasts `max(minRoundMs,
   * time to do all this round's LLM calls)`: if the LLM work finishes sooner we wait
   * out the remainder, and if it runs longer the round simply takes that long. This
   * gives the simulation a steady heartbeat (≥ this floor) instead of sprinting
   * whenever the model is quick or every villager is on cooldown. Defaults to 5s.
   */
  minRoundMs?: number;
  /** The first tick number. Defaults to 1. */
  startTick?: number;
}

/** The outcome of one villager's granted turn, used to size its cooldown. */
interface TurnResult {
  acted: boolean;
  /** The kind of action taken, when one was (drives the per-action cooldown). */
  decisionKind?: string;
}

export class TurnCoordinator {
  private readonly roster: string[];
  private readonly cooldownTicks: number;
  private readonly cooldownByKind: Record<string, number>;
  private readonly turnTimeoutMs: number;
  private readonly minRoundMs: number;

  /** The round currently in progress. */
  private tick: number;
  /** villagerId -> first tick at which it may use the LLM again. */
  private readonly cooldownUntil = new Map<string, number>();
  /** villagerId -> resolver for the turn we are presently awaiting, if any. */
  private readonly pending = new Map<string, (result: TurnResult) => void>();

  /**
   * Villagers currently ASLEEP, tracked off the world stream. A sleeper's mind is
   * dark: it is skipped when choosing who acts this round, so it is never granted
   * an LLM turn until the engine wakes it (and drops it from this set).
   */
  private readonly asleep = new Set<string>();

  private running = false;

  constructor(
    private readonly bus: EventBus,
    options: TurnCoordinatorOptions,
  ) {
    this.roster = options.roster;
    this.cooldownTicks = options.cooldownTicks ?? 3;
    // say rests 2 rounds (not 1): on the live model, a 1-round speech cooldown let a
    // pair greet every single round and never get to their trade. 2 still lets a reply
    // land promptly while leaving room for action; reason stays cheap (think→act next
    // round); work_at rests longest since the engine keeps the body at the task.
    this.cooldownByKind = options.cooldownByKind ?? { work_at: 5, say: 2, reason: 1 };
    this.turnTimeoutMs = options.turnTimeoutMs ?? 130_000;
    this.minRoundMs = options.minRoundMs ?? 5_000;
    this.tick = options.startTick ?? 1;
  }

  async start(): Promise<void> {
    await this.bus.subscribe<SimTurnDoneEvent>(EXCHANGES.simulation, 'sim.turn_done', (event) =>
      this.onTurnDone(event),
    );
    // Track who is asleep off the world stream, so sleeping minds are never granted
    // an LLM turn. The engine owns the sleep state; we mirror it for eligibility.
    await this.bus.subscribe<WorldMapUpdatedEvent>(
      EXCHANGES.worldEvents,
      'world.map_updated',
      (event) => {
        this.asleep.clear();
        for (const v of event.payload.villagers) if (v.asleep) this.asleep.add(v.id);
      },
    );
    this.running = true;
    const overrides = Object.entries(this.cooldownByKind)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(
      `[coordinator] turn clock running: ${this.roster.length} villager(s), ` +
        `cooldown ${this.cooldownTicks} tick(s)${overrides ? ` (${overrides})` : ''}, ` +
        `min round ${this.minRoundMs}ms`,
    );
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    // Release any in-flight wait so the loop can unwind.
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ acted: false });
    }
  }

  // -------------------------------------------------------------------------

  /** The round loop: announce the tick, run each eligible villager, advance. */
  private async loop(): Promise<void> {
    while (this.running) {
      const roundStart = Date.now();
      const tick = this.tick;
      const eligible = this.roster.filter(
        (id) => (this.cooldownUntil.get(id) ?? 0) <= tick && !this.asleep.has(id),
      );

      this.announce(tick, eligible);

      for (const id of eligible) {
        if (!this.running) return;
        const { acted, decisionKind } = await this.takeTurn(id, tick);
        // Acting starts the cooldown — its length depends on the action taken (e.g.
        // starting work rests longer), falling back to the default.
        if (acted) {
          const override = decisionKind ? this.cooldownByKind[decisionKind] : undefined;
          const rest = override ?? this.cooldownTicks;
          this.cooldownUntil.set(id, tick + rest + 1);
        }
      }

      // The round is over: tell the minds to apply the decisions they buffered this
      // tick, so all of a round's actions land together at the END of the tick.
      this.bus.publish(EXCHANGES.simulation, makeEvent('sim.tick_end', { tick }));

      this.tick = tick + 1;
      // Hold the round to its minimum duration: a round lasts max(minRoundMs, the
      // time the LLM calls took). If the calls (or an all-cooldown round) finished
      // sooner, wait out the remainder so the clock keeps a steady ≥10s heartbeat;
      // if they overran the floor, advance immediately.
      const remaining = this.minRoundMs - (Date.now() - roundStart);
      if (this.running && remaining > 0) await sleep(remaining);
    }
  }

  /**
   * Grant `id` its window and resolve when it acks (or the safety timeout fires).
   * Resolves with the turn's outcome (whether it acted and what it did), which
   * drives the length of its cooldown.
   */
  private takeTurn(id: string, tick: number): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      let settled = false;
      const finish = (result: TurnResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ acted: false }), this.turnTimeoutMs);
      this.pending.set(id, finish);
      this.bus.publish(EXCHANGES.simulation, makeEvent('sim.turn_granted', { villagerId: id, tick }));
    });
  }

  /** A villager finished its granted turn. */
  private onTurnDone(event: SimTurnDoneEvent): void {
    const { villagerId, acted, decisionKind } = event.payload;
    this.pending.get(villagerId)?.({ acted, ...(decisionKind ? { decisionKind } : {}) });
  }

  /** Publish the round's `sim.tick`, with who is acting and who is resting. */
  private announce(tick: number, eligible: string[]): void {
    const cooldown: Record<string, number> = {};
    for (const id of this.roster) {
      const remaining = (this.cooldownUntil.get(id) ?? 0) - tick;
      if (remaining > 0) cooldown[id] = remaining;
    }
    this.bus.publish(
      EXCHANGES.simulation,
      makeEvent('sim.tick', { tick, acting: eligible, cooldown }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
