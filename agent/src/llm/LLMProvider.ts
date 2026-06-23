/**
 * agent/src/llm/LLMProvider.ts
 * ---------------------------------------------------------------------------
 * Phase 3 — "The Brains". The pluggable LLM seam.
 *
 * The mind must not care WHICH model is thinking for it — a hosted Claude, a
 * local Ollama model, or a stub in a test. This is that seam: a single `decide`
 * verb that takes a fully-built request (system persona + current-perception
 * message + the strict tool schemas) and returns the model's chosen tool call,
 * normalised to a provider-agnostic `{ name, input }`.
 *
 * Each provider does whatever is native underneath (Anthropic returns a
 * `tool_use` block; Ollama returns JSON), but everything above this interface —
 * the orchestrator, the decision parser, the publisher — is provider-blind.
 * Returning `null` means "the model declined to act this turn"; the service
 * simply waits for the next.
 * ---------------------------------------------------------------------------
 */

import type { ToolDefinition } from '../tools';
import type { LlmCallPurpose } from '../../../shared/types';

/** A model's chosen action, before validation. `input` is untrusted. */
export interface LLMToolCall {
  name: string;
  input: unknown;
}

/**
 * The outcome of one decision: the (un-validated) tool call the model chose,
 * plus its RAW output verbatim. The raw text feeds the telemetry stream (the
 * "Inception" feed) so the UI can show exactly what the model emitted before we
 * validated it — function-call JSON, or the content string in JSON mode.
 */
export interface LLMDecision {
  /** The model's chosen tool call, or null if it declined / produced nothing usable. */
  call: LLMToolCall | null;
  /** The model's raw output, for telemetry/debugging. Empty string if none. */
  raw: string;
}

/** Everything a provider needs to produce one decision. */
export interface LLMRequest {
  /** Stable persona + rules (the profile half). */
  system: string;
  /** Volatile, this-turn perception (what the villager senses now). */
  userMessage: string;
  /** The strict tool schemas the model must choose from. */
  tools: ToolDefinition[];
  /** Optional human label for the caller (e.g. a villager name), for the debug window. */
  agent?: string;
  /**
   * Why this decision is being asked for — a villager's own turn, or the God
   * Agent's. Telemetry-only (providers ignore it); the debug window uses it to
   * tell the two apart even though both hit the same `decide` seam.
   */
  purpose: Extract<LlmCallPurpose, 'decide' | 'supervisor'>;
}

/** A swappable mind. Inject whichever implementation the deployment wants. */
export interface LLMProvider {
  /** Human-readable name for logs (e.g. "anthropic", "ollama"). */
  readonly name: string;
  /**
   * Ask the model to pick exactly one tool given the request. Resolves to the
   * decision (the normalised tool call — or null if the model produced no usable
   * action — plus the raw output). Implementations should let network/transport
   * errors reject so the caller can decide whether to retry or skip the turn.
   */
  decide(request: LLMRequest): Promise<LLMDecision>;
}
