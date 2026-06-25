/**
 * server/src/persistence/MongoDailyReportStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed {@link DailyReportStore}. Each day's chronicle is one document
 * in the `daily_reports` collection, keyed by `day` so a re-published day (e.g.
 * after a restart that re-crosses a boundary) replaces rather than duplicates.
 * An index on `day` keeps the newest-first listing fast. Only this file imports
 * the `mongodb` driver.
 * ---------------------------------------------------------------------------
 */

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { SupervisorDailyReportPayload } from '../../../shared/events';
import type { DailyReportStore } from './DailyReportStore';

/** How many chronicles a default listing returns. */
const DEFAULT_LIMIT = 60;

/** Stored shape: the report with its `day` promoted to Mongo's `_id`. */
interface DailyReportDocument extends Omit<SupervisorDailyReportPayload, 'day'> {
  _id: number;
  recordedAt: Date;
}

export class MongoDailyReportStore implements DailyReportStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<DailyReportDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<DailyReportDocument>('daily_reports');
    console.log(`[mongo] daily reports ready (${this.dbName}.daily_reports)`);
  }

  async record(report: SupervisorDailyReportPayload): Promise<void> {
    const { day, ...rest } = report;
    // Replace by day so re-crossing a boundary updates rather than duplicates.
    await this.requireCollection().replaceOne(
      { _id: day },
      { ...rest, recordedAt: new Date() },
      { upsert: true },
    );
  }

  async list(limit = DEFAULT_LIMIT): Promise<SupervisorDailyReportPayload[]> {
    const docs = await this.requireCollection()
      .find()
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
    return docs.map(({ _id, recordedAt, ...rest }) => {
      void recordedAt;
      return { day: _id, ...rest };
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private requireCollection(): Collection<DailyReportDocument> {
    if (!this.collection) {
      throw new Error('MongoDailyReportStore.connect() must be called before use');
    }
    return this.collection;
  }
}
