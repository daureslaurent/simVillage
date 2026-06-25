/**
 * agent/src/memory/Synthesizer.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The free-text completion seam.
 *
 * The acting path (`LLMProvider`) is deliberately tool-only: a villager's mind
 * may emit nothing but a validated tool call onto the bus. Reflection is a
 * different kind of thinking — at night the villager reads its own diary and writes
 * a paragraph of prose ("my core belief / updated goal"). That needs an
 * unconstrained text completion, not a tool call, so it gets its own narrow
 * seam rather than bending the strict action contract.
 *
 * Keeping it separate means the dangerous, bus-facing path stays strict while
 * this introspective path can be plain text, and either can be swapped or
 * stubbed independently.
 * ---------------------------------------------------------------------------
 */

import type { LlmCallPurpose, LlmRouteHint } from '../../../shared/types';

/** A request for a single free-text completion. */
export interface SynthesisRequest {
  /** Instruction / role framing. */
  system: string;
  /** The material to synthesize over (the recent-memories digest). */
  user: string;
  /** Optional human label for the caller (e.g. a villager name), for the debug window. */
  agent?: string;
  /**
   * Why this completion is being asked for — nightly reflection or daily
   * planning. Telemetry-only; both hit the same `complete` seam so the debug
   * window needs this to tell them apart.
   */
  purpose: Extract<LlmCallPurpose, 'reflect' | 'plan'>;
  /** Optional pool routing (endpoint/model) for the completion. See {@link LlmRouteHint}. */
  route?: LlmRouteHint;
  /**
   * Optional cap on the completion length (tokens), overriding the synthesizer's
   * default. Raise it for a big structured answer on a THINKING model, which spends
   * tokens reasoning before it writes — too tight a cap and it never reaches the
   * actual output (world generation asks for a large JSON, so it bumps this).
   */
  maxTokens?: number;
}

/** A swappable text generator used only by the reflection loop. */
export interface Synthesizer {
  readonly name: string;
  /** Produce one free-text completion. Rejects on transport error. */
  synthesize(request: SynthesisRequest): Promise<string>;
}
