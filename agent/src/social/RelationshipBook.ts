/**
 * agent/src/social/RelationshipBook.ts
 * ---------------------------------------------------------------------------
 * One villager's SOCIAL MEMORY — what it has come to think of each neighbour.
 *
 * Where the vector store remembers individual moments, this is the distilled
 * STANDING of every person the villager knows: a warmth score (affinity) and a
 * single evolving opinion. It is the seam that lets memories and reasoning change
 * how neighbours regard each other — the book is revised each night, when the
 * reflection looks back over the day's shared moments and re-judges each person.
 *
 * It is plain in-memory state (a Map keyed by the other villager's id), with a
 * tiny verb set: read one tie, read them all, and apply a batch of nightly
 * updates. Persistence and the UI stream live a layer up (AgentService wires a
 * Mongo store and a bus publish to {@link apply}); the book itself stays pure.
 * ---------------------------------------------------------------------------
 */

import type { Relationship } from '../../../shared/types';

/** Hard bounds on affinity — clamp every update into [-100, 100]. */
const AFFINITY_MIN = -100;
const AFFINITY_MAX = 100;

/** Most an opinion can shift in a single night, so one bad day can't make enemies. */
const MAX_DELTA_PER_UPDATE = 35;

/** One nightly revision to a single tie, parsed from the reflection. */
export interface RelationUpdate {
  /** The other villager (resolved to a stable id before it reaches the book). */
  otherId: string;
  /** Their display name, kept current on the tie. */
  otherName: string;
  /** Signed nudge to apply to the existing affinity (clamped per update). */
  affinityDelta: number;
  /** The new one-line opinion, in the villager's own voice. Empty leaves it unchanged. */
  opinion: string;
}

export class RelationshipBook {
  private readonly ties = new Map<string, Relationship>();

  constructor(initial: Relationship[] = []) {
    for (const r of initial) this.ties.set(r.otherId, { ...r });
  }

  /** This villager's view of one neighbour, or undefined if they are strangers yet. */
  get(otherId: string): Relationship | undefined {
    return this.ties.get(otherId);
  }

  /** True once at least one tie has been formed (so callers can skip an empty block). */
  get size(): number {
    return this.ties.size;
  }

  /** Every tie, strongest feeling first (then by name) — the order the prompt/UI read. */
  all(): Relationship[] {
    return [...this.ties.values()].sort(
      (a, b) => Math.abs(b.affinity) - Math.abs(a.affinity) || a.otherName.localeCompare(b.otherName),
    );
  }

  /**
   * Fold a night's worth of revisions into the book. Each update nudges the
   * affinity (bounded per night, then clamped to the full range) and replaces the
   * opinion when a fresh one is given. Returns the full, updated list so the caller
   * can persist it and stream it to the UI in one go.
   */
  apply(updates: RelationUpdate[], tick: number): Relationship[] {
    for (const u of updates) {
      if (!u.otherId) continue;
      const existing = this.ties.get(u.otherId);
      const delta = clamp(u.affinityDelta, -MAX_DELTA_PER_UPDATE, MAX_DELTA_PER_UPDATE);
      const affinity = clamp((existing?.affinity ?? 0) + delta, AFFINITY_MIN, AFFINITY_MAX);
      this.ties.set(u.otherId, {
        otherId: u.otherId,
        otherName: u.otherName || existing?.otherName || u.otherId,
        affinity,
        opinion: u.opinion || existing?.opinion || '',
        lastTick: tick,
      });
    }
    return this.all();
  }

  /** A serialisable snapshot, for persistence. */
  toArray(): Relationship[] {
    return this.all();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A warm/neutral/cool word for an affinity score, for prompt and UI labels. */
export function affinityWord(affinity: number): string {
  if (affinity >= 70) return 'devoted to';
  if (affinity >= 35) return 'fond of';
  if (affinity >= 10) return 'warm toward';
  if (affinity > -10) return 'neutral toward';
  if (affinity > -35) return 'cool toward';
  if (affinity > -70) return 'wary of';
  return 'hostile to';
}
