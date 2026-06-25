/**
 * agent/src/llm/EndpointPool.ts
 * ---------------------------------------------------------------------------
 * The village's BRAIN POOL — many OpenAI-compatible servers, run in parallel.
 *
 * The old engine funnelled every mind through ONE serial queue against ONE
 * server, so only one villager could think at a time. This replaces that with a
 * pool of ENDPOINTS:
 *
 *   - each endpoint is one server (llama.cpp / vLLM / Ollama / LM Studio …) and
 *     keeps its OWN {@link SerialQueue}, so a single box is never dog-piled;
 *   - but DIFFERENT endpoints run concurrently, so the pool's parallelism equals
 *     the number of endpoints — N minds can think at once.
 *
 * A call may carry a {@link LlmRouteHint} (endpoint id + model) so a villager can
 * be pinned to a specific server/model; with no hint the pool picks the
 * least-loaded endpoint and runs its default model. Each endpoint owns its own
 * provider/synth/embedder bound to a single URL, and the per-call model is set on
 * that endpoint inside its queue (so concurrent endpoints never race on a shared
 * model field). Discovery (`/v1/models`) is cached per endpoint and refreshed off
 * the hot path.
 * ---------------------------------------------------------------------------
 */

import type { LLMDecision, LLMRequest, LLMTurn } from './LLMProvider';
import type { LlmMessage, LlmModelConfig, LlmPoolConfig, LlmRouteHint } from '../../../shared/types';
import type { ToolDefinition } from '../tools';
import { LlamaProvider, type StreamSink } from './LlamaProvider';
import { SerialQueue } from './SerialQueue';
import { LlamaEmbeddingProvider } from '../memory/LlamaEmbeddingProvider';
import { LlamaSynthesizer } from '../memory/LlamaSynthesizer';
import type { EmbedMeta } from '../memory/EmbeddingProvider';
import type { SynthesisRequest } from '../memory/Synthesizer';

/** One server in the pool: its clients, its serial queue, and live load. */
interface PoolEndpoint {
  /** Stable id = base URL. */
  id: string;
  baseUrl: string;
  provider: LlamaProvider;
  synth: LlamaSynthesizer;
  /** One in-flight call at a time on this server. */
  queue: SerialQueue;
  /** Model ids discovered via `/v1/models`; cached, refreshed off the hot path. */
  models: string[];
  /** Queued + running calls, so {@link pick} can spread load to a free endpoint. */
  inFlight: number;
}

export interface EndpointPoolOptions {
  /**
   * Base URLs of the pool's servers. Defaults to `LLM_ENDPOINTS`, then the legacy
   * single-engine knobs (`LLAMA_URLS`) so an existing one-server deploy keeps
   * working unchanged (it simply has a pool of size one = no concurrency).
   */
  urls?: string[];
  /** Default chat model when a call carries no `route.model`. Defaults to `LLAMA_MODEL`. */
  model?: string;
  /** Minimum gap between successive calls on ONE endpoint, in ms. Defaults to `LLM_ENGINE_MIN_GAP_MS`. */
  minGapMs?: number;
}

export class EndpointPool {
  /** The embedding dimensionality (uniform across endpoints; pins the vector store). */
  readonly dimensions: number;

  private readonly endpoints: PoolEndpoint[];
  /**
   * The embedder is NOT part of the chat pool: the embedding model is a separate
   * model (and often a separate server), so embeddings keep their own client
   * (`EMBED_URLS`, falling back to the chat endpoints) and their own serial queue,
   * which can run concurrently with the chat endpoints. This avoids routing an embed
   * to a chat endpoint that doesn't serve the embedding model.
   */
  private readonly embedder: LlamaEmbeddingProvider;
  private readonly embedQueue: SerialQueue;
  /** Default chat model for unrouted calls. Mutable: an operator can switch it live. */
  private defaultModel: string;
  /** Round-robin tiebreaker when several endpoints are equally idle. */
  private cursor = 0;

  constructor(options: EndpointPoolOptions = {}) {
    const urls = (options.urls ?? parseUrls(process.env.LLM_ENDPOINTS) ?? parseUrls(process.env.LLAMA_URLS)) ?? [];
    const baseUrls = urls && urls.length > 0 ? urls : ['http://localhost:8080'];
    this.defaultModel = options.model ?? process.env.LLAMA_MODEL ?? 'llama';
    const minGapMs = options.minGapMs ?? Number(process.env.LLM_ENGINE_MIN_GAP_MS ?? 0);

    this.endpoints = baseUrls.map((baseUrl) => ({
      id: baseUrl,
      baseUrl,
      provider: new LlamaProvider({ urls: [baseUrl], model: this.defaultModel }),
      synth: new LlamaSynthesizer({ urls: [baseUrl], model: this.defaultModel }),
      queue: new SerialQueue(minGapMs),
      models: [],
      inFlight: 0,
    }));
    // The embedder reads EMBED_URLS itself (falling back to LLAMA_URLS); leaving its
    // urls unset preserves the previous embedding behaviour exactly.
    this.embedder = new LlamaEmbeddingProvider();
    this.embedQueue = new SerialQueue(minGapMs);
    this.dimensions = this.embedder.dimensions;

    console.log(
      `[pool] ${this.endpoints.length} endpoint(s) — parallel capacity ${this.endpoints.length}: ` +
        baseUrls.join(', '),
    );
    // Discover each endpoint's models in the background; never blocks construction.
    void this.refreshModels();
  }

  /** How many minds can think at once = number of endpoints. */
  get capacity(): number {
    return this.endpoints.length;
  }

  // -------------------------------------------------------------------------
  // The three kinds of mind work, each routed onto a (free) endpoint's queue.
  // -------------------------------------------------------------------------

  /** A tool decision (a villager's / the God Agent's turn). Honors `request.route`. */
  decide(request: LLMRequest): Promise<LLMDecision> {
    return this.runRouted(request.route, (ep, model) =>
      ep.queue.run(() => {
        ep.provider.setModel(model);
        return ep.provider.decide(request);
      }),
    );
  }

  /** A STREAMING tool decision: `onChunk` fires per slice as the model emits it. Honors `request.route`. */
  decideStream(request: LLMRequest, onChunk: StreamSink): Promise<LLMDecision> {
    return this.runRouted(request.route, (ep, model) =>
      ep.queue.run(() => {
        ep.provider.setModel(model);
        return ep.provider.decideStream(request, onChunk);
      }),
    );
  }

  /** One STREAMING agentic turn over a transcript (native tool-calling). Honors `route`. */
  converseStream(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    route: LlmRouteHint | undefined,
    onChunk: StreamSink,
  ): Promise<LLMTurn> {
    return this.runRouted(route, (ep, model) =>
      ep.queue.run(() => {
        ep.provider.setModel(model);
        return ep.provider.converseStream(messages, tools, onChunk);
      }),
    );
  }

  /** A free-text completion (reflection / planning). Honors `request.route`. */
  synthesize(request: SynthesisRequest): Promise<string> {
    return this.runRouted(request.route, (ep, model) =>
      ep.queue.run(() => {
        ep.synth.setModel(model);
        return ep.synth.synthesize(request);
      }),
    );
  }

  /** A batch of embeddings, on the dedicated embedder + queue (off the chat endpoints). */
  embed(texts: string[], meta?: EmbedMeta): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    return this.embedQueue.run(() => this.embedder.embed(texts, meta));
  }

  /**
   * Run `task` on the endpoint named by `hint` (if any), else the least-loaded one,
   * counting it as in-flight while it runs. On a transport failure with no pinned
   * endpoint, fail over to the next endpoint so one dead box doesn't drop the turn.
   */
  private async runRouted<T>(
    hint: LlmRouteHint | undefined,
    task: (ep: PoolEndpoint, model: string) => Promise<T>,
  ): Promise<T> {
    const pinned = hint?.endpoint ? this.endpoints.find((e) => e.id === hint.endpoint) : undefined;
    const order = pinned ? [pinned] : this.byLoad();
    const model = hint?.model ?? this.defaultModel;

    const errors: string[] = [];
    for (const ep of order) {
      ep.inFlight++;
      try {
        return await task(ep, model);
      } catch (err) {
        errors.push(`${ep.id}: ${errMsg(err)}`);
        // A pinned call can't fail over (the caller asked for THIS endpoint).
        if (pinned) throw err;
      } finally {
        ep.inFlight--;
      }
    }
    throw new Error(`all ${order.length} endpoint(s) failed: ${errors.join('; ')}`);
  }

  /** Endpoints ordered least-loaded first; round-robin cursor breaks ties fairly. */
  private byLoad(): PoolEndpoint[] {
    const n = this.endpoints.length;
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % n;
    return [...this.endpoints]
      .map((ep, i) => ({ ep, rank: (i - start + n) % n }))
      .sort((a, b) => a.ep.inFlight - b.ep.inFlight || a.rank - b.rank)
      .map((x) => x.ep);
  }

  // -------------------------------------------------------------------------
  // Control plane: model discovery + switching.
  // -------------------------------------------------------------------------

  /** Re-discover every endpoint's served models (best-effort; failures leave a list empty). */
  async refreshModels(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (ep) => {
        try {
          ep.models = await ep.provider.listModels();
        } catch (err) {
          console.warn(`[pool] model discovery failed on ${ep.id}: ${errMsg(err)}`);
        }
      }),
    );
  }

  /** The default model + the UNION of every endpoint's served models (for the selector). */
  async getModelConfig(): Promise<LlmModelConfig> {
    await this.refreshModels();
    const available = [...new Set(this.endpoints.flatMap((e) => e.models))].sort();
    return { current: this.defaultModel, available };
  }

  /** Switch the DEFAULT chat model (unrouted calls + each endpoint's provider/synth). */
  async setModel(model: string): Promise<LlmModelConfig> {
    this.defaultModel = model;
    for (const ep of this.endpoints) {
      ep.provider.setModel(model);
      ep.synth.setModel(model);
    }
    return this.getModelConfig();
  }

  /** The pool's shape + live busy flags, for the backend scheduler and the UI. */
  getPoolConfig(): LlmPoolConfig {
    return {
      capacity: this.capacity,
      defaultModel: this.defaultModel,
      endpoints: this.endpoints.map((e) => ({
        id: e.id,
        baseUrl: e.baseUrl,
        models: e.models,
        busy: e.inFlight > 0,
      })),
    };
  }
}

/** Split a comma-separated URL list, trimming blanks + trailing slashes. */
function parseUrls(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
