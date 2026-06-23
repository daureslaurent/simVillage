/**
 * agent/src/memory/LlamaEmbeddingProvider.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The llama-server implementation of
 * `EmbeddingProvider`.
 *
 * Talks to one or more OpenAI-compatible embedding servers (llama.cpp
 * `server --embedding`, vLLM, LM Studio, TGI, ...) at `POST {base}/v1/embeddings`,
 * the embedding counterpart to the chat endpoint `LlamaProvider` uses. It reuses
 * the exact same operational shape as that provider — a ROUND-ROBIN POOL WITH
 * FAILOVER so embedding load spreads across GPUs and survives a box going down —
 * so the two can point at the same `LLAMA_URLS` fleet or a dedicated embedding
 * fleet via `EMBED_URLS`.
 *
 * The response is parsed defensively: a transport/non-2xx error fails over to
 * the next server, while a successful-but-malformed body rejects (an embedding
 * is not optional the way a skipped decision turn is — a memory either gets a
 * vector or it is not stored).
 * ---------------------------------------------------------------------------
 */

import type { EmbeddingProvider, EmbedMeta } from './EmbeddingProvider';

export interface LlamaEmbeddingProviderOptions {
  /** Pool of server base URLs. Defaults to `EMBED_URLS`, then `LLAMA_URLS`. */
  urls?: string[];
  /** Embedding model tag passed to the server. Defaults to `EMBED_MODEL`. */
  model?: string;
  /** Vector dimensionality the chosen model emits. Defaults to `EMBED_DIM` or 768. */
  dimensions?: number;
  /** Optional bearer token. Defaults to `EMBED_API_KEY`, then `LLAMA_API_KEY`. */
  apiKey?: string;
  /** Per-request timeout in ms before failing over. Defaults to `EMBED_TIMEOUT_MS` or 30000. */
  timeoutMs?: number;
}

/** Minimal shape of the OpenAI-compatible embeddings response we read. */
interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

export class LlamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'llama-embed';
  readonly dimensions: number;

  private readonly urls: string[];
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  /** Round-robin cursor; advances one server per batch. */
  private cursor = 0;

  constructor(options: LlamaEmbeddingProviderOptions = {}) {
    const urls = options.urls ?? parseUrls(process.env.EMBED_URLS || process.env.LLAMA_URLS);
    this.urls = urls.length > 0 ? urls : ['http://localhost:8080'];
    this.model = options.model ?? process.env.EMBED_MODEL ?? 'nomic-embed-text';
    this.dimensions = options.dimensions ?? Number(process.env.EMBED_DIM ?? 768);
    this.apiKey = options.apiKey ?? process.env.EMBED_API_KEY ?? process.env.LLAMA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.EMBED_TIMEOUT_MS ?? 30_000);
  }

  // `meta` (the calling agent) is accepted for interface parity but unused here:
  // this provider talks straight to the embedding server, which has no such field.
  async embed(texts: string[], _meta?: EmbedMeta): Promise<number[][]> {
    void _meta;
    if (texts.length === 0) return [];

    // Start at the next server in rotation, then fall through the rest on error.
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.urls.length;

    const errors: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(start + i) % this.urls.length]!;
      try {
        return await this.callServer(url, texts);
      } catch (err) {
        errors.push(`${url}: ${errMsg(err)}`);
        console.warn(`[embed] server failed, failing over: ${url}: ${errMsg(err)}`);
      }
    }
    throw new Error(`all ${this.urls.length} embedding server(s) failed: ${errors.join('; ')}`);
  }

  /** One attempt against a single server. Throws on transport/parse error. */
  private async callServer(baseUrl: string, texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`responded ${res.status} ${res.statusText}`);

    const body = (await res.json()) as EmbeddingResponse;
    const data = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`expected ${texts.length} embeddings, got ${data?.length ?? 0}`);
    }

    // Sort by `index` so we return vectors in the same order as the inputs,
    // regardless of how the server ordered its response array.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d, i) => {
      const v = d.embedding;
      if (!Array.isArray(v) || v.length === 0) {
        throw new Error(`embedding ${i} was missing or empty`);
      }
      return v;
    });
  }
}

/** Split a comma-separated URL list, trimming blanks and trailing slashes. */
function parseUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
