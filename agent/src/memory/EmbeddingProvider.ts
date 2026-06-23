/**
 * agent/src/memory/EmbeddingProvider.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The pluggable embedding seam.
 *
 * Memory is RAG: to store or recall a memory we first turn its narrative text
 * into a vector. The mind must not care WHICH model produces that vector — a
 * local llama-server embedding model, a hosted endpoint, or a deterministic
 * stub in a test. This is that seam, mirroring `LLMProvider`: a single `embed`
 * verb taking a batch of strings and returning one vector per string.
 *
 * Batching is first-class because both ingestion (one event) and reflection
 * (many recent memories at once) flow through here, and embedding servers are
 * far more efficient per call when fed a batch. `embedOne` is a convenience
 * wrapper for the common single-string case.
 * ---------------------------------------------------------------------------
 */

/** Side-channel metadata about who/what an embedding is for. Telemetry only —
 *  never affects the vectors. Ignored by providers that don't surface it. */
export interface EmbedMeta {
  /** A human label for the caller (e.g. a villager id), shown in the debug window. */
  agent?: string;
}

/** A swappable text-embedding model. Inject whichever the deployment wants. */
export interface EmbeddingProvider {
  /** Human-readable name for logs (e.g. "llama-embed"). */
  readonly name: string;
  /** The fixed dimensionality of the vectors this provider emits. */
  readonly dimensions: number;
  /**
   * Embed a batch of texts, returning one vector per input in the same order.
   * Implementations should let transport errors reject so the caller can decide
   * whether to retry or skip. `meta` is optional telemetry about the caller.
   */
  embed(texts: string[], meta?: EmbedMeta): Promise<number[][]>;
}

/** Convenience: embed a single string and return its lone vector. */
export async function embedOne(
  provider: EmbeddingProvider,
  text: string,
  meta?: EmbedMeta,
): Promise<number[]> {
  const [vector] = await provider.embed([text], meta);
  if (!vector) throw new Error(`${provider.name} returned no embedding for input`);
  return vector;
}
