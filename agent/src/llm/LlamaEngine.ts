/**
 * agent/src/llm/LlamaEngine.ts
 * ---------------------------------------------------------------------------
 * THE LLM engine. One process owns one of these; one of these owns the POOL of
 * model servers.
 *
 * The village has many minds and now MANY models behind them. Every kind of LLM
 * work converges here and is dispatched through an {@link EndpointPool}:
 *
 *   - `decide`     — a villager's / the God Agent's tool decision  (LlamaProvider)
 *   - `synthesize` — the reflection writer's free-text prose       (LlamaSynthesizer)
 *   - `embed`      — memory's batch embeddings                     (LlamaEmbeddingProvider)
 *
 * The pool keeps ONE serial queue PER endpoint, so a single server never sees two
 * requests at once, while different endpoints run in parallel — N minds think at
 * once across N servers. A call may carry a `route` hint (endpoint id + model) so
 * a mind is pinned to a chosen server/model; with no hint the pool spreads load to
 * a free endpoint and runs the default model. Because it implements `LLMProvider`,
 * `Synthesizer`, and `EmbeddingProvider`, an in-process caller can use it directly;
 * the `llm` service wraps it in an HTTP server so the backend reaches it remotely.
 * ---------------------------------------------------------------------------
 */

import type { LLMDecision, LLMProvider, LLMRequest, LLMTurn } from './LLMProvider';
import type { LlmMessage, LlmModelConfig, LlmPoolConfig, LlmRouteHint } from '../../../shared/types';
import type { ToolDefinition } from '../tools';
import { EndpointPool, type EndpointPoolOptions } from './EndpointPool';
import type { StreamSink } from './LlamaProvider';
import type { EmbeddingProvider, EmbedMeta } from '../memory/EmbeddingProvider';
import type { Synthesizer, SynthesisRequest } from '../memory/Synthesizer';

export interface LlamaEngineOptions {
  /** Minimum gap between successive calls on ONE endpoint, in ms. Defaults to `LLM_ENGINE_MIN_GAP_MS` or 0. */
  minGapMs?: number;
  /** Overrides forwarded to the endpoint pool (urls / default model). */
  pool?: EndpointPoolOptions;
}

export class LlamaEngine implements LLMProvider, Synthesizer, EmbeddingProvider {
  readonly name = 'llama-engine';
  readonly dimensions: number;

  /** The parallel pool of model servers every call is dispatched across. */
  private readonly pool: EndpointPool;

  constructor(options: LlamaEngineOptions = {}) {
    this.pool = new EndpointPool({
      ...options.pool,
      ...(options.minGapMs !== undefined ? { minGapMs: options.minGapMs } : {}),
    });
    this.dimensions = this.pool.dimensions;
  }

  decide(request: LLMRequest): Promise<LLMDecision> {
    return this.pool.decide(request);
  }

  /** Stream a tool decision: `onChunk` fires per output slice; resolves to the assembled decision. */
  decideStream(request: LLMRequest, onChunk: StreamSink): Promise<LLMDecision> {
    return this.pool.decideStream(request, onChunk);
  }

  /** Stream one agentic turn over a transcript (native tool-calling); resolves to the assembled turn. */
  converseStream(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    route: LlmRouteHint | undefined,
    onChunk: StreamSink,
  ): Promise<LLMTurn> {
    return this.pool.converseStream(messages, tools, route, onChunk);
  }

  synthesize(request: SynthesisRequest): Promise<string> {
    return this.pool.synthesize(request);
  }

  embed(texts: string[], meta?: EmbedMeta): Promise<number[][]> {
    return this.pool.embed(texts, meta);
  }

  /**
   * The default chat model plus the union of models every endpoint reports it can
   * serve. Discovery is a cheap metadata GET per endpoint (outside the per-endpoint
   * queues), so it never blocks a villager's turn; a failure leaves that endpoint's
   * list empty rather than throwing.
   */
  getModelConfig(): Promise<LlmModelConfig> {
    return this.pool.getModelConfig();
  }

  /**
   * Switch the DEFAULT chat model — applied to every endpoint's decider and
   * reflection writer so all unrouted mind work moves together; embeddings are
   * untouched (their model is pinned to the vector store's dimensions). Returns the
   * new config so the caller can broadcast it.
   */
  setModel(model: string): Promise<LlmModelConfig> {
    return this.pool.setModel(model);
  }

  /** The pool's shape (endpoints + live busy flags + parallel capacity), for the backend + UI. */
  getPoolConfig(): LlmPoolConfig {
    return this.pool.getPoolConfig();
  }
}
