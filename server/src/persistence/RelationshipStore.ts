/**
 * server/src/persistence/RelationshipStore.ts
 * ---------------------------------------------------------------------------
 * The pluggable seam over where villagers' SOCIAL BOOKS are persisted. Each
 * villager has one book — its evolving view of every neighbour — written whole
 * each time a nightly reflection revises it, and read back at boot so opinions
 * survive a restart. A Mongo impl lives beside this; tests can stub it.
 * ---------------------------------------------------------------------------
 */

import type { Relationship } from '../../../shared/types';

/** One villager's persisted social book. */
export interface VillagerRelationships {
  villagerId: string;
  villagerName: string;
  relationships: Relationship[];
}

export interface RelationshipStore {
  readonly name: string;
  /** Idempotently ready the collection. Safe on every boot. */
  connect(): Promise<void>;
  /** Write (replace) one villager's whole social book. */
  upsert(book: VillagerRelationships): Promise<void>;
  /** Read every villager's book, for seeding the minds at startup + the UI. */
  list(): Promise<VillagerRelationships[]>;
  close(): Promise<void>;
}
