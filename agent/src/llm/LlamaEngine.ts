/**
 * agent/src/llm/LlamaEngine.ts
 * ---------------------------------------------------------------------------
 * THE single LLM engine. One process owns one of these; one of these owns the
 * one llama server.
 *
 * The village has many minds but only one model behind them, so every kind of
 * LLM work converges here and is serialized through a single `SerialQueue`:
 *
 *   - `decide`     — a villager's / the God Agent's tool decision  (LlamaProvider)
 *   - `synthesize` — the reflection writer's free-text prose       (LlamaSynthesizer)
 *   - `embed`      — memory's batch embeddings                     (LlamaEmbeddingProvider)
 *
 * It does not reimplement the HTTP plumbing: it composes the three existing
 * llama clients (each keeps its own endpoint/round-robin/failover behaviour) and
 * funnels all three through ONE queue so the single server never sees two
 * requests at once. Because it implements `LLMProvider`, `Synthesizer`, and
 * `EmbeddingProvider`, an in-process caller can use it directly; the `llm`
 * service wraps it in an HTTP server so the backend reaches it over the network.
 * ---------------------------------------------------------------------------
 */

import type { LLMDecision, LLMProvider, LLMRequest } from './LLMProvider';
import { LlamaProvider, type LlamaProviderOptions } from './LlamaProvider';
import { SerialQueue } from './SerialQueue';
import type { EmbeddingProvider, EmbedMeta } from '../memory/EmbeddingProvider';
import {
  LlamaEmbeddingProvider,
  type LlamaEmbeddingProviderOptions,
} from '../memory/LlamaEmbeddingProvider';
import type { Synthesizer, SynthesisRequest } from '../memory/Synthesizer';
import { LlamaSynthesizer, type LlamaSynthesizerOptions } from '../memory/LlamaSynthesizer';

export interface LlamaEngineOptions {
  /** Minimum gap between successive llama calls, in ms. Defaults to `LLM_ENGINE_MIN_GAP_MS` or 0. */
  minGapMs?: number;
  /** Overrides forwarded to the underlying chat-decision client. */
  provider?: LlamaProviderOptions;
  /** Overrides forwarded to the underlying reflection client. */
  synthesizer?: LlamaSynthesizerOptions;
  /** Overrides forwarded to the underlying embedding client. */
  embeddings?: LlamaEmbeddingProviderOptions;
}

export class LlamaEngine implements LLMProvider, Synthesizer, EmbeddingProvider {
  readonly name = 'llama-engine';
  readonly dimensions: number;

  private readonly provider: LlamaProvider;
  private readonly synth: LlamaSynthesizer;
  private readonly embedder: LlamaEmbeddingProvider;
  /** The one queue every call passes through — the heart of the serialization. */
  private readonly queue: SerialQueue;

  constructor(options: LlamaEngineOptions = {}) {
    this.provider = new LlamaProvider(options.provider);
    this.synth = new LlamaSynthesizer(options.synthesizer);
    this.embedder = new LlamaEmbeddingProvider(options.embeddings);
    this.dimensions = this.embedder.dimensions;

    const minGapMs = options.minGapMs ?? Number(process.env.LLM_ENGINE_MIN_GAP_MS ?? 0);
    this.queue = new SerialQueue(minGapMs);
  }

  decide(request: LLMRequest): Promise<LLMDecision> {
    return this.queue.run(() => this.provider.decide(request));
  }

  synthesize(request: SynthesisRequest): Promise<string> {
    return this.queue.run(() => this.synth.synthesize(request));
  }

  embed(texts: string[], meta?: EmbedMeta): Promise<number[][]> {
    return this.queue.run(() => this.embedder.embed(texts, meta));
  }
}
