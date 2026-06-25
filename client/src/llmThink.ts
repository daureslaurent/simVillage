/**
 * client/src/llmThink.ts
 * ---------------------------------------------------------------------------
 * Small shared helpers for pulling a model's REASONING ("think") out of a
 * streamed completion, used by both the LLM-engine debug window and the Live
 * LLM window so the two agree on what counts as thinking.
 *
 * Reasoning reaches the browser two ways: inline `<think>…</think>` tags in the
 * visible content, and (for models that break it out) a separate `reasoning`
 * channel. {@link splitThink} + {@link joinThink} combine both into one block,
 * and {@link estimateThinkTokens} approximates a token count from it for the
 * common case where a local server (llama.cpp) never reports `reasoning_tokens`.
 * ---------------------------------------------------------------------------
 */

/**
 * Split text into reasoning vs. answer by `<think>…</think>` tags. A trailing
 * unclosed `<think>` (the model is still reasoning) puts the rest in `think`, so
 * it works mid-stream. Everything outside the tags is the visible `output`.
 */
export function splitThink(raw: string): { think: string; output: string } {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let think = '';
  let output = '';
  let i = 0;
  while (i < raw.length) {
    const o = raw.indexOf(OPEN, i);
    if (o < 0) {
      output += raw.slice(i);
      break;
    }
    output += raw.slice(i, o);
    const c = raw.indexOf(CLOSE, o + OPEN.length);
    if (c < 0) {
      think += raw.slice(o + OPEN.length);
      break;
    }
    think += raw.slice(o + OPEN.length, c);
    i = c + CLOSE.length;
  }
  return { think: think.trim(), output: output.trim() };
}

/** Combine the separate reasoning channel with any tag-extracted think text. */
export function joinThink(reasoning: string, tagThink: string): string {
  return [reasoning.trim(), tagThink.trim()].filter(Boolean).join('\n').trim();
}

/** Rough token estimate from text length (~4 chars/token) when none was reported. */
export function estimateThinkTokens(text: string): number {
  return Math.round(text.trim().length / 4);
}
