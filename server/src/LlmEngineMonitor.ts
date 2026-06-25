/**
 * server/src/LlmEngineMonitor.ts
 * ---------------------------------------------------------------------------
 * The bridge between the LLM client's round-trips and the browser's debug
 * window. It implements `LlmCallMonitor` (the side-channel `HttpLLMClient`
 * exposes) and republishes each start/finish onto the in-process bus as an
 * `engine.telemetry` event, which the gateway forwards to every browser.
 *
 * Its real work is COMPACTION: the raw request/response bodies are large (full
 * system prompts, tool schemas, embedding vectors), so it distils each into a
 * short human-readable preview before it ever hits the wire — enough to debug
 * "which call is running and what did the last one return" without shipping
 * megabytes of prompt to the UI every turn.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type { LlmCallPurpose, LlmUsage } from '../../shared/types';
import type { LlmCallDelta, LlmCallFinish, LlmCallMonitor, LlmCallStart } from '../../agent/src/llm/HttpLLMClient';

/** Longest preview string we put on the wire; prompts/replies are clipped to this. */
const MAX_PREVIEW = 600;

const KNOWN_PURPOSES: readonly LlmCallPurpose[] = ['decide', 'supervisor', 'reflect', 'plan', 'embed'];

export class LlmEngineMonitor implements LlmCallMonitor {
  constructor(private readonly bus: EventBus) {}

  onStart(call: LlmCallStart): void {
    const purpose = purposeOf(call.endpoint, call.request);
    this.bus.publish(
      EXCHANGES.engineTelemetry,
      makeEvent('engine.llm.started', {
        id: call.id,
        endpoint: call.endpoint,
        purpose,
        agent: agentOf(call.request),
        label: labelFor(call.endpoint, purpose, call.request),
        request: previewRequest(call.endpoint, call.request),
        startedAt: call.startedAt,
      }),
    );
  }

  onDelta(call: LlmCallDelta): void {
    // A streamed slice of an in-flight `/decide` call. Passed through verbatim —
    // it is already small (one chunk), and the Live LLM window correlates it with
    // the matching `started` event by id, so no enrichment is needed here.
    this.bus.publish(
      EXCHANGES.engineTelemetry,
      makeEvent('engine.llm.delta', {
        id: call.id,
        ...(call.content ? { content: call.content } : {}),
        ...(call.reasoning ? { reasoning: call.reasoning } : {}),
      }),
    );
  }

  onFinish(call: LlmCallFinish): void {
    // No request body at finish time (see `LlmCallFinish`) — best-effort by
    // endpoint alone. The debug window prefers the matching start event's
    // (exact) purpose/label for display; this is only the fallback.
    const purpose = purposeOf(call.endpoint, undefined);
    this.bus.publish(
      EXCHANGES.engineTelemetry,
      makeEvent('engine.llm.finished', {
        id: call.id,
        endpoint: call.endpoint,
        purpose,
        label: labelFor(call.endpoint, purpose, undefined),
        ok: call.ok,
        ...(call.status !== undefined ? { status: call.status } : {}),
        durationMs: call.durationMs,
        response: call.ok ? previewResponse(call.endpoint, call.response) : '',
        ...(call.error ? { error: clip(call.error) } : {}),
        startedAt: call.startedAt,
        ...(call.ok && call.endpoint === '/decide'
          ? { toolCount: countToolCalls(call.response) }
          : {}),
        ...(call.ok ? attachUsage(call.response) : {}),
      }),
    );
  }
}

/** Pull the `usage` block off a successful reply (the /decide path carries it). */
function attachUsage(response: unknown): { usage?: LlmUsage } {
  const usage = (response as { usage?: LlmUsage } | undefined)?.usage;
  return usage ? { usage } : {};
}

/** The caller tag every request body carries (set by the villager / supervisor / memory). */
function agentOf(request: unknown): string {
  const a = (request as { agent?: unknown })?.agent;
  return typeof a === 'string' && a.length > 0 ? a : 'unknown';
}

/**
 * Why the call was made. `/embed` only ever means one thing; `/decide` and
 * `/complete` carry an explicit `purpose` on the request body (set by the
 * caller — villager turn vs. God Agent, or reflection vs. daily planning) that
 * a bare endpoint can't tell apart.
 */
function purposeOf(endpoint: string, request: unknown): LlmCallPurpose {
  if (endpoint === '/embed') return 'embed';
  const p = (request as { purpose?: unknown })?.purpose;
  if (typeof p === 'string' && (KNOWN_PURPOSES as readonly string[]).includes(p)) {
    return p as LlmCallPurpose;
  }
  return endpoint === '/complete' ? 'reflect' : 'decide';
}

/** A short verb-ish label for the call, e.g. "decide" or "embed ×3". */
function labelFor(endpoint: string, purpose: LlmCallPurpose, request: unknown): string {
  if (endpoint === '/embed') {
    const n = Array.isArray((request as { texts?: unknown[] })?.texts)
      ? (request as { texts: unknown[] }).texts.length
      : undefined;
    return n !== undefined ? `embed ×${n}` : 'embed';
  }
  return purpose;
}

/** Human-readable preview of an outbound request body. */
function previewRequest(endpoint: string, request: unknown): string {
  const r = request as Record<string, unknown> | undefined;
  if (!r) return '';
  if (endpoint === '/decide') {
    const tools = Array.isArray(r.tools) ? `  ·  ${r.tools.length} tools` : '';
    // Agentic path carries a `messages` transcript; show the latest user/tool message.
    // Legacy path carries a single `userMessage`.
    const latest = Array.isArray(r.messages) ? latestMessageText(r.messages) : asText(r.userMessage);
    return clip(`${latest}${tools}`);
  }
  if (endpoint === '/complete') return clip(asText(r.user));
  if (endpoint === '/embed') {
    const texts = Array.isArray(r.texts) ? (r.texts as unknown[]) : [];
    const first = texts.length > 0 ? asText(texts[0]) : '';
    return clip(texts.length > 1 ? `[1/${texts.length}] ${first}` : first);
  }
  return clip(asText(r));
}

/**
 * The tool calls a `/decide` reply emitted. The agentic path returns a `turn`
 * (content + tool calls); the legacy path returns a single `call`.
 */
function toolCallsOf(r: Record<string, unknown>): Array<{ name?: string; input?: unknown }> {
  return Array.isArray(r.toolCalls)
    ? (r.toolCalls as Array<{ name?: string; input?: unknown }>)
    : r.call
      ? [r.call as { name?: string; input?: unknown }]
      : [];
}

/** How many tool calls a successful `/decide` reply emitted. */
function countToolCalls(response: unknown): number {
  const r = response as Record<string, unknown> | undefined;
  return r ? toolCallsOf(r).length : 0;
}

/** Human-readable preview of a successful reply. */
function previewResponse(endpoint: string, response: unknown): string {
  const r = response as Record<string, unknown> | undefined;
  if (!r) return '';
  if (endpoint === '/decide') {
    const calls = toolCallsOf(r);
    if (calls.length === 0) {
      const content = asText(r.content);
      return content ? clip(content) : 'yield (no tool call)';
    }
    return clip(calls.map((c) => `${c.name ?? '?'}(${asText(c.input)})`).join(', '));
  }
  if (endpoint === '/complete') return clip(asText(r.text));
  if (endpoint === '/embed') {
    const vectors = Array.isArray(r.vectors) ? (r.vectors as unknown[][]) : [];
    const dim = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    return `${vectors.length} vector(s)${dim ? ` · dim ${dim}` : ''}`;
  }
  return clip(asText(r));
}

/**
 * The text of the most recent meaningful message in a transcript — the latest
 * `tool` result or `user` turn — so the preview shows what the model is responding
 * to right now (a fed-back lookup result, or the original perception), not the
 * stale system prompt.
 */
function latestMessageText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown; name?: string } | undefined;
    if (!m) continue;
    if (m.role === 'tool') return `↳ ${m.name ?? 'tool'}: ${asText(m.content)}`;
    if (m.role === 'user') return asText(m.content);
  }
  return '';
}

/** Coerce any value to a single-line string for previewing. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(s: string): string {
  return s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW - 1)}…` : s;
}
