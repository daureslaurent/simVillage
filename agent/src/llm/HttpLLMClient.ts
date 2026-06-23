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

import type { LLMDecision, LLMProvider, LLMRequest } from './LLMProvider';
import type { EmbeddingProvider, EmbedMeta } from '../memory/EmbeddingProvider';
import type { Synthesizer, SynthesisRequest } from '../memory/Synthesizer';

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

  constructor(options: HttpLLMClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.LLM_URL ?? 'http://localhost:8090').replace(
      /\/$/,
      '',
    );
    this.dimensions = options.dimensions ?? Number(process.env.EMBED_DIM ?? 768);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LLM_CLIENT_TIMEOUT_MS ?? 120_000);
    this.monitor = options.monitor;
  }

  decide(request: LLMRequest): Promise<LLMDecision> {
    return this.post<LLMDecision>('/decide', request);
  }

  async synthesize(request: SynthesisRequest): Promise<string> {
    const { text } = await this.post<{ text: string }>('/complete', {
      system: request.system,
      user: request.user,
      // Telemetry-only; the engine reads system/user and ignores these.
      agent: request.agent,
      purpose: request.purpose,
    });
    return text;
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

  /** Fire the monitor's finish hook, never letting its throw escape. */
  private notifyFinish(call: LlmCallFinish): void {
    try {
      this.monitor?.onFinish(call);
    } catch {
      /* telemetry must never break a turn */
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
