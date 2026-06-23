/**
 * agent/src/llm/LlamaProvider.ts
 * ---------------------------------------------------------------------------
 * Phase 3 — "The Brains". The llama-server implementation of `LLMProvider`.
 *
 * Talks to one or more OpenAI-compatible chat-completions servers (llama.cpp
 * `server`, vLLM, LM Studio, TGI, ...) at `POST {base}/v1/chat/completions`.
 *
 * Multiple servers are used as a ROUND-ROBIN POOL WITH FAILOVER: each decision
 * starts at the next server in rotation and, if that server errors or times
 * out, falls through the rest of the pool before giving up. This both spreads
 * load across GPUs and survives a single box going down.
 *
 * A local model has no strict-tool guarantee, so we constrain the output two
 * ways and then validate:
 *   1. `response_format: { type: 'json_object' }` asks for a single JSON object.
 *   2. An explicit contract describing the tools and the exact
 *      `{ "tool": "...", "args": { ... } }` shape we expect.
 * If a server happens to support native OpenAI function-calling and returns
 * `tool_calls`, we use that directly. Either way the body is parsed defensively:
 * a transport error fails over to the next server, while a successful-but-
 * unparseable response is logged and turns into a null decision (skip the turn)
 * — unvalidated output never reaches the bus. The shared `parseDecision()`
 * upstream does the final per-tool schema validation.
 * ---------------------------------------------------------------------------
 */

import type { LLMDecision, LLMProvider, LLMRequest } from './LLMProvider';
import type { ToolDefinition } from '../tools';

export interface LlamaProviderOptions {
  /** Pool of server base URLs. Defaults to `LLAMA_URLS` (comma-separated). */
  urls?: string[];
  /** Model tag passed to the server. Defaults to `LLAMA_MODEL`. */
  model?: string;
  /** Optional bearer token, for servers that require auth. Defaults to `LLAMA_API_KEY`. */
  apiKey?: string;
  /** Per-request timeout in ms before failing over. Defaults to `LLAMA_TIMEOUT_MS` or 30000. */
  timeoutMs?: number;
  /**
   * When true, log every round-trip: the prompt sent to each server and the
   * raw content/tool_calls it returned, plus latency. Off by default (it is
   * verbose and prints the full perception each turn). Defaults to `LLAMA_DEBUG`
   * being a truthy value (`1`, `true`, `yes`).
   */
  debug?: boolean;
}

/** Minimal shape of the OpenAI-compatible chat-completions response we read. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/** Shape we ask the model to emit in JSON mode (then validate). */
interface JsonToolReply {
  tool?: unknown;
  args?: unknown;
}

export class LlamaProvider implements LLMProvider {
  readonly name = 'llama';

  private readonly urls: string[];
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  /** Round-robin cursor; advances one server per decision. */
  private cursor = 0;

  constructor(options: LlamaProviderOptions = {}) {
    const urls = options.urls ?? parseUrls(process.env.LLAMA_URLS);
    this.urls = urls.length > 0 ? urls : ['http://localhost:8080'];
    this.model = options.model ?? process.env.LLAMA_MODEL ?? 'llama';
    this.apiKey = options.apiKey ?? process.env.LLAMA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LLAMA_TIMEOUT_MS ?? 30_000);
    this.debug = options.debug ?? isTruthy(process.env.LLAMA_DEBUG);
  }

  async decide(request: LLMRequest): Promise<LLMDecision> {
    // Start at the next server in rotation, then fall through the rest on error.
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.urls.length;

    const errors: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(start + i) % this.urls.length]!;
      try {
        return await this.callServer(url, request);
      } catch (err) {
        // Transport/timeout error on this server — try the next one.
        errors.push(`${url}: ${errMsg(err)}`);
        console.warn(`[llama] server failed, failing over: ${url}: ${errMsg(err)}`);
      }
    }
    throw new Error(`all ${this.urls.length} llama server(s) failed: ${errors.join('; ')}`);
  }

  /** One attempt against a single server. Throws on transport/timeout error. */
  private async callServer(baseUrl: string, request: LLMRequest): Promise<LLMDecision> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const messages = [
      { role: 'system', content: `${request.system}\n\n${toolContract(request.tools)}` },
      { role: 'user', content: request.userMessage },
    ];
    if (this.debug) {
      console.log(
        `[llama] -> ${baseUrl} (model=${this.model})\n` +
          `[llama]    system: ${messages[0]!.content}\n` +
          `[llama]    user:   ${messages[1]!.content}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages,
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Non-2xx: a server-side problem — let decide() fail over to the next box.
      throw new Error(`responded ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as ChatCompletionResponse;
    const message = body.choices?.[0]?.message;
    if (this.debug) {
      const ms = Date.now() - startedAt;
      console.log(
        `[llama] <- ${baseUrl} in ${ms}ms; raw message: ${JSON.stringify(message ?? null)}`,
      );
    }
    if (!message) {
      console.warn(`[llama] ${baseUrl} returned no message; skipping turn`);
      return { call: null, raw: '' };
    }

    // Path 1: the server supports native function-calling and returned tool_calls.
    const fn = message.tool_calls?.[0]?.function;
    if (fn?.name) {
      // The raw trace for a function call is the call itself, serialized.
      const raw = JSON.stringify(message.tool_calls);
      let input: unknown = {};
      if (fn.arguments) {
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          console.warn(`[llama] ${baseUrl} tool_call arguments were not valid JSON; skipping turn`);
          return { call: null, raw };
        }
      }
      return { call: { name: fn.name, input }, raw };
    }

    // Path 2: JSON mode — parse the content as our { tool, args } contract.
    const content = message.content;
    if (!content) {
      console.warn(`[llama] ${baseUrl} returned empty content; skipping turn`);
      return { call: null, raw: '' };
    }

    let reply: JsonToolReply;
    try {
      reply = JSON.parse(content) as JsonToolReply;
    } catch {
      // A successful HTTP response with non-JSON content is a model-output
      // problem, not a server problem — skip the turn rather than failing over.
      console.warn(`[llama] ${baseUrl} response was not valid JSON; skipping turn:`, content.slice(0, 200));
      return { call: null, raw: content };
    }

    if (typeof reply.tool !== 'string') {
      console.warn(`[llama] ${baseUrl} response had no "tool" field; skipping turn`);
      return { call: null, raw: content };
    }
    // `args` may be absent for zero-arg tools; the shared parseDecision()
    // does the real per-tool validation.
    return { call: { name: reply.tool, input: reply.args ?? {} }, raw: content };
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

/** Build the explicit JSON output contract injected into the system prompt. */
function toolContract(tools: ToolDefinition[]): string {
  const described = tools
    .map((t) => `- "${t.name}": ${t.description}\n  args schema: ${JSON.stringify(t.input_schema.properties)}`)
    .join('\n');

  return [
    'You must respond with a SINGLE JSON object and nothing else, of the form:',
    '{ "tool": "<one of the tool names>", "args": { ...arguments for that tool... } }',
    '',
    'Available tools:',
    described,
  ].join('\n');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Treat `1`/`true`/`yes`/`on` (any case) as enabled; everything else as off. */
function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
