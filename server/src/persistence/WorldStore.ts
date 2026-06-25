/**
 * server/src/persistence/WorldStore.ts
 * ---------------------------------------------------------------------------
 * THE seam that makes the datastore swappable, mirroring the Transport seam.
 *
 * The engine never imports this — `index.ts` wires a concrete store to the
 * engine's lifecycle: load a seed on boot, write snapshots as `tick` events
 * fire. Swap `MongoWorldStore` for any other implementation (Postgres, a flat
 * file, an in-memory stub for tests) without touching the engine.
 * ---------------------------------------------------------------------------
 */

import type { WorldSeed } from '../../../shared/types';

export interface WorldStore {
  /** Open the underlying connection. */
  connect(): Promise<void>;

  /** Return the persisted world, or null if none exists yet (first run). */
  loadSeed(): Promise<WorldSeed | null>;

  /** Persist the canonical world seed (called once, on first generation). */
  saveSeed(seed: WorldSeed): Promise<void>;

  /** Upsert the latest live snapshot (called periodically from the tick loop). */
  saveSnapshot(snapshot: WorldSeed): Promise<void>;

  /** Delete the persisted world entirely, so the next boot starts fresh (the "New Village" reset). */
  clear(): Promise<void>;

  /** Close the underlying connection. */
  close(): Promise<void>;
}
