/**
 * server/src/persistence/MongoWorldStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed `WorldStore`. The world is stored as a single canonical
 * document (`_id: "current"`) in the `world` collection:
 *
 *   - `saveSeed`     -> writes that document the first time a world is generated.
 *   - `saveSnapshot` -> overwrites it every N ticks with the live state.
 *   - `loadSeed`     -> reads it back on boot, so a restart RESUMES the world
 *                       from its last persisted positions instead of re-rolling
 *                       a brand-new map.
 *
 * Only this file imports the `mongodb` driver. The engine stays DB-agnostic.
 * ---------------------------------------------------------------------------
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { WorldSeed } from '../../../shared/types';
import type { WorldStore } from './WorldStore';

/** The single canonical world document, keyed by a constant id. */
interface WorldDocument extends WorldSeed {
  _id: string;
  updatedAt: Date;
}

const WORLD_ID = 'current';

export class MongoWorldStore implements WorldStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<WorldDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<WorldDocument>('world');
    console.log(`[mongo] connected to ${this.dbName}`);
  }

  async loadSeed(): Promise<WorldSeed | null> {
    const doc = await this.requireCollection().findOne({ _id: WORLD_ID });
    if (!doc) return null;
    // Strip the storage-only fields, returning a clean WorldSeed.
    const { _id, updatedAt, ...seed } = doc;
    void _id;
    void updatedAt;
    return seed;
  }

  async saveSeed(seed: WorldSeed): Promise<void> {
    await this.upsert(seed);
    console.log('[mongo] seed persisted');
  }

  async saveSnapshot(snapshot: WorldSeed): Promise<void> {
    await this.upsert(snapshot);
  }

  async clear(): Promise<void> {
    await this.requireCollection().deleteOne({ _id: WORLD_ID });
    console.log('[mongo] world document cleared');
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // -------------------------------------------------------------------------

  /** Replace-or-insert the single canonical world document. */
  private async upsert(seed: WorldSeed): Promise<void> {
    // On upsert-insert Mongo takes `_id` from the filter, so the replacement
    // document must NOT include `_id` (the driver's WithoutId<> type enforces this).
    await this.requireCollection().replaceOne(
      { _id: WORLD_ID },
      { updatedAt: new Date(), ...seed },
      { upsert: true },
    );
  }

  private requireCollection(): Collection<WorldDocument> {
    if (!this.collection) {
      throw new Error('MongoWorldStore.connect() must be called before use');
    }
    return this.collection;
  }
}
