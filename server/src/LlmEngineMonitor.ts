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
import type { LlmCallPurpose } from '../../shared/types';
import type { LlmCallFinish, LlmCallMonitor, LlmCallStart } from '../../agent/src/llm/HttpLLMClient';

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
      }),
    );
  }
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
    return clip(`${asText(r.userMessage)}${tools}`);
  }
  if (endpoint === '/complete') return clip(asText(r.user));
  if (endpoint === '/embed') {
    const texts = Array.isArray(r.texts) ? (r.texts as unknown[]) : [];
    const first = texts.length > 0 ? asText(texts[0]) : '';
    return clip(texts.length > 1 ? `[1/${texts.length}] ${first}` : first);
  }
  return clip(asText(r));
}

/** Human-readable preview of a successful reply. */
function previewResponse(endpoint: string, response: unknown): string {
  const r = response as Record<string, unknown> | undefined;
  if (!r) return '';
  if (endpoint === '/decide') {
    const call = r.call as { name?: string; input?: unknown } | null | undefined;
    if (!call) return 'declined (no tool call)';
    return clip(`${call.name ?? '?'}(${asText(call.input)})`);
  }
  if (endpoint === '/complete') return clip(asText(r.text));
  if (endpoint === '/embed') {
    const vectors = Array.isArray(r.vectors) ? (r.vectors as unknown[][]) : [];
    const dim = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    return `${vectors.length} vector(s)${dim ? ` · dim ${dim}` : ''}`;
  }
  return clip(asText(r));
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
