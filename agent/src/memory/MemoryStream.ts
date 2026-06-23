/**
 * agent/src/memory/MemoryStream.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The RAG orchestrator.
 *
 * This is the villager's hippocampus: the one object that binds the three moving
 * parts — the `EmbeddingProvider`, the `MemoryStore`, and (for reflection) the
 * `Synthesizer` — into the verbs the mind actually uses:
 *
 *   INGEST    `remember(seed)` — narrate → embed → store, with metadata.
 *   RETRIEVE  `recall(situation)` — embed the current situation, similarity-
 *             search this villager's memories, return the most relevant few.
 *   REFLECT   `reflect()` — read the day's mundane memories, ask the LLM to
 *             distil a Core Belief / Updated Goal, and store THAT back as a
 *             high-importance memory (which then surfaces in future recalls).
 *
 * It is scoped to one villager (`villagerId`) and holds no world state — just the
 * three injected collaborators and a watermark of when it last reflected, so
 * each night's reflection only chews on memories formed since the last one.
 * ---------------------------------------------------------------------------
 */

import { embedOne, type EmbeddingProvider } from './EmbeddingProvider';
import type { MemoryKind, MemoryRecord, MemoryStore, RecalledMemory } from './MemoryStore';
import type { Synthesizer } from './Synthesizer';
import type { RelationUpdate } from '../social/RelationshipBook';
import {
  narrateFact,
  narrateProcedure,
  narrateReflection,
  SimClock,
  type MemorySeed,
} from './narrative';

export interface MemoryStreamOptions {
  /** Default number of memories to retrieve per recall. Phase 4 spec: 5. */
  topK?: number;
  /** Maps ticks → time-of-day; shared with the reflection loop. */
  clock?: SimClock;
  /**
   * How many candidates to over-fetch before re-ranking, as a multiple of `topK`.
   * The vector search returns the `topK * multiplier` nearest by cosine; we then
   * re-score those by relevance × recency × importance and keep the best `topK`.
   * 1 disables re-ranking (pure cosine). Default 4 (env `RECALL_CANDIDATE_MULTIPLIER`).
   */
  candidateMultiplier?: number;
  /** Weight on semantic relevance (cosine) in the recall re-rank. Default 1.0. */
  relevanceWeight?: number;
  /** Weight on recency (how lately the memory formed) in the re-rank. Default 0.5. */
  recencyWeight?: number;
  /** Weight on importance (salience by kind) in the re-rank. Default 1.0. */
  importanceWeight?: number;
  /**
   * How long (ms) a recall result is reused for an IDENTICAL situation query before
   * being recomputed. A stationary villager emits the same situation string every
   * turn; without this it re-embeds + re-searches Qdrant each time for the same
   * answer. Any new memory (speech, sighting, planted idea) invalidates the cache
   * immediately, so this never hides a fresh memory. 0 disables. Default 30000
   * (env `RECALL_CACHE_TTL_MS`).
   */
  recallCacheTtlMs?: number;
  /**
   * Most `conversation` memories allowed in a single recall result. Group speech is
   * abundant and self-similar ("let's all haul water!"), so without a cap it floods
   * every recall and the mind just echoes the chatter back — the observed talk-loop.
   * Capping it leaves recall slots for the villager's own reasoning, learned facts,
   * and reflections, which is what actually moves behaviour forward. 0 disables the
   * cap. Default 2 (env `RECALL_CONVERSATION_CAP`).
   */
  conversationCap?: number;
}

/** A memoized recall, reused while the situation query is unchanged and fresh. */
interface RecallCacheEntry {
  key: string;
  result: RecalledMemory[];
  expiresAt: number;
  /** The `writeSeq` at compute time; a later write bumps it and busts this entry. */
  writeSeq: number;
}

/** Tunable weights for the relevance × recency × importance recall re-rank. */
interface RankWeights {
  relevance: number;
  recency: number;
  importance: number;
}

/** What a successful reflection produced, so the caller can act on it. */
export interface Reflection {
  /** The synthesized Core Belief / Updated Goal, in the villager's own voice. */
  synthesis: string;
  /** The stored reflection memory. */
  record: MemoryRecord;
  /** How many mundane memories fed the synthesis. */
  sourceCount: number;
  /** Discrete facts reasoned out this night and stored as `fact` memories. */
  facts: MemoryRecord[];
  /** Practical how-to lessons reasoned out and stored as `procedure` memories. */
  procedures: MemoryRecord[];
  /**
   * Revisions to how this villager regards its neighbours, distilled from the
   * day's shared moments — each names a person, a warmth nudge, and a fresh
   * opinion. Resolved to stable ids here; the caller folds them into its
   * {@link RelationshipBook}. Empty when the night changed no opinions.
   */
  relations: RelationUpdate[];
}

/** Most facts / procedures to keep from one night, so a chatty model can't flood the store. */
const MAX_DERIVED = 5;

/** A reflection split into its belief, learned facts, procedures, and relation lines. */
interface DistilledReflection {
  belief: string;
  facts: string[];
  procedures: string[];
  /** Raw relation lines, name not yet resolved to an id: name, warmth nudge, opinion. */
  relations: { name: string; affinityDelta: number; opinion: string }[];
}

/** A person this villager might form an opinion of — its canonical name + id. */
export interface KnownPerson {
  id: string;
  name: string;
}

export class MemoryStream {
  readonly clock: SimClock;
  private readonly topK: number;
  private readonly candidateMultiplier: number;
  private readonly weights: RankWeights;
  private readonly recallCacheTtlMs: number;
  private readonly conversationCap: number;
  /** Wall-clock ms of the last reflection; next reflection reads only after it. */
  private lastReflectionAt = 0;

  /** Last memoized recall, reused for a repeated situation until a write or TTL. */
  private recallCache: RecallCacheEntry | null = null;
  /** Monotonic write counter; bumped on every `remember`, busts a stale recall cache. */
  private writeSeq = 0;

  constructor(
    private readonly villagerId: string,
    private readonly embeddings: EmbeddingProvider,
    private readonly store: MemoryStore,
    private readonly synthesizer: Synthesizer,
    options: MemoryStreamOptions = {},
  ) {
    this.topK = options.topK ?? 5;
    this.clock = options.clock ?? new SimClock();
    this.candidateMultiplier = Math.max(
      1,
      options.candidateMultiplier ?? numEnv('RECALL_CANDIDATE_MULTIPLIER', 4),
    );
    this.weights = {
      relevance: options.relevanceWeight ?? numEnv('RECALL_W_RELEVANCE', 1.0),
      recency: options.recencyWeight ?? numEnv('RECALL_W_RECENCY', 0.5),
      importance: options.importanceWeight ?? numEnv('RECALL_W_IMPORTANCE', 1.0),
    };
    this.recallCacheTtlMs = Math.max(0, options.recallCacheTtlMs ?? numEnv('RECALL_CACHE_TTL_MS', 30_000));
    this.conversationCap = Math.max(0, options.conversationCap ?? numEnv('RECALL_CONVERSATION_CAP', 2));
  }

  /** Ensure the underlying store is ready. Call once at boot. */
  async init(): Promise<void> {
    await this.store.init();
  }

  // -------------------------------------------------------------------------
  // INGEST
  // -------------------------------------------------------------------------

  /**
   * Narrate → embed → store one experience. The `seed` already carries the
   * narrative `text` and metadata (see `narrative.ts`); here we just attach the
   * embedding and the owning villager and persist it.
   */
  async remember(seed: MemorySeed): Promise<MemoryRecord> {
    const embedding = await embedOne(this.embeddings, seed.text, { agent: this.villagerId });
    const record = await this.store.upsert({
      villagerId: this.villagerId,
      text: seed.text,
      embedding,
      timestamp: seed.timestamp,
      tick: seed.tick,
      kind: seed.kind,
      importance: seed.importance,
      ...(seed.participants ? { participants: seed.participants } : {}),
      ...(seed.location ? { location: seed.location } : {}),
    });
    // A new memory can change what the next recall should surface (a planted idea,
    // a fresh reply, a first sighting). Bump the write counter so any cached recall
    // is treated as stale even if the situation string is unchanged.
    this.writeSeq++;
    return record;
  }

  // -------------------------------------------------------------------------
  // RETRIEVE
  // -------------------------------------------------------------------------

  /**
   * Given a description of the current situation (e.g. "Alice is approaching me"),
   * return the most relevant memories for this villager, best first.
   *
   * Two optimizations sit on top of the raw vector search:
   *   1. CACHE — a stationary/idle villager emits the SAME situation string turn
   *      after turn. We memoize the result and reuse it until the TTL lapses or a
   *      new memory is stored (`writeSeq`), saving an embed + Qdrant round-trip on
   *      every such turn.
   *   2. RE-RANK — we over-fetch `topK * candidateMultiplier` nearest by cosine,
   *      then re-score by relevance × recency × importance (à la the generative-
   *      agents paper) and keep the best `topK`. This is what actually lets a
   *      max-importance implanted idea or a recent reflection surface, rather than
   *      relying on pure cosine proximity.
   *
   * Returns [] (never throws) on an empty/failed recall so a memory hiccup degrades
   * the villager to amnesiac rather than killing the turn.
   */
  async recall(situation: string, kinds?: MemoryKind[]): Promise<RecalledMemory[]> {
    const cacheKey = `${kinds?.slice().sort().join(',') ?? ''}::${situation}`;
    const cached = this.cachedRecall(cacheKey);
    if (cached) return cached;

    try {
      const embedding = await embedOne(this.embeddings, situation, { agent: this.villagerId });
      const candidates = await this.store.search({
        villagerId: this.villagerId,
        embedding,
        // Over-fetch so the re-rank has room to promote a recent/important memory
        // over a marginally-closer but mundane one. Capped so a big store can't
        // make recall expensive.
        topK: Math.min(this.topK * this.candidateMultiplier, 50),
        ...(kinds ? { kinds } : {}),
      });
      // multiplier 1 == "off": trust the vector store's cosine order as-is. Either
      // way we rank/keep the FULL list first, then select topK with the conversation
      // cap applied, so capping a flood of chatter promotes the next-best memory
      // rather than just leaving an empty slot.
      const ranked = this.candidateMultiplier > 1 ? this.rankCandidates(candidates) : candidates;
      const selected = this.selectWithConversationCap(ranked, this.topK);
      this.storeRecall(cacheKey, selected);
      return selected;
    } catch (err) {
      console.warn(`[memory:${this.villagerId}] recall failed, proceeding without memories:`, errMsg(err));
      return [];
    }
  }

  /**
   * Take the best `topK` from an already-ranked list, but admit at most
   * {@link conversationCap} `conversation` memories — so abundant, self-similar group
   * speech can't crowd out the villager's reasoning, facts, and reflections. Any
   * conversation memories skipped by the cap are used last to backfill if the rest of
   * the store is too thin to fill `topK`, so we never return fewer than we could.
   */
  private selectWithConversationCap(ranked: RecalledMemory[], topK: number): RecalledMemory[] {
    if (this.conversationCap === 0) return ranked.slice(0, topK);
    const kept: RecalledMemory[] = [];
    const overflow: RecalledMemory[] = [];
    let conversations = 0;
    for (const m of ranked) {
      if (kept.length >= topK) break;
      if (m.kind === 'conversation') {
        if (conversations >= this.conversationCap) {
          overflow.push(m);
          continue;
        }
        conversations++;
      }
      kept.push(m);
    }
    // Backfill from the capped-out conversations only if nothing else was available.
    for (const m of overflow) {
      if (kept.length >= topK) break;
      kept.push(m);
    }
    return kept;
  }

  /** Return the memoized recall for `key` if still valid (TTL + no later write). */
  private cachedRecall(key: string): RecalledMemory[] | null {
    if (this.recallCacheTtlMs === 0) return null;
    const c = this.recallCache;
    if (!c || c.key !== key || c.writeSeq !== this.writeSeq || Date.now() >= c.expiresAt) return null;
    return c.result;
  }

  /** Memoize a freshly-computed recall against the current write counter + TTL. */
  private storeRecall(key: string, result: RecalledMemory[]): void {
    if (this.recallCacheTtlMs === 0) return;
    this.recallCache = {
      key,
      result,
      writeSeq: this.writeSeq,
      expiresAt: Date.now() + this.recallCacheTtlMs,
    };
  }

  /**
   * Re-score cosine candidates by a blend of relevance, recency and importance,
   * each min-max normalized ACROSS the candidate set so the three live on the same
   * [0,1] scale regardless of their raw units (cosine vs. wall-clock ms vs. [0,1]
   * salience). Highest blended score first. With one candidate (or `multiplier` 1)
   * this is a no-op pass-through of the cosine order.
   */
  private rankCandidates(candidates: RecalledMemory[]): RecalledMemory[] {
    if (candidates.length <= 1) return candidates;
    const norm = (vals: number[]): number[] => {
      let min = Infinity;
      let max = -Infinity;
      for (const v of vals) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = max - min;
      // No spread → this signal can't break ties; contribute 0 for everyone.
      return span === 0 ? vals.map(() => 0) : vals.map((v) => (v - min) / span);
    };

    const rel = norm(candidates.map((m) => m.score));
    const rec = norm(candidates.map((m) => m.timestamp));
    const imp = norm(candidates.map((m) => m.importance));
    const { relevance, recency, importance } = this.weights;

    return candidates
      .map((m, i) => ({
        m,
        rank: relevance * rel[i]! + recency * rec[i]! + importance * imp[i]!,
      }))
      .sort((a, b) => b.rank - a.rank)
      .map((x) => x.m);
  }

  // -------------------------------------------------------------------------
  // REFLECT
  // -------------------------------------------------------------------------

  /**
   * The nightly synthesis. Pull the mundane memories formed since the last
   * reflection, then ask the LLM — in ONE call — to distil them into three
   * things: a single Core Belief / Updated Goal, the concrete FACTS it now knows,
   * and the practical HOW-TO procedures it has figured out. Each is stored as its
   * own high-importance memory so all three surface in future recalls. Returns
   * null when there is nothing new worth reflecting on.
   *
   * Folding facts + procedures into this existing once-a-night pass means no
   * extra per-turn LLM cost — the slow chat model is hit exactly as often as
   * before; only the (cheap, GPU-served) embeddings grow by a handful per night.
   *
   * @param tick   the current simulation tick (stamps the reflection).
   * @param profile minimal identity used to frame the synthesis prompt.
   */
  async reflect(
    tick: number,
    profile: { name: string; traits: string[]; goal: string },
    knownPeople: KnownPerson[] = [],
  ): Promise<Reflection | null> {
    const sources = await this.store.recent(this.villagerId, {
      limit: 50,
      since: this.lastReflectionAt || undefined,
      // Reflect on lived experience AND the day's private deliberations, but not on
      // prior derived knowledge (facts/procedures/reflections) — that avoids drift loops.
      kinds: ['observation', 'conversation', 'reasoning'],
    });
    if (sources.length === 0) {
      console.log(`[memory:${this.villagerId}] nothing new to reflect on tonight`);
      return null;
    }

    const digest = sources
      .slice()
      .reverse() // oldest → newest, so the narrative reads chronologically
      .map((m) => `- ${m.text}`)
      .join('\n');

    const raw = (
      await this.synthesizer.synthesize({
        system: REFLECTION_SYSTEM(profile),
        agent: profile.name ?? this.villagerId,
        user: REFLECTION_PROMPT(digest, knownPeople),
        purpose: 'reflect',
      })
    ).trim();

    const { belief, facts, procedures, relations: rawRelations } = parseReflection(raw);
    // Resolve each relation line's free-text name back to a stable villager id, so
    // the book is keyed by id (names can be partial — "Mira" for "Mira the Blacksmith").
    const relations = resolveRelations(rawRelations, knownPeople);

    // The belief is the headline reflection (unchanged behaviour); facts and
    // procedures are stored separately so they recall as discrete knowledge.
    const record = await this.remember(narrateReflection({ synthesis: belief, tick }, this.clock));
    const factRecords: MemoryRecord[] = [];
    for (const fact of facts) {
      factRecords.push(await this.remember(narrateFact({ fact, tick }, this.clock)));
    }
    const procedureRecords: MemoryRecord[] = [];
    for (const procedure of procedures) {
      procedureRecords.push(await this.remember(narrateProcedure({ procedure, tick }, this.clock)));
    }

    this.lastReflectionAt = Date.now();
    console.log(
      `[memory:${this.villagerId}] reflected over ${sources.length} memories -> ` +
        `belief "${truncate(belief, 100)}" · ${factRecords.length} fact(s) · ` +
        `${procedureRecords.length} procedure(s) · ${relations.length} relation(s)`,
    );
    return {
      synthesis: belief,
      record,
      sourceCount: sources.length,
      facts: factRecords,
      procedures: procedureRecords,
      relations,
    };
  }
}

/**
 * Resolve the reflection's free-text relation names to stable ids against the
 * known roster. Matches case-insensitively on the full name first, then on any
 * name token (so "Mira" finds "Mira the Blacksmith"). Unmatched lines are dropped
 * — a villager can only re-judge people it actually knows.
 */
function resolveRelations(
  raw: { name: string; affinityDelta: number; opinion: string }[],
  known: KnownPerson[],
): RelationUpdate[] {
  const out: RelationUpdate[] = [];
  for (const r of raw) {
    const wanted = r.name.trim().toLowerCase();
    if (!wanted) continue;
    const hit =
      known.find((p) => p.name.toLowerCase() === wanted) ??
      known.find((p) => p.name.toLowerCase().split(/\s+/).includes(wanted)) ??
      known.find((p) => wanted.split(/\s+/).some((w) => p.name.toLowerCase().split(/\s+/).includes(w)));
    if (!hit) continue;
    out.push({ otherId: hit.id, otherName: hit.name, affinityDelta: r.affinityDelta, opinion: r.opinion });
  }
  return out;
}

/** The user half of the reflection prompt: the day's digest + the labelled-line format. */
function REFLECTION_PROMPT(digest: string, known: KnownPerson[]): string {
  const lines = [
    `Here is what I experienced today:\n${digest}`,
    '',
    'Think it over, then write ONLY these labelled lines, each on its own line:',
    'BELIEF: my single most important takeaway today, as a Core Belief or an Updated Goal — one or two sentences, first person.',
    'FACT: a concrete fact I now know about this village or its people (e.g. where something is, who does what). Only facts I have real evidence for. One per line; write several FACT lines or none.',
    'HOWTO: a practical lesson about how to accomplish something here, phrased as a reusable instruction to myself. One per line; write several HOWTO lines or none.',
  ];
  if (known.length > 0) {
    lines.push(
      `RELATION: how a day with someone changed what I make of them. Format exactly: RELATION: <name> | <+N or -N> | <one short opinion>. The number is how much warmer (+) or cooler (-) I now feel toward them, from -35 to +35, based on what actually passed between us today. The opinion is one honest line in my own voice. Write one RELATION line per person I had real dealings with today, or none if no one left an impression. People I know: ${known
        .map((p) => p.name)
        .join(', ')}.`,
    );
  }
  lines.push(
    '',
    'Omit any label I have nothing for. Write in the first person, in my own voice. Output nothing but these labelled lines.',
  );
  return lines.join('\n');
}

/**
 * Parse the labelled-line reflection into its parts, tolerantly: any of
 * `BELIEF:`, `FACT:`, `HOWTO:` (also `HOW-TO`/`PROCEDURE`, `-` separators).
 * If the model ignored the format entirely, the whole text becomes the belief —
 * preserving the original single-takeaway behaviour.
 */
function parseReflection(raw: string): DistilledReflection {
  const facts: string[] = [];
  const procedures: string[] = [];
  const relations: { name: string; affinityDelta: number; opinion: string }[] = [];
  let belief = '';

  const LINE = /^\s*(belief|fact|howto|how-to|how to|procedure|relation)\s*[:\-–]\s*(.+?)\s*$/i;
  for (const line of raw.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    const body = m[2]!.trim();
    if (!body) continue;
    if (tag === 'belief') {
      if (!belief) belief = body; // first BELIEF wins
    } else if (tag === 'fact') {
      if (facts.length < MAX_DERIVED) facts.push(body);
    } else if (tag === 'relation') {
      const parsed = parseRelationLine(body);
      if (parsed && relations.length < MAX_DERIVED) relations.push(parsed);
    } else {
      // howto / how-to / how to / procedure
      if (procedures.length < MAX_DERIVED) procedures.push(body);
    }
  }

  // No labels recognised at all: treat the entire output as the belief.
  if (!belief && facts.length === 0 && procedures.length === 0 && relations.length === 0) belief = raw.trim();
  // Labels present but no explicit BELIEF: keep a non-empty headline anyway.
  else if (!belief) belief = 'I reflected on the day.';

  return { belief, facts, procedures, relations };
}

/**
 * Parse one RELATION body — "<name> | <+N> | <opinion>" — tolerantly. Accepts `|`
 * or several other separators, a signed or bare number, and a trailing opinion.
 * Returns null if no name can be made out.
 */
function parseRelationLine(body: string): { name: string; affinityDelta: number; opinion: string } | null {
  const parts = body.split(/\s*[|;]\s*/);
  const name = (parts[0] ?? '').trim();
  if (!name) return null;
  const num = (parts[1] ?? '').match(/-?\d+/);
  const affinityDelta = num ? Number(num[0]) : 0;
  const opinion = (parts.slice(2).join(' | ') || '').trim();
  return { name, affinityDelta, opinion };
}

/** System framing for the reflection completion — persona-aware, terse. */
function REFLECTION_SYSTEM(profile: { name: string; traits: string[]; goal: string }): string {
  return [
    `You are ${profile.name}, a villager (${profile.traits.join(', ')}).`,
    `Your standing goal is: ${profile.goal}`,
    'You are lying awake at night, thinking back over the day. Speak as yourself,',
    'in the first person. Be concrete and grounded in what actually happened.',
  ].join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a numeric env var, falling back to `fallback` when unset or non-numeric. */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
