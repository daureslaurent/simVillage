/**
 * server/src/RelationshipTracker.ts
 * ---------------------------------------------------------------------------
 * Persists and serves villagers' SOCIAL BOOKS. Each night a villager's
 * reflection re-judges its neighbours and publishes the revised book on the
 * telemetry exchange; this tracker (a) writes it through to the
 * {@link RelationshipStore} for durability, and (b) caches the latest book per
 * villager so the gateway can answer the browser's `GET /relationships` request
 * with the whole village's standing at any moment.
 *
 * It owns no world state of record — just a write-through cache keyed by villager
 * id, seeded from the store at boot — and writes fire-and-forget so a slow disk
 * never stalls the reflection stream.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { EXCHANGES, type VillagerRelationshipEvent } from '../../shared/events';
import type { RelationshipStore, VillagerRelationships } from './persistence/RelationshipStore';

export class RelationshipTracker {
  /** Latest book per villager id — the read model the gateway serves. */
  private readonly books = new Map<string, VillagerRelationships>();

  constructor(
    private readonly bus: EventBus,
    private readonly store: RelationshipStore,
  ) {}

  async start(): Promise<void> {
    // Seed the cache from whatever was persisted, so the UI shows existing ties
    // immediately and a fresh browser doesn't wait for the next reflection.
    for (const book of await this.store.list()) this.books.set(book.villagerId, book);

    await this.bus.subscribe<VillagerRelationshipEvent>(
      EXCHANGES.villagerTelemetry,
      'villager.relationship.updated',
      (event) => this.onUpdate(event.payload),
    );

    console.log(`[relationships] tracking social books (${this.books.size} loaded)`);
  }

  /** Every villager's latest social book — for the gateway's HTTP endpoint. */
  all(): VillagerRelationships[] {
    return [...this.books.values()];
  }

  private onUpdate(payload: VillagerRelationships): void {
    this.books.set(payload.villagerId, payload);
    void this.store.upsert(payload).catch((err) => {
      console.warn('[relationships] failed to persist:', err);
    });
  }
}
