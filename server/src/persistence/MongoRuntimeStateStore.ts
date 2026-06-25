/**
 * server/src/persistence/MongoRuntimeStateStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed {@link RuntimeStateStore}. One document per key in the
 * `runtime_state` collection, the value stored verbatim under `value` and
 * keyed by the caller's string id (promoted to Mongo's `_id`). Replaced wholesale
 * on each write, like the relationship/world stores. Only this file imports the
 * `mongodb` driver.
 * ---------------------------------------------------------------------------
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { RuntimeStateStore } from './RuntimeStateStore';

/** Stored shape: the value under a stable key, with the key promoted to `_id`. */
interface RuntimeStateDocument {
  _id: string;
  value: unknown;
  updatedAt: Date;
}

export class MongoRuntimeStateStore implements RuntimeStateStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<RuntimeStateDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<RuntimeStateDocument>('runtime_state');
    console.log(`[mongo] runtime state ready (${this.dbName}.runtime_state)`);
  }

  async get<T>(key: string): Promise<T | null> {
    const doc = await this.requireCollection().findOne({ _id: key });
    return doc ? (doc.value as T) : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.requireCollection().replaceOne(
      { _id: key },
      { value, updatedAt: new Date() },
      { upsert: true },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private requireCollection(): Collection<RuntimeStateDocument> {
    if (!this.collection) {
      throw new Error('MongoRuntimeStateStore.connect() must be called before use');
    }
    return this.collection;
  }
}
