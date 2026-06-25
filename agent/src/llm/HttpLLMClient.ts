/**
 * agent/src/llm/HttpLLMClient.ts
 * ---------------------------------------------------------------------------
 * The client half of the shared LLM engine — the seam every mind holds.
 *
 * The backend and the llm engine are separate processes (so the engine can sit
 * next to the GPU and be restarted on its own), so they talk over plain HTTP.
 * This client implements the same three interfaces the local llama clients do
 * (`LLMProvider`, `Synthesizer`, `EmbeddingProvider`) by POSTing to the engine's
 * `/decide`, `/complete`, and `/embed` endpoints. The engine serializes all of
 * it against the one llama server, so a villager, the God Agent, and the
 * reflection writer all "have an LLM" without ever hitting llama concurrently.
 *
 * A per-call timeout guards against an engine that never answers, so a mind
 * degrades to "skipped a turn" rather than hanging.
 * ---------------------------------------------------------------------------
 */

import type { LLMConverseRequest, LLMDecision, LLMProvider, LLMRequest, LLMTurn } from './LLMProvider';
import type { EmbeddingProvider, EmbedMeta } from '../memory/EmbeddingProvider';
import type { Synthesizer, SynthesisRequest } from '../memory/Synthesizer';
import {
  DEFAULT_REASONING_EFFORT,
  reasoningEffortInstruction,
  type EffortPurpose,
  type LlmMessage,
  type LlmModelConfig,
  type LlmPoolConfig,
  type ReasoningEffort,
  type ReasoningEffortSettings,
} from '../../../shared/types';

/** Which engine endpoint a call hits. */
export type LlmEndpoint = '/decide' | '/complete' | '/embed';

/** One in-flight call, handed to a {@link LlmCallMonitor} as it starts. */
export interface LlmCallStart {
  /** Monotonic per-client id, correlating the start with its finish. */
  id: number;
  endpoint: LlmEndpoint;
  /** The exact request body sent to the engine. */
  request: unknown;
  startedAt: number;
}

/**
 * One streamed slice of an in-flight `/decide` call, handed to the monitor as it
 * arrives so the live view can grow in real time. Carries the newest chunk of
 * visible `content` and/or the model's separately-reported `reasoning`.
 */
export interface LlmCallDelta {
  id: number;
  content?: string;
  reasoning?: string;
}

/** The outcome of a call, handed to a {@link LlmCallMonitor} when it settles. */
export interface LlmCallFinish {
  id: number;
  endpoint: LlmEndpoint;
  startedAt: number;
  durationMs: number;
  /** True on a 2xx with a parsed body; false on HTTP error, abort, or parse failure. */
  ok: boolean;
  /** HTTP status when the engine answered non-2xx; absent on transport/abort errors. */
  status?: number;
  /** The parsed reply (decision / { text } / { vectors }) on success. */
  response?: unknown;
  /** Error message when `ok` is false. */
  error?: string;
}

/**
 * An observer of every engine round-trip. Purely a side-channel for telemetry
 * (the LLM-engine debug window); it never affects the call's result, and its
 * own throws are swallowed so instrumentation can't break a villager's turn.
 */
export interface LlmCallMonitor {
  onStart(call: LlmCallStart): void;
  /** A streamed slice of a `/decide` call (optional — only the decide path streams). */
  onDelta?(call: LlmCallDelta): void;
  onFinish(call: LlmCallFinish): void;
}

export interface HttpLLMClientOptions {
  /** Engine base URL. Defaults to `LLM_URL` or http://localhost:8090. */
  baseUrl?: string;
  /**
   * The vector dimensionality the engine's embedder emits. The memory store
   * pins its collection to this at init, so it must match the engine's model.
   * Defaults to `EMBED_DIM` or 768.
   */
  dimensions?: number;
  /** How long to wait for a reply before giving up, in ms. Defaults to `LLM_CLIENT_TIMEOUT_MS` or 120000. */
  timeoutMs?: number;
  /** Optional observer of every round-trip, for the debug window. */
  monitor?: LlmCallMonitor;
}

export class HttpLLMClient implements LLMProvider, Synthesizer, EmbeddingProvider {
  readonly name = 'llm-http';
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly monitor: LlmCallMonitor | undefined;
  /** Monotonic id stamped on each call so a start/finish pair can be matched. */
  private nextCallId = 1;
  /**
   * The current per-purpose REASONING EFFORT. A pure prompt lever: for each call we
   * append {@link reasoningEffortInstruction} for its purpose to the `system` prompt
   * before it is sent on to the engine, so the model is steered to deliberate more
   * or less while the answer it must emit is unchanged. Defaults to `medium` (a
   * no-op line) until the backend applies persisted/operator settings.
   */
  private readonly effort: ReasoningEffortSettings = { ...DEFAULT_REASONING_EFFORT };

  constructor(options: HttpLLMClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.LLM_URL ?? 'http://localhost:8090').replace(
      /\/$/,
      '',
    );
    this.dimensions = options.dimensions ?? Number(process.env.EMBED_DIM ?? 768);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LLM_CLIENT_TIMEOUT_MS ?? 120_000);
    this.monitor = options.monitor;
  }

  /** Set the reasoning effort for one call purpose (decide / supervisor / reflect / plan). */
  setEffort(purpose: EffortPurpose, level: ReasoningEffort): void {
    this.effort[purpose] = level;
  }

  /** A snapshot of the current per-purpose effort, for broadcasting to clients. */
  getEffort(): ReasoningEffortSettings {
    return { ...this.effort };
  }

  /**
   * The exact system prompt this client will send for `purpose`, i.e. `system`
   * with the current reasoning-effort directive appended. Mirrors what {@link decide}
   * / {@link synthesize} build internally, so telemetry can show the real prompt
   * (effort line included) instead of the bare one the caller composed.
   */
  effectiveSystem(system: string, purpose: EffortPurpose): string {
    return this.withEffort(system, purpose);
  }

  decide(request: LLMRequest): Promise<LLMDecision> {
    // Back-compat seam: fold the single system+user request into a two-message
    // transcript and run one agentic turn, then collapse the turn down to the old
    // single-decision shape (its first tool call). Callers that want the full loop
    // use `converse` directly.
    return this.converse({
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.userMessage },
      ],
      tools: request.tools,
      ...(request.agent ? { agent: request.agent } : {}),
      purpose: request.purpose,
      ...(request.route ? { route: request.route } : {}),
    }).then(turnToDecision);
  }

  /**
   * Run one ASSISTANT TURN of the agentic loop against the engine's streaming
   * `/decide` endpoint. The reasoning-effort directive is appended to the system
   * message; the SSE reply is consumed (deltas → the Live LLM feed) and the terminal
   * `done` frame yields the {@link LLMTurn}.
   */
  converse(request: LLMConverseRequest): Promise<LLMTurn> {
    const messages: LlmMessage[] = request.messages.map((m) =>
      m.role === 'system' ? { ...m, content: this.withEffort(m.content, request.purpose) } : m,
    );
    return this.streamTurn({
      messages,
      tools: request.tools,
      ...(request.agent ? { agent: request.agent } : {}),
      purpose: request.purpose,
      ...(request.route ? { route: request.route } : {}),
    });
  }

  /**
   * POST a transcript to the engine's streaming `/decide` endpoint and consume the
   * SSE reply: each `delta` frame is forwarded to the monitor (the Live LLM feed),
   * the terminal `done` frame yields the {@link LLMTurn}, and an `error` frame (or a
   * stream that ends without `done`) rejects. Start/finish telemetry mirrors the
   * buffered {@link post} path so existing windows keep working unchanged.
   */
  private async streamTurn(body: Record<string, unknown>): Promise<LLMTurn> {
    const id = this.nextCallId++;
    const endpoint: LlmEndpoint = '/decide';
    const startedAt = Date.now();
    this.notifyStart({ id, endpoint, request: body, startedAt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Guards against a double finish: once we've reported the outcome (success,
    // stream error, or a thrown transport error all flow through here), the catch
    // block must not report a second one.
    let settled = false;
    const finish = (call: Omit<LlmCallFinish, 'id' | 'endpoint' | 'startedAt' | 'durationMs'>): void => {
      settled = true;
      this.notifyFinish({ id, endpoint, startedAt, durationMs: Date.now() - startedAt, ...call });
    };
    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        const error = `llm engine ${endpoint} responded ${res.status} ${res.statusText} ${detail}`.trim();
        finish({ ok: false, status: res.status, error });
        throw new Error(error);
      }

      let turn: LLMTurn | undefined;
      let streamError: string | undefined;
      for await (const data of readSse(res.body)) {
        if (data === '[DONE]') break;
        let frame: { type?: string; content?: string; reasoning?: string; turn?: LLMTurn; decision?: LLMDecision; error?: string };
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }
        if (frame.type === 'delta') {
          this.notifyDelta({ id, ...(frame.content ? { content: frame.content } : {}), ...(frame.reasoning ? { reasoning: frame.reasoning } : {}) });
        } else if (frame.type === 'done') {
          // New transcript path returns a `turn`; the legacy path returns a `decision`
          // (single tool call) which we lift into the turn shape so callers are uniform.
          turn = frame.turn ?? decisionToTurn(frame.decision);
        } else if (frame.type === 'error') {
          streamError = frame.error ?? 'stream error';
        }
      }

      if (turn) {
        finish({ ok: true, status: res.status, response: turn });
        return turn;
      }
      const error = streamError ?? 'engine stream ended without a turn';
      finish({ ok: false, error });
      throw new Error(error);
    } catch (err) {
      if (!settled) finish({ ok: false, error: errMsg(err) });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async synthesize(request: SynthesisRequest): Promise<string> {
    const { text } = await this.post<{ text: string }>('/complete', {
      // `purpose` here is always 'reflect' or 'plan' (see SynthesisRequest).
      system: this.withEffort(request.system, request.purpose),
      user: request.user,
      // Telemetry-only; the engine reads system/user and ignores these.
      agent: request.agent,
      purpose: request.purpose,
      // Pool routing hint (endpoint/model), if the caller pinned one.
      ...(request.route ? { route: request.route } : {}),
      // Optional larger token budget for a big structured answer (world generation).
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    });
    return text;
  }

  /**
   * Append this purpose's reasoning-effort directive to the END of the system
   * prompt. Appending (rather than prepending) keeps the long, identical persona +
   * world-bible prefix stable for prompt caching. A `medium` level yields an empty
   * directive, so the prompt is returned untouched.
   */
  private withEffort(system: string, purpose: EffortPurpose): string {
    const directive = reasoningEffortInstruction(this.effort[purpose]);
    return directive ? `${system}\n\n${directive}` : system;
  }

  /**
   * The engine's current chat model + the models it can switch to. A control-plane
   * call (not a mind turn), so it skips the call monitor. On any transport/HTTP
   * failure it degrades to an empty config rather than throwing, so a boot-time
   * broadcast can't be blocked by an engine that isn't reachable yet.
   */
  async getModelConfig(): Promise<LlmModelConfig> {
    try {
      return await this.fetchJson<LlmModelConfig>('/models', { method: 'GET' });
    } catch (err) {
      console.warn(`[llm-http] model discovery failed: ${errMsg(err)}`);
      return { current: '', available: [] };
    }
  }

  /**
   * The engine's LLM POOL — its endpoints, their models, live busy flags, and the
   * parallel capacity (= number of endpoints). The backend scheduler sizes its
   * concurrency from `capacity`. Degrades to an empty single-endpoint pool on any
   * transport/HTTP failure, so a boot-time read can't be blocked by an engine that
   * isn't reachable yet.
   */
  async getPool(): Promise<LlmPoolConfig> {
    try {
      return await this.fetchJson<LlmPoolConfig>('/pool', { method: 'GET' });
    } catch (err) {
      console.warn(`[llm-http] pool discovery failed: ${errMsg(err)}`);
      return { endpoints: [], capacity: 1, defaultModel: '' };
    }
  }

  /** Switch the engine's global chat model; resolves to the re-discovered config. */
  setModel(model: string): Promise<LlmModelConfig> {
    return this.fetchJson<LlmModelConfig>('/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  }

  /** One control-plane round-trip to the engine, with the shared per-call timeout. */
  private async fetchJson<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`llm engine ${path} responded ${res.status} ${res.statusText} ${detail}`.trim());
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async embed(texts: string[], meta?: EmbedMeta): Promise<number[][]> {
    if (texts.length === 0) return [];
    // `agent` is telemetry-only; the engine's /embed reads `texts` and ignores it.
    const { vectors } = await this.post<{ vectors: number[][] }>('/embed', { texts, agent: meta?.agent });
    return vectors;
  }

  /** POST a JSON body to an engine endpoint and parse the JSON reply. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const id = this.nextCallId++;
    const endpoint = path as LlmEndpoint;
    const startedAt = Date.now();
    this.notifyStart({ id, endpoint, request: body, startedAt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Transport error or our own abort (the per-call timeout firing).
      this.notifyFinish({ id, endpoint, startedAt, durationMs: Date.now() - startedAt, ok: false, error: errMsg(err) });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const error = `llm engine ${path} responded ${res.status} ${res.statusText} ${detail}`.trim();
      this.notifyFinish({ id, endpoint, startedAt, durationMs: Date.now() - startedAt, ok: false, status: res.status, error });
      throw new Error(error);
    }
    const parsed = (await res.json()) as T;
    this.notifyFinish({ id, endpoint, startedAt, durationMs: Date.now() - startedAt, ok: true, status: res.status, response: parsed });
    return parsed;
  }

  /** Fire the monitor's start hook, never letting its throw escape. */
  private notifyStart(call: LlmCallStart): void {
    try {
      this.monitor?.onStart(call);
    } catch {
      /* telemetry must never break a turn */
    }
  }

  /** Fire the monitor's delta hook, never letting its throw escape. */
  private notifyDelta(call: LlmCallDelta): void {
    try {
      this.monitor?.onDelta?.(call);
    } catch {
      /* telemetry must never break a turn */
    }
  }

  /** Fire the monitor's finish hook, never letting its throw escape. */
  private notifyFinish(call: LlmCallFinish): void {
    try {
      this.monitor?.onFinish(call);
    } catch {
      /* telemetry must never break a turn */
    }
  }
}

/**
 * Iterate the `data:` payloads of an SSE response body, one per yielded string.
 * Frames are reassembled across network-chunk boundaries; comment/blank lines
 * are skipped. The caller stops on a `[DONE]` sentinel or end of stream.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** Collapse an agentic {@link LLMTurn} to the legacy single-decision shape (its first tool call). */
function turnToDecision(turn: LLMTurn): LLMDecision {
  const first = turn.toolCalls[0];
  return {
    call: first ? { name: first.name, input: first.input } : null,
    raw: turn.raw,
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
}

/** Lift a legacy single {@link LLMDecision} into the turn shape (zero or one tool call). */
function decisionToTurn(decision: LLMDecision | undefined): LLMTurn | undefined {
  if (!decision) return undefined;
  return {
    content: decision.raw,
    toolCalls: decision.call ? [{ name: decision.call.name, input: decision.call.input }] : [],
    raw: decision.raw,
    ...(decision.usage ? { usage: decision.usage } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
