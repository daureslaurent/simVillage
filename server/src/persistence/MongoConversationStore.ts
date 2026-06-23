/**
 * server/src/persistence/MongoConversationStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed `ConversationStore`. Each conversation is one document in the
 * `conversations` collection, keyed by the conversation's own id and replaced
 * wholesale every time it gains a line:
 *
 *   - `upsert` -> insert or replace one conversation by id.
 *   - `list`   -> recent conversations, most-recently-active first, for the UI.
 *
 * `lastAt`/`startedAt` are stored as ISO strings (as on the wire); ISO-8601 sorts
 * lexically by time, so the `lastAt` index orders conversations correctly without
 * any Date juggling. Only this file imports the `mongodb` driver.
 * ---------------------------------------------------------------------------
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { Conversation } from '../../../shared/types';
import type { ConversationStore } from './ConversationStore';

/** How many conversations the default listing returns. */
const DEFAULT_LIMIT = 100;

/** Stored shape: the wire conversation, with its id promoted to Mongo's `_id`. */
interface ConversationDocument extends Omit<Conversation, 'id'> {
  _id: string;
}

export class MongoConversationStore implements ConversationStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<ConversationDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<ConversationDocument>('conversations');
    await this.collection.createIndex({ lastAt: -1 });
    console.log(`[mongo] conversations ready (${this.dbName}.conversations)`);
  }

  async upsert(conversation: Conversation): Promise<void> {
    const { id, ...rest } = conversation;
    await this.requireCollection().replaceOne({ _id: id }, { ...rest }, { upsert: true });
  }

  async list(limit = DEFAULT_LIMIT): Promise<Conversation[]> {
    const docs = await this.requireCollection()
      .find()
      .sort({ lastAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private requireCollection(): Collection<ConversationDocument> {
    if (!this.collection) {
      throw new Error('MongoConversationStore.connect() must be called before use');
    }
    return this.collection;
  }
}
