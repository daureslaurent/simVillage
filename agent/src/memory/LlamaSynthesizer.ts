/**
 * agent/src/memory/LlamaSynthesizer.ts
 * ---------------------------------------------------------------------------
 * Phase 4 — "The Memory Stream". The llama-server implementation of
 * `Synthesizer`.
 *
 * Same OpenAI-compatible chat fleet as `LlamaProvider` (`LLAMA_URLS`, round-
 * robin failover), but used in plain-completion mode: no `response_format`,
 * no tool contract — just a system + user message returning prose. This is the
 * reflection writer; its output is narrated text, not an action, so it never
 * touches the bus and needs no strict parsing.
 * ---------------------------------------------------------------------------
 */

import type { Synthesizer, SynthesisRequest } from './Synthesizer';

export interface LlamaSynthesizerOptions {
  urls?: string[];
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Sampling temperature. Reflection wants a little creativity. Default 0.7. */
  temperature?: number;
  /**
   * Cap on synthesized length. Defaults to `LLAMA_SYNTH_MAX_TOKENS`, else the global
   * `LLM_MAX_TOKENS`, else 1024 — generous on purpose: a REASONING model (e.g.
   * Nemotron Nano, DeepSeek-R1) spends tokens thinking before it writes, and a tight
   * cap leaves it no room to produce visible content after the thinking, so the
   * completion comes back empty. The headroom costs nothing for non-reasoning models
   * (they stop at the stop token).
   */
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      /**
       * Some reasoning models (and llama.cpp with a reasoning parser) split the
       * chain-of-thought into this field and leave `content` empty when the cap is
       * hit mid-think. We fall back to it so a thinking model still yields prose.
       */
      reasoning_content?: string | null;
    };
  }>;
}

export class LlamaSynthesizer implements Synthesizer {
  readonly name = 'llama-synth';

  private readonly urls: string[];
  /** Chat model tag. Mutable so the engine can keep it in step with the decider's model. */
  private model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private cursor = 0;

  constructor(options: LlamaSynthesizerOptions = {}) {
    const urls = options.urls ?? parseUrls(process.env.LLAMA_URLS);
    this.urls = urls.length > 0 ? urls : ['http://localhost:8080'];
    this.model = options.model ?? process.env.LLAMA_MODEL ?? 'llama';
    this.apiKey = options.apiKey ?? process.env.LLAMA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LLAMA_TIMEOUT_MS ?? 30_000);
    this.temperature = options.temperature ?? 0.7;
    // Priority: explicit option > synth-specific LLAMA_SYNTH_MAX_TOKENS > global
    // LLM_MAX_TOKENS > 1024. (A per-request `maxTokens` still overrides all of these
    // at call time — see callServer.)
    this.maxTokens =
      options.maxTokens ??
      Number(process.env.LLAMA_SYNTH_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS ?? 1024);
  }

  /** The model tag reflection/planning prose currently runs against. */
  getModel(): string {
    return this.model;
  }

  /** Switch the chat model used from the next completion onward. */
  setModel(model: string): void {
    this.model = model;
  }

  async synthesize(request: SynthesisRequest): Promise<string> {
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.urls.length;

    const errors: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(start + i) % this.urls.length]!;
      try {
        return await this.callServer(url, request);
      } catch (err) {
        errors.push(`${url}: ${errMsg(err)}`);
        console.warn(`[synth] server failed, failing over: ${url}: ${errMsg(err)}`);
      }
    }
    throw new Error(`all ${this.urls.length} llama server(s) failed: ${errors.join('; ')}`);
  }

  private async callServer(baseUrl: string, request: SynthesisRequest): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          temperature: this.temperature,
          // A caller may raise the cap for a big structured answer on a thinking
          // model (see SynthesisRequest.maxTokens); otherwise use the default.
          max_tokens: request.maxTokens ?? this.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`responded ${res.status} ${res.statusText}`);

    const body = (await res.json()) as ChatCompletionResponse;
    const message = body.choices?.[0]?.message;
    // Prefer the visible answer; fall back to the reasoning channel when a thinking
    // model returned its prose only there (or ran the cap out mid-think). Either
    // way, strip any <think>…</think> wrapper so callers get clean prose to parse.
    const raw = message?.content?.trim() || message?.reasoning_content?.trim() || '';
    const content = stripThinking(raw);
    if (!content) throw new Error('empty completion');
    return content;
  }
}

/**
 * Remove a reasoning model's chain-of-thought wrapper from a completion. Drops a
 * closed `<think>…</think>` block, and — when the model ran out of tokens before
 * closing it — keeps whatever follows a lone `</think>`, or the post-think tail.
 * Leaves ordinary completions untouched.
 */
function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Unclosed / partial think blocks: take the tail after the last </think>, or
  // drop a dangling "<think> …" with no close.
  if (/<\/think>/i.test(out)) out = out.split(/<\/think>/i).pop()!.trim();
  else out = out.replace(/<think>[\s\S]*$/i, '').trim();
  return out;
}

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
