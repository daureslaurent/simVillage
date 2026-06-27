/**
 * server/src/MomentCoordinator.ts
 * ---------------------------------------------------------------------------
 * v3 P4 — "The rare villager-LLM budget" (design §7).
 *
 * Under the utility brain villagers are cheap, mute automatons (design §2). That
 * keeps the village at ~1–2 LLM calls total, but it also means the village can
 * never SURPRISE — no real dialogue, no memorable choice. This coordinator keeps a
 * small door open for those beats: a strict per-in-game-day BUDGET of villager LLM
 * "moments", spent only on genuinely notable occasions.
 *
 *   TRIGGERS (design §7):
 *     - a CRISIS (a famine/shortage `village.alert`) → the most-affected villager
 *       cries out / acts, in its own real voice.
 *     - the god's WHISPER (`supervisor.plant_idea`) → the targeted villager gets a
 *       turn to act on the implanted idea, instead of silently ignoring it (a
 *       utility villager has no memory to plant into, so the moment IS the effect).
 *
 * When a trigger fires and budget remains, it picks one villager and emits a
 * `village.moment` at them; that villager runs a SINGLE LLM turn (see
 * {@link AgentService}) and then drops straight back to the utility brain. The
 * budget refills each in-game day. It is a pure bus citizen holding only the
 * budget counter + the latest roster it needs to choose a target.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type {
  PlantIdeaPayload,
  SupervisorPlantIdeaEvent,
  VillageAlertEvent,
  VillageMomentPayload,
  WorldEvent,
} from '../../shared/events';
import type { Villager } from '../../shared/types';
import { simTimeFromTick } from '../../shared/simClock';

export interface MomentCoordinatorOptions {
  /**
   * How many rare villager-LLM moments may be spent per in-game day, globally. Kept
   * small so the village stays cheap (design §7). Env `MOMENT_BUDGET_PER_DAY`. Default 3.
   */
  perDay?: number;
}

export class MomentCoordinator {
  private readonly perDay: number;
  /** Moments still available today; refills to {@link perDay} at each day rollover. */
  private budgetLeft: number;
  /** The in-game day we are currently budgeting for; -1 until the first snapshot. */
  private currentDay = -1;
  /** The latest villager snapshot, so a crisis can pick the most-affected soul. */
  private latestVillagers: Villager[] = [];

  constructor(
    private readonly bus: EventBus,
    options: MomentCoordinatorOptions = {},
  ) {
    const fromEnv = Number(process.env.MOMENT_BUDGET_PER_DAY);
    this.perDay = options.perDay ?? (Number.isFinite(fromEnv) && fromEnv >= 0 ? Math.floor(fromEnv) : 3);
    this.budgetLeft = this.perDay;
  }

  async start(): Promise<void> {
    // Track the in-game day (to refill the budget) and hold the latest roster (to choose
    // a crisis's target). Exclusive queue — only fresh snapshots, no backlog after a restart.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.map_updated', (event) => {
      if (event.type !== 'world.map_updated') return;
      this.latestVillagers = event.payload.villagers;
      const day = simTimeFromTick(event.payload.tick).day;
      if (day !== this.currentDay) {
        this.currentDay = day;
        this.budgetLeft = this.perDay; // a new day refills the moment budget
      }
    });

    // A CRISIS lets the most-affected villager speak in its own voice. Exclusive queue —
    // a crisis is reacted to live, not replayed.
    await this.bus.subscribe<VillageAlertEvent>(EXCHANGES.villageEvents, 'village.alert', (event) =>
      this.onCrisis(event.payload),
    );

    // The god's WHISPER: grant the targeted villager a turn to act on the implanted idea.
    await this.bus.subscribe<SupervisorPlantIdeaEvent>(
      EXCHANGES.supervisorCommands,
      'supervisor.plant_idea',
      (event) => this.onWhisper(event.payload),
    );

    console.log(`[moments] online; ${this.perDay} rare villager-LLM moment(s) per day`);
  }

  /** A crisis: hand the hardest-hit villager a real turn to cry out or act. */
  private onCrisis(event: { kind: string; text: string }): void {
    const victim = this.mostAffected(event.kind);
    if (!victim) return;
    this.grant(victim.id, `A crisis grips the village: ${event.text} Speak or act on it as you truly would.`, 'crisis');
  }

  /** The god whispered into a villager — give it a turn to voice or act on the idea. */
  private onWhisper(payload: PlantIdeaPayload): void {
    if (!payload.villagerId) return;
    this.grant(
      payload.villagerId,
      `A sudden conviction takes hold of you: "${payload.memory}" Act on it now.`,
      'whisper',
    );
  }

  /**
   * Spend one moment on a villager, if budget remains. Decrements the day's budget and
   * emits a `village.moment` the target folds into a single LLM turn. Silently a no-op
   * when the budget is exhausted — the village simply stays on its cheap brain until
   * tomorrow refills it.
   */
  private grant(villagerId: string, reason: string, kind: VillageMomentPayload['kind']): void {
    if (this.budgetLeft <= 0) {
      console.log(`[moments] budget spent for day ${this.currentDay} — "${kind}" moment skipped`);
      return;
    }
    this.budgetLeft -= 1;
    console.log(`[moments] granting ${kind} moment to ${villagerId} (${this.budgetLeft}/${this.perDay} left today)`);
    this.bus.publish(
      EXCHANGES.villageEvents,
      makeEvent<'village.moment', VillageMomentPayload>('village.moment', { villagerId, reason, kind }),
    );
  }

  /**
   * The villager most affected by a crisis of the given kind — the hungriest in a famine,
   * the most parched in a drought — so the one real voice we spend is the one with the most
   * to say. Falls back to whoever is worst-off overall. Null when no villagers are known yet.
   */
  private mostAffected(kind: string): Villager | null {
    if (this.latestVillagers.length === 0) return null;
    const score = (v: Villager): number => {
      const n = v.needs;
      if (kind === 'famine') return Math.max(n.hunger ?? 0, n.thirst ?? 0);
      if (kind === 'shortage') return Math.max(n.hunger ?? 0, n.thirst ?? 0);
      return Math.max(n.hunger ?? 0, n.thirst ?? 0, n.fatigue ?? 0, n.boredom ?? 0);
    };
    let best: Villager | null = null;
    let bestScore = -1;
    for (const v of this.latestVillagers) {
      const s = score(v);
      if (s > bestScore) {
        best = v;
        bestScore = s;
      }
    }
    return best;
  }
}
