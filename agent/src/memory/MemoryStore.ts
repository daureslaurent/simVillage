/**
 * agent/src/memory/MemoryStore.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The pluggable vector-store seam.
 *
 * A villager's long-term memory is a vector database of narrated experiences.
 * This is the seam over it — the mind never speaks Qdrant or Chroma directly,
 * only this small verb set:
 *
 *   init()    — idempotently ensure the collection/index exists.
 *   upsert()  — write one narrated memory (text + vector + metadata).
 *   search()  — similarity-search this villager's memories by a query vector.
 *   recent()  — pull this villager's latest memories by time (the reflection feed).
 *
 * Every record is SCOPED TO ONE VILLAGER via `villagerId` and every read filters on
 * it: villagers do not share a hive mind, so Bob can never recall Alice's
 * private memories even though they live in the same collection. `embedding` is
 * carried on the record so the same vector that was searched-for can be stored
 * without a second round-trip to the embedding model.
 * ---------------------------------------------------------------------------
 */

import type { Vec2 } from '../../../shared/types';

/**
 * What kind of experience a memory is. Drives both retrieval filtering and the
 * default importance weighting:
 *   - observation:  passive sensing (saw a new building / a new neighbour).
 *   - conversation: something was said to or by this villager.
 *   - reflection:   a synthesis the villager produced about itself at night —
 *                   its "Core Belief" / "Updated Goal". Weighted heavily.
 *   - fact:         a discrete piece of world knowledge the villager reasoned out
 *                   at night ("the well by the square is dry", "Mira is the
 *                   healer"). Semantic, not episodic; weighted highly.
 *   - procedure:    a piece of practical know-how the villager distilled at night
 *                   ("to eat, I walk to the bakery and interact with it").
 *                   Weighted highly so it surfaces when the villager next acts.
 *   - implanted:    a synthetic memory forced in from outside (the "Inception"),
 *                   by the God Agent or a human. Weighted maximally so it
 *                   surfaces immediately; excluded from the reflection feed
 *                   because it was never actually lived.
 *
 * `fact` and `procedure` (like `reflection`) are excluded from the reflection
 * source feed so the nightly pass distils lived experience, not its own output.
 */
export type MemoryKind =
  | 'observation'
  | 'conversation'
  // A private deliberation the villager thought to itself (the `reason` move). Its
  // own voice talking to itself — recalled on later turns and fed into reflection.
  | 'reasoning'
  | 'reflection'
  | 'fact'
  | 'procedure'
  | 'implanted';

/** A single narrated memory as stored in the vector DB. */
export interface MemoryRecord {
  /** Stable unique id (UUID). Doubles as the vector-store point id. */
  id: string;
  /** Which villager owns (and may recall) this memory. */
  villagerId: string;
  /** The narrative string that was embedded, e.g. "At 10:00 AM, Bob told me he is hungry". */
  text: string;
  /**
   * The embedding of `text`. Carried on `upsert` (we already have it from the
   * embed call, so storing needs no second round-trip). Reads (`search`/`recent`)
   * intentionally leave it empty — recall never reads the vector back — so a
   * recalled record's `embedding` is `[]`, not its stored value.
   */
  embedding: number[];
  /** Wall-clock ms when the memory formed (for recency ranking / decay). */
  timestamp: number;
  /** The simulation tick the memory formed on, if known. */
  tick?: number;
  /** Observation / conversation / reflection. */
  kind: MemoryKind;
  /**
   * Salience in [0,1]. Mundane observations are low; reflections are high. Used
   * to bias retrieval toward what matters, à la the generative-villagers paper.
   */
  importance: number;
  /** Other villager ids involved (conversation partners, observed neighbours). */
  participants?: string[];
  /** Where in the world the memory formed. */
  location?: Vec2;
}

/** Everything needed to store a memory except its server-assigned position. */
export type NewMemory = Omit<MemoryRecord, 'id'> & { id?: string };

/** A similarity query against one villager's memories. */
export interface MemoryQuery {
  /** Whose memories to search — always required; memories never cross villagers. */
  villagerId: string;
  /** The situation vector to find neighbours of. */
  embedding: number[];
  /** How many memories to return. Phase 4 spec asks for the top 5. */
  topK: number;
  /** Restrict to certain kinds (e.g. only reflections). Omit for all kinds. */
  kinds?: MemoryKind[];
  /** Optional minimum importance to consider. */
  minImportance?: number;
}

/** A memory returned from a search, carrying its similarity score. */
export interface RecalledMemory extends MemoryRecord {
  /** Cosine similarity to the query vector, in [-1, 1] (higher = closer). */
  score: number;
}

/** Options for pulling a recency-ordered window of memories. */
export interface RecentOptions {
  /** Max memories to return, newest first. */
  limit: number;
  /** Only memories at or after this wall-clock ms (e.g. since last reflection). */
  since?: number;
  /** Restrict to certain kinds — reflection feeds on mundane memories only. */
  kinds?: MemoryKind[];
}

/** A swappable long-term memory. Inject a Qdrant/Chroma impl, or a stub in tests. */
export interface MemoryStore {
  /** Human-readable name for logs (e.g. "qdrant"). */
  readonly name: string;
  /** Idempotently create the collection/index. Safe to call on every boot. */
  init(): Promise<void>;
  /** Store (or overwrite) one narrated memory. */
  upsert(memory: NewMemory): Promise<MemoryRecord>;
  /** Similarity-search one villager's memories; returns at most `topK`, best first. */
  search(query: MemoryQuery): Promise<RecalledMemory[]>;
  /** Pull one villager's most recent memories, newest first — the reflection feed. */
  recent(villagerId: string, options: RecentOptions): Promise<MemoryRecord[]>;
}
