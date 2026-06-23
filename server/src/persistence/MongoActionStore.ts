/**
 * server/src/persistence/MongoActionStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed `ActionStore`. Every villager action is one document in the
 * `villager_actions` collection, appended as it happens:
 *
 *   - `record`         -> inserts one action (decision + full LLM context).
 *   - `listByVillager` -> reads a villager's recent actions, newest first,
 *                         for the left-dock roster history view.
 *
 * A compound index on `{ villagerId, tick }` keeps the per-villager listing fast
 * as the log grows. Only this file imports the `mongodb` driver.
 * ---------------------------------------------------------------------------
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { VillagerActionRecord } from '../../../shared/types';
import type { ActionStore } from './ActionStore';

/** How many actions a single villager listing returns by default. */
const DEFAULT_LIMIT = 200;

/** Stored shape: the wire record with a real Date for indexing/sorting. */
interface ActionDocument extends Omit<VillagerActionRecord, 'recordedAt'> {
  recordedAt: Date;
}

export class MongoActionStore implements ActionStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<ActionDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<ActionDocument>('villager_actions');
    // Idempotent: createIndex is a no-op if the index already exists.
    await this.collection.createIndex({ villagerId: 1, tick: -1 });
    console.log(`[mongo] action log ready (${this.dbName}.villager_actions)`);
  }

  async record(action: VillagerActionRecord): Promise<void> {
    await this.requireCollection().insertOne({
      ...action,
      recordedAt: new Date(action.recordedAt),
    });
  }

  async listByVillager(villagerId: string, limit = DEFAULT_LIMIT): Promise<VillagerActionRecord[]> {
    const docs = await this.requireCollection()
      .find({ villagerId })
      .sort({ tick: -1 })
      .limit(limit)
      .toArray();
    // Strip Mongo's `_id` and re-serialize the timestamp to the wire shape.
    return docs.map(({ _id, recordedAt, ...rest }) => {
      void _id;
      return { ...rest, recordedAt: recordedAt.toISOString() };
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private requireCollection(): Collection<ActionDocument> {
    if (!this.collection) {
      throw new Error('MongoActionStore.connect() must be called before use');
    }
    return this.collection;
  }
}
