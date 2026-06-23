/**
 * server/src/persistence/ActionStore.ts
 * ---------------------------------------------------------------------------
 * The seam for the villager ACTION LOG — a durable, append-only record of every
 * decision a villager actually took, with the full LLM context behind it.
 *
 * It is deliberately separate from `WorldStore`: the world store holds ONE
 * canonical snapshot (overwritten in place), whereas this store grows one
 * document per action over time. Keeping them apart means each can be swapped or
 * scaled on its own, and the engine stays oblivious to both.
 *
 * Split into a write side (`ActionStore`, used by the recorder) and a read side
 * (`ActionReader`, handed to the gateway's history endpoint) so the browser-
 * facing surface can only ever read, never write, the log.
 * ---------------------------------------------------------------------------
 */

import type { VillagerActionRecord } from '../../../shared/types';

/** Read-only view of the action log, as exposed to the gateway's HTTP endpoint. */
export interface ActionReader {
  /** Most-recent actions for one villager, newest first, capped at `limit`. */
  listByVillager(villagerId: string, limit?: number): Promise<VillagerActionRecord[]>;
}

/** Full action log: the recorder writes, the gateway reads. */
export interface ActionStore extends ActionReader {
  /** Open the underlying connection. */
  connect(): Promise<void>;

  /** Append one action to the log. */
  record(action: VillagerActionRecord): Promise<void>;

  /** Close the underlying connection. */
  close(): Promise<void>;
}
