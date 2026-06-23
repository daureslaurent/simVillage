/**
 * agent/src/memory/QdrantMemoryStore.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The Qdrant implementation of `MemoryStore`.
 *
 * Talks to a Qdrant server over its REST API (`QDRANT_URL`, default
 * http://localhost:6333). One collection holds EVERY villager's memories as
 * points; villager isolation is enforced at read time by a mandatory `villagerId`
 * payload filter, never by separate collections (cheaper, and lets a future
 * "gossip" feature relax the filter deliberately).
 *
 * Endpoints used:
 *   PUT  /collections/{c}                 create the collection (size + Cosine)
 *   PUT  /collections/{c}/index           payload indexes for filter/order keys
 *   PUT  /collections/{c}/points          upsert a point (vector + payload)
 *   POST /collections/{c}/points/search   ANN similarity search with a filter
 *   POST /collections/{c}/points/scroll   recency scan (order_by timestamp desc)
 *
 * The collection's vector size is pinned to the embedding provider's
 * dimensionality at construction; a mismatch surfaces loudly at init rather
 * than as silently-wrong recall. Chroma would be a drop-in alternative behind
 * the same `MemoryStore` seam (add/query against a collection) — Qdrant is the
 * target here for its first-class payload filtering and `order_by` scroll.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import type {
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  NewMemory,
  RecalledMemory,
  RecentOptions,
} from './MemoryStore';

export interface QdrantMemoryStoreOptions {
  /** Server base URL. Defaults to `QDRANT_URL` or http://localhost:6333. */
  url?: string;
  /** Collection name. Defaults to `QDRANT_COLLECTION` or "village_memories". */
  collection?: string;
  /** Optional api key header (Qdrant Cloud). Defaults to `QDRANT_API_KEY`. */
  apiKey?: string;
  /** Vector size — MUST equal the embedding provider's `dimensions`. */
  dimensions: number;
  /** Per-request timeout in ms. Defaults to `QDRANT_TIMEOUT_MS` or 15000. */
  timeoutMs?: number;
}

/** The payload we attach to each Qdrant point (everything but the vector). */
interface MemoryPayload {
  villagerId: string;
  text: string;
  timestamp: number;
  tick?: number;
  kind: MemoryRecord['kind'];
  importance: number;
  participants?: string[];
  location?: { x: number; y: number };
}

export class QdrantMemoryStore implements MemoryStore {
  readonly name = 'qdrant';

  private readonly url: string;
  private readonly collection: string;
  private readonly apiKey: string | undefined;
  private readonly dimensions: number;
  private readonly timeoutMs: number;

  constructor(options: QdrantMemoryStoreOptions) {
    this.url = (options.url ?? process.env.QDRANT_URL ?? 'http://localhost:6333').replace(/\/$/, '');
    this.collection = options.collection ?? process.env.QDRANT_COLLECTION ?? 'village_memories';
    this.apiKey = options.apiKey ?? process.env.QDRANT_API_KEY;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.QDRANT_TIMEOUT_MS ?? 15_000);
  }

  /** Create the collection + payload indexes if absent. Idempotent. */
  async init(): Promise<void> {
    const existing = await this.request('GET', `/collections/${this.collection}`, undefined, [
      200, 404,
    ]);
    if (existing.status === 404) {
      await this.request('PUT', `/collections/${this.collection}`, {
        vectors: { size: this.dimensions, distance: 'Cosine' },
      });
      console.log(`[qdrant] created collection "${this.collection}" (dim=${this.dimensions})`);
    }

    // Indexes that our filters and recency scroll depend on. Creating an index
    // that already exists is a no-op for Qdrant, so this is safe every boot.
    await this.ensureIndex('villagerId', 'keyword');
    await this.ensureIndex('kind', 'keyword');
    await this.ensureIndex('timestamp', 'integer');
    await this.ensureIndex('importance', 'float');
  }

  async upsert(memory: NewMemory): Promise<MemoryRecord> {
    const record: MemoryRecord = { ...memory, id: memory.id ?? randomUUID() };
    const payload: MemoryPayload = {
      villagerId: record.villagerId,
      text: record.text,
      timestamp: record.timestamp,
      kind: record.kind,
      importance: record.importance,
      ...(record.tick !== undefined ? { tick: record.tick } : {}),
      ...(record.participants ? { participants: record.participants } : {}),
      ...(record.location ? { location: record.location } : {}),
    };

    await this.request('PUT', `/collections/${this.collection}/points?wait=true`, {
      points: [{ id: record.id, vector: record.embedding, payload }],
    });
    return record;
  }

  async search(query: MemoryQuery): Promise<RecalledMemory[]> {
    const must: unknown[] = [{ key: 'villagerId', match: { value: query.villagerId } }];
    if (query.kinds?.length) must.push({ key: 'kind', match: { any: query.kinds } });
    if (query.minImportance !== undefined) {
      must.push({ key: 'importance', range: { gte: query.minImportance } });
    }

    const body = await this.request('POST', `/collections/${this.collection}/points/search`, {
      vector: query.embedding,
      limit: query.topK,
      filter: { must },
      with_payload: true,
      // Deliberately DON'T fetch the stored vector back: recall consumes only the
      // narrative `text` (+ score/kind/importance/timestamp), never the embedding.
      // Pulling 768 floats per point per turn is pure REST + JSON-parse waste.
      with_vector: false,
    });
    const result = body.json?.result;
    const points = Array.isArray(result) ? result : [];
    return points.map((p) => ({ ...this.toRecord(p), score: p.score ?? 0 }));
  }

  async recent(villagerId: string, options: RecentOptions): Promise<MemoryRecord[]> {
    const must: unknown[] = [{ key: 'villagerId', match: { value: villagerId } }];
    if (options.kinds?.length) must.push({ key: 'kind', match: { any: options.kinds } });
    if (options.since !== undefined) {
      must.push({ key: 'timestamp', range: { gte: options.since } });
    }

    const body = await this.request('POST', `/collections/${this.collection}/points/scroll`, {
      filter: { must },
      limit: options.limit,
      with_payload: true,
      // Same as search(): the reflection feed reads only `text`, so skip the vector.
      with_vector: false,
      // Newest first — depends on the integer index over `timestamp`.
      order_by: { key: 'timestamp', direction: 'desc' },
    });
    const result = body.json?.result;
    const points = !Array.isArray(result) ? (result?.points ?? []) : [];
    return points.map((p) => this.toRecord(p));
  }

  // -------------------------------------------------------------------------

  /** Map a Qdrant point back into our domain record. */
  private toRecord(point: ScoredPoint): MemoryRecord {
    const p = point.payload;
    return {
      id: String(point.id),
      villagerId: p.villagerId,
      text: p.text,
      embedding: point.vector ?? [],
      timestamp: p.timestamp,
      kind: p.kind,
      importance: p.importance,
      ...(p.tick !== undefined ? { tick: p.tick } : {}),
      ...(p.participants ? { participants: p.participants } : {}),
      ...(p.location ? { location: p.location } : {}),
    };
  }

  private async ensureIndex(field: string, schema: string): Promise<void> {
    await this.request(
      'PUT',
      `/collections/${this.collection}/index?wait=true`,
      { field_name: field, field_schema: schema },
      // 200 = created; Qdrant returns 200 even if it already exists.
      [200, 409],
    );
  }

  /**
   * One Qdrant REST round-trip. Throws on any status outside `okStatuses`
   * (default: 2xx). Returns the parsed JSON body and the status code.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    okStatuses?: number[],
  ): Promise<{ status: number; json: QdrantEnvelope | undefined }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } finally {
      clearTimeout(timer);
    }

    const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
    const json = (await res.json().catch(() => undefined)) as QdrantEnvelope | undefined;
    if (!ok) {
      const status = json?.status;
      const detail =
        (typeof status === 'object' ? status.error : status) ?? `${res.status} ${res.statusText}`;
      throw new Error(`qdrant ${method} ${path} failed: ${detail}`);
    }
    return { status: res.status, json };
  }
}

/** Generic Qdrant response envelope ({ result, status, time }). */
interface QdrantEnvelope {
  /** Search returns a bare point array; scroll returns `{ points }`. */
  result?: ScoredPoint[] | { points?: ScoredPoint[] };
  status?: { error?: string } | string;
}

/** A point as returned by search/scroll. */
interface ScoredPoint {
  id: string | number;
  score?: number;
  vector?: number[];
  payload: MemoryPayload;
}
