/**
 * supervisor/src/SupervisorMemory.ts
 * ---------------------------------------------------------------------------
 * v3 P4 — "The god remembers". The Supervisor's long-term memory.
 *
 * The v3 inversion moved the LLM UP from the villagers to the god (design §2).
 * P4 moves the long-term MEMORY up with it: the per-villager RAG store (Qdrant)
 * is dormant under the utility brain, so rather than retire it we repoint it at a
 * single owner — the god — and give the macro-mind a hippocampus of its own.
 *
 * Each day the god DELIBERATES over the village vitals; afterwards it lays down a
 * record of what it saw and what it did (a "deliberation memory"). Before the next
 * deliberation it RECALLS the most similar past days, so it can reason from
 * experience ("last time the larder ran this low I raised food to 0.8 and it
 * recovered") instead of from the single day in front of it. Each night it
 * REFLECTS over the recent records into one standing STRATEGIC LESSON, stored at
 * high importance so it surfaces prominently.
 *
 * It reuses the villagers' Phase-4 seams verbatim — the {@link EmbeddingProvider},
 * the {@link MemoryStore} (the same Qdrant collection), and a {@link Synthesizer}
 * for the nightly synthesis — scoped to a single synthetic owner id so the god's
 * memories live alongside (but never mingle with) any villager memories. It is a
 * pure consumer of those seams and holds only a reflection watermark; every read
 * is best-effort and returns empty rather than throwing, so a memory hiccup
 * degrades the god to its in-the-moment self rather than stalling a deliberation.
 * ---------------------------------------------------------------------------
 */

import { embedOne, type EmbeddingProvider } from '../../agent/src/memory/EmbeddingProvider';
import type { MemoryRecord, MemoryStore } from '../../agent/src/memory/MemoryStore';
import type { Synthesizer } from '../../agent/src/memory/Synthesizer';

/**
 * The synthetic owner id the god's memories are stored under. It is namespaced so it
 * can never collide with a real villager id (villager ids are plain like `villager_3`),
 * which keeps the god's strategy out of any villager's recall and vice-versa.
 */
export const SUPERVISOR_OWNER = '__supervisor__';

/** How a god memory is classed in the shared store (a subset of the villager `MemoryKind`s). */
type SupervisorMemoryKind = Extract<MemoryRecord['kind'], 'observation' | 'reflection'>;

/** Importance of a routine per-day deliberation record (episodic; recalled by similarity). */
const DELIBERATION_IMPORTANCE = 0.4;
/** Importance of a nightly strategic lesson (a synthesis; surfaced prominently). */
const STRATEGY_IMPORTANCE = 0.9;

export interface SupervisorMemoryOptions {
  /** How many past deliberation memories a recall returns by default. Default 3. */
  topK?: number;
  /** Most recent records the nightly reflection chews over. Default 30. */
  reflectWindow?: number;
  /**
   * The owner id the god's memories live under (v3 rival-village seam). Each village's
   * supervisor needs its OWN namespace so two gods sharing one Qdrant collection never
   * recall each other's strategy. Defaults to {@link SUPERVISOR_OWNER} (the single-village
   * god); a rival passes e.g. `__supervisor__:village_1`.
   */
  ownerId?: string;
}

/** One past day the god recalled, ready to render into the deliberation prompt. */
export interface RecalledStrategy {
  /** The narrated record ("Day 5 (rainy): hunger ran high; I raised food to 0.80…"). */
  text: string;
}

export class SupervisorMemory {
  readonly name = 'supervisor-memory';
  private readonly topK: number;
  private readonly reflectWindow: number;
  /** The store owner id this god's memories are scoped to (namespaced per village). */
  private readonly owner: string;

  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly store: MemoryStore,
    private readonly synthesizer: Synthesizer,
    options: SupervisorMemoryOptions = {},
  ) {
    this.topK = Math.max(1, options.topK ?? 3);
    this.reflectWindow = Math.max(1, options.reflectWindow ?? 30);
    this.owner = options.ownerId ?? SUPERVISOR_OWNER;
  }

  /** Ensure the underlying store is ready. Idempotent; safe on every boot. */
  async init(): Promise<void> {
    await this.store.init();
  }

  // -------------------------------------------------------------------------
  // INGEST — lay down a record of a day's deliberation
  // -------------------------------------------------------------------------

  /**
   * Remember one day's deliberation: the situation the god faced and what it decided.
   * Stored as an episodic `observation` so it is recalled by similarity, and stamped
   * with the day so a recall can reference it. Fire-and-forget at the call site; here
   * we await the embed+upsert and let the caller swallow failures.
   */
  async rememberDeliberation(text: string, meta: { tick: number; day: number }): Promise<MemoryRecord> {
    return this.write(text, 'observation', DELIBERATION_IMPORTANCE, meta);
  }

  // -------------------------------------------------------------------------
  // RETRIEVE — recall the most similar past days + the standing strategy
  // -------------------------------------------------------------------------

  /**
   * Recall the past deliberations most similar to the current situation. Best-effort:
   * an unreachable store yields [] so the god simply reasons from the day in front of
   * it. The standing strategic lesson is fetched separately via {@link latestStrategy}.
   */
  async recall(situation: string): Promise<RecalledStrategy[]> {
    try {
      const embedding = await embedOne(this.embeddings, situation, { agent: this.owner });
      const hits = await this.store.search({
        villagerId: this.owner,
        embedding,
        topK: this.topK,
        kinds: ['observation'],
      });
      // The day a record was laid down is carried in its narrated text (see
      // buildDeliberationRecord), so the recall just surfaces the text verbatim.
      return hits.map((h) => ({ text: h.text }));
    } catch (err) {
      console.warn('[supervisor-memory] recall failed, proceeding without recall:', errMsg(err));
      return [];
    }
  }

  /** The god's most recent standing strategic lesson, or null when it has none yet. */
  async latestStrategy(): Promise<string | null> {
    try {
      const recent = await this.store.recent(this.owner, { limit: 1, kinds: ['reflection'] });
      return recent[0]?.text ?? null;
    } catch (err) {
      console.warn('[supervisor-memory] strategy lookup failed:', errMsg(err));
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // REFLECT — distil recent days into one standing strategic lesson
  // -------------------------------------------------------------------------

  /**
   * The nightly synthesis. Read the recent stretch of deliberation records (a rolling
   * window, NOT just the newest day — so the lesson integrates the last several days),
   * ask the LLM to distil them into ONE short strategic lesson, and store it as a
   * high-importance `reflection` so it leads future recalls. Returns the lesson, or
   * null when there are no records yet or the synthesis failed.
   *
   * @param prompts  the system + user prompt for the synthesis, built by the caller
   *                 from the recent records (kept here transport-free of charter text).
   * @param meta     the current tick/day, stamped onto the stored lesson.
   */
  async reflect(
    prompts: { system: string; build: (recentRecords: string[]) => string },
    meta: { tick: number; day: number },
  ): Promise<string | null> {
    let sources: MemoryRecord[];
    try {
      // Reflect on the recent window of lived deliberations only — never on prior
      // syntheses, which would drift the lesson away from what actually happened.
      sources = await this.store.recent(this.owner, {
        limit: this.reflectWindow,
        kinds: ['observation'],
      });
    } catch (err) {
      console.warn('[supervisor-memory] reflection feed unavailable:', errMsg(err));
      return null;
    }
    if (sources.length === 0) return null;

    // Oldest → newest, so the synthesis reads the recent stretch chronologically.
    const records = sources
      .slice()
      .reverse()
      .map((m) => `- ${m.text}`);

    let lesson: string;
    try {
      lesson = (
        await this.synthesizer.synthesize({
          system: prompts.system,
          user: prompts.build(records),
          agent: 'God Agent',
          purpose: 'reflect',
        })
      ).trim();
    } catch (err) {
      console.warn('[supervisor-memory] strategy synthesis failed:', errMsg(err));
      return null;
    }
    if (!lesson) return null;

    try {
      await this.write(lesson, 'reflection', STRATEGY_IMPORTANCE, meta);
    } catch (err) {
      console.warn('[supervisor-memory] failed to store strategy:', errMsg(err));
    }
    console.log(
      `[supervisor-memory] reflected over ${sources.length} day(s) -> strategy "${truncate(lesson, 100)}"`,
    );
    return lesson;
  }

  // -------------------------------------------------------------------------

  /** Embed + upsert one memory under the god's owner id. */
  private async write(
    text: string,
    kind: SupervisorMemoryKind,
    importance: number,
    meta: { tick: number; day: number },
  ): Promise<MemoryRecord> {
    const embedding = await embedOne(this.embeddings, text, { agent: this.owner });
    return this.store.upsert({
      villagerId: this.owner,
      text,
      embedding,
      timestamp: Date.now(),
      tick: meta.tick,
      kind,
      importance,
    });
  }

}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
