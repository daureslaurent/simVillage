/**
 * server/src/ActionRecorder.ts
 * ---------------------------------------------------------------------------
 * The villager action log's WRITE side.
 *
 * Every think turn a villager publishes a `villager.telemetry.thought_process`
 * envelope carrying both the decision it acted on (or null, when it skipped) and
 * the full LLM context that produced it. This recorder eavesdrops on that stream
 * and persists the turns that ACTUALLY acted — a non-null decision — into the
 * `ActionStore`. Skipped turns are dropped: the log is a record of actions, not
 * of every breath the mind takes.
 *
 * It owns no world state and writes fire-and-forget: a slow or failing disk must
 * never stall the telemetry stream or the simulation behind it.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { EXCHANGES, type VillagerThoughtProcessEvent } from '../../shared/events';
import type { ActionStore } from './persistence/ActionStore';

export class ActionRecorder {
  constructor(
    private readonly bus: EventBus,
    private readonly store: ActionStore,
  ) {}

  async start(): Promise<void> {
    await this.bus.subscribe<VillagerThoughtProcessEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.telemetry.thought_process',
      (event) => this.onThought(event),
    );
    console.log('[recorder] persisting villager actions to the action log');
  }

  private onThought(event: VillagerThoughtProcessEvent): void {
    const t = event.payload;
    if (!t.decision) return; // a skipped turn is not an action

    void this.store
      .record({
        villagerId: t.villagerId,
        villagerName: t.villagerName,
        tick: t.tick,
        decision: t.decision,
        recalledMemories: t.recalledMemories,
        prompt: t.prompt,
        rawOutput: t.rawOutput,
        recordedAt: new Date().toISOString(),
      })
      .catch((err) => {
        console.warn('[recorder] failed to persist action:', err);
      });
  }
}
