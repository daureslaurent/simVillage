/**
 * server/src/persistence/MongoRelationshipStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed {@link RelationshipStore}. One document per villager in the
 * `relationships` collection, keyed by villager id and replaced wholesale each
 * time that villager's nightly reflection revises its view of its neighbours.
 * Only this file imports the `mongodb` driver.
 * ---------------------------------------------------------------------------
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { Relationship } from '../../../shared/types';
import type { RelationshipStore, VillagerRelationships } from './RelationshipStore';

/** Stored shape: the book, with the villager id promoted to Mongo's `_id`. */
interface RelationshipDocument {
  _id: string;
  villagerName: string;
  relationships: Relationship[];
}

export class MongoRelationshipStore implements RelationshipStore {
  readonly name = 'mongo';
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<RelationshipDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<RelationshipDocument>('relationships');
    console.log(`[mongo] relationships ready (${this.dbName}.relationships)`);
  }

  async upsert(book: VillagerRelationships): Promise<void> {
    await this.requireCollection().replaceOne(
      { _id: book.villagerId },
      { villagerName: book.villagerName, relationships: book.relationships },
      { upsert: true },
    );
  }

  async list(): Promise<VillagerRelationships[]> {
    const docs = await this.requireCollection().find().toArray();
    return docs.map((d) => ({
      villagerId: d._id,
      villagerName: d.villagerName,
      relationships: d.relationships ?? [],
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private requireCollection(): Collection<RelationshipDocument> {
    if (!this.collection) {
      throw new Error('MongoRelationshipStore.connect() must be called before use');
    }
    return this.collection;
  }
}
