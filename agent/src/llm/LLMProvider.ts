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
import type { EffortPurpose, LlmCallPurpose, LlmMessage, LlmRouteHint, LlmUsage } from '../../../shared/types';

/** A model's chosen action, before validation. `input` is untrusted. */
export interface LLMToolCall {
  /** Provider-issued call id, so a multi-tool turn can correlate each result back. May be empty. */
  id?: string;
  name: string;
  input: unknown;
}

/**
 * One ASSISTANT TURN of the agentic loop: any visible text the model produced,
 * plus the tool calls it wants run (zero = it is done / yielding). The backend
 * loop executes the calls, appends their results to the transcript, and asks for
 * the next turn until the model yields or a step budget is hit.
 */
export interface LLMTurn {
  /** Visible content the model emitted this turn (may include `<think>` reasoning). */
  content: string;
  /** The tool calls to run, in order. Empty when the model produced no call (yield). */
  toolCalls: LLMToolCall[];
  /** The model's raw output verbatim, for telemetry. */
  raw: string;
  /** Token usage the server reported for this turn, when available. */
  usage?: LlmUsage;
}

/** Everything a provider needs to produce one {@link LLMTurn} in the agentic loop. */
export interface LLMConverseRequest {
  /** The running transcript: system + user + prior assistant/tool messages. */
  messages: LlmMessage[];
  /** The tools (read + action) the model may call this turn. */
  tools: ToolDefinition[];
  /** Optional human label for the caller (villager name / "God Agent"), for telemetry. */
  agent?: string;
  /** Why the turn is being asked for — a villager's decision or the God Agent's. */
  purpose: Extract<LlmCallPurpose, 'decide' | 'supervisor'>;
  /** Optional pool routing (endpoint/model). */
  route?: LlmRouteHint;
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
  /** Token usage the model server reported for this call, when it reports any. */
  usage?: LlmUsage;
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
  /**
   * Optional POOL routing: which endpoint/model this call should run on. Read by
   * the pooled engine to spread minds across parallel endpoints; a single
   * in-process provider ignores it. Omit both to let the pool pick a free endpoint.
   */
  route?: LlmRouteHint;
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
  /**
   * Run one ASSISTANT TURN of the agentic loop over a message transcript: resolves
   * to the {@link LLMTurn} (visible content + the tool calls to run, or none when the
   * model yields). The backend loop drives multiple of these per granted turn. A
   * provider may implement it atop the same engine call `decide` uses; it is optional
   * only so a minimal stub can omit it.
   */
  converse?(request: LLMConverseRequest): Promise<LLMTurn>;
  /**
   * The system prompt the model will ACTUALLY receive for `purpose` — i.e.
   * `system` plus any transformation this provider applies before sending (today,
   * the reasoning-effort directive the shared HTTP client appends). Telemetry uses
   * it so the thought inspector shows the real, final prompt rather than the bare
   * one the caller composed. Optional: a provider that sends `system` verbatim can
   * omit it, and callers fall back to `system` unchanged.
   */
  effectiveSystem?(system: string, purpose: EffortPurpose): string;
}
