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

import type { LLMDecision, LLMProvider, LLMRequest, LLMTurn, LLMToolCall } from './LLMProvider';
import type { ToolDefinition } from '../tools';
import type { LlmMessage, LlmUsage } from '../../../shared/types';

/**
 * One slice of a streamed decision, handed to the {@link StreamSink} as the
 * model emits it: a chunk of visible `content` and/or separately-reported
 * `reasoning` ("thinking"). Either field may be absent on a given chunk.
 */
export interface DecisionStreamChunk {
  content?: string;
  reasoning?: string;
}

/** A consumer of streamed decision chunks (the live LLM telemetry feed). */
export type StreamSink = (chunk: DecisionStreamChunk) => void;

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
   * Cap on the completion length (tokens) for every decision. Defaults to the
   * global `LLM_MAX_TOKENS`; when neither is set, no cap is sent and the server's
   * own default applies (today's behaviour). Raise it for a thinking model that
   * reasons before emitting its tool call.
   */
  maxTokens?: number;
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
  /** Token accounting most OpenAI-compatible servers return (llama.cpp, vLLM, …). */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** One SSE chunk of a streamed chat-completion (OpenAI `stream: true` shape). */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** Some servers (reasoning models) stream hidden thinking here. */
      reasoning_content?: string | null;
      /** Native tool-call deltas, accumulated by `index` across chunks. */
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  /** Present only on the terminal chunk when `stream_options.include_usage` is set. */
  usage?: ChatCompletionResponse['usage'];
}

/** A tool call being assembled from streamed deltas, keyed by its `index`. */
interface ToolCallAccum {
  id: string;
  name: string;
  args: string;
}

/** Shape we ask the model to emit in JSON mode (then validate). */
interface JsonToolReply {
  tool?: unknown;
  args?: unknown;
}

export class LlamaProvider implements LLMProvider {
  readonly name = 'llama';

  private readonly urls: string[];
  /** The chat model tag sent on every request. Mutable: the operator can switch it live. */
  private model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  /** Completion-length cap (tokens); undefined = send none, let the server decide. */
  private readonly maxTokens: number | undefined;
  private readonly debug: boolean;
  /**
   * Anti-repetition sampling params spread into every request body. A local model
   * with NO repetition penalty can fall into a degenerate loop — emitting the same
   * phrase until `max_tokens` — so we always send a mild penalty. `repeat_penalty` +
   * `repeat_last_n` are llama.cpp's lever; `frequency_penalty`/`presence_penalty` are
   * the OpenAI-standard ones (also honoured by llama.cpp). All env-tunable. Set a
   * penalty to its neutral value (1.0 / 0) to disable it.
   */
  private readonly sampling: Record<string, number>;
  /** Loop-detector config: when set, a streamed run is cut short on a detected loop. */
  private readonly loopGuard: { enabled: boolean; minRepeats: number };
  /** Round-robin cursor; advances one server per decision. */
  private cursor = 0;

  constructor(options: LlamaProviderOptions = {}) {
    const urls = options.urls ?? parseUrls(process.env.LLAMA_URLS);
    this.urls = urls.length > 0 ? urls : ['http://localhost:8080'];
    this.model = options.model ?? process.env.LLAMA_MODEL ?? 'llama';
    this.apiKey = options.apiKey ?? process.env.LLAMA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LLAMA_TIMEOUT_MS ?? 30_000);
    this.maxTokens = options.maxTokens ?? parseMaxTokens(process.env.LLM_MAX_TOKENS);
    this.debug = options.debug ?? isTruthy(process.env.LLAMA_DEBUG);
    this.sampling = {
      repeat_penalty: parseFloatEnv(process.env.LLM_REPEAT_PENALTY, 1.1),
      repeat_last_n: parseIntEnv(process.env.LLM_REPEAT_LAST_N, 256),
      frequency_penalty: parseFloatEnv(process.env.LLM_FREQUENCY_PENALTY, 0.3),
      presence_penalty: parseFloatEnv(process.env.LLM_PRESENCE_PENALTY, 0),
    };
    this.loopGuard = {
      // On by default; LLM_LOOP_GUARD=off (or 0/false/no) disables the stream watchdog.
      enabled: process.env.LLM_LOOP_GUARD === undefined ? true : isTruthy(process.env.LLM_LOOP_GUARD),
      minRepeats: Math.max(2, parseIntEnv(process.env.LLM_LOOP_GUARD_REPEATS, 4)),
    };
  }

  /** A fresh repetition watchdog for one streamed run, or null when the guard is off. */
  private makeGuard(): RepetitionGuard | null {
    return this.loopGuard.enabled ? new RepetitionGuard(this.loopGuard.minRepeats) : null;
  }

  /** The model tag every chat call currently runs against. */
  getModel(): string {
    return this.model;
  }

  /** Switch the chat model used from the next call onward. */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * The model ids the backend reports it can serve, via the OpenAI-compatible
   * `GET /v1/models` (which llama.cpp, Ollama, vLLM, … all expose). Tries each
   * server in the pool until one answers; returns `[]` if none do, so discovery
   * failure degrades to "no list" rather than throwing.
   */
  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(this.cursor + i) % this.urls.length]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${url}/v1/models`, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`responded ${res.status} ${res.statusText}`);
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const ids = (body.data ?? [])
          .map((m) => (typeof m.id === 'string' ? m.id : null))
          .filter((id): id is string => Boolean(id));
        // De-dupe and sort so the selector is stable across servers/refreshes.
        return [...new Set(ids)].sort();
      } catch (err) {
        console.warn(`[llama] model list failed on ${url}: ${errMsg(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return [];
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

  /**
   * Like {@link decide}, but STREAMS the model's output: `onChunk` is called for
   * each slice (visible content and/or reasoning) as it arrives, and the resolved
   * {@link LLMDecision} is assembled from the fully-accumulated text. Failover only
   * happens BEFORE the first chunk of a given server is emitted — once tokens are
   * flowing we are committed to that server (re-running would replay output to the
   * live view). Used by the `/decide` engine endpoint; the buffered {@link decide}
   * is kept for in-process callers that don't want a stream.
   */
  async decideStream(request: LLMRequest, onChunk: StreamSink): Promise<LLMDecision> {
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.urls.length;

    const errors: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(start + i) % this.urls.length]!;
      const progress = { emitted: false };
      try {
        return await this.callServerStream(url, request, onChunk, progress);
      } catch (err) {
        // Once a chunk has streamed to the viewer we can't silently fail over to
        // another server — surface the error so the turn is skipped cleanly.
        if (progress.emitted) throw err;
        errors.push(`${url}: ${errMsg(err)}`);
        console.warn(`[llama] stream failed pre-token, failing over: ${url}: ${errMsg(err)}`);
      }
    }
    throw new Error(`all ${this.urls.length} llama server(s) failed: ${errors.join('; ')}`);
  }

  /**
   * One streaming attempt against a single server. Reads the SSE body, forwarding
   * each delta to `onChunk` (and flipping `progress.emitted` on the first one), then
   * parses the accumulated JSON content into a decision. Throws on a transport/HTTP
   * error or a server that drops the stream.
   */
  private async callServerStream(
    baseUrl: string,
    request: LLMRequest,
    onChunk: StreamSink,
    progress: { emitted: boolean },
  ): Promise<LLMDecision> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const messages = [
      { role: 'system', content: `${request.system}\n\n${toolContract(request.tools)}` },
      { role: 'user', content: request.userMessage },
    ];

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
          stream: true,
          // Ask for the terminal usage chunk so the tally still works under streaming.
          stream_options: { include_usage: true },
          temperature: 0.7,
          ...this.sampling,
          response_format: { type: 'json_object' },
          ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
          messages,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`responded ${res.status} ${res.statusText}`);
      }

      const guard = this.makeGuard();
      let looped = false;
      let content = '';
      let usage: LlmUsage | undefined;
      // Walk the SSE stream line-by-line, accumulating content + reasoning.
      for await (const data of readSse(res.body)) {
        if (data === '[DONE]') break;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue; // ignore keep-alives / unparseable frames
        }
        const u = parseUsage(chunk.usage);
        if (u) usage = u;
        const delta = chunk.choices?.[0]?.delta;
        const c = delta?.content ?? undefined;
        const r = delta?.reasoning_content ?? undefined;
        if (c) content += c;
        if (c || r) {
          progress.emitted = true;
          onChunk({ ...(c ? { content: c } : {}), ...(r ? { reasoning: r } : {}) });
        }
        // Watchdog: if the model has fallen into a repeating loop, cut the stream
        // short rather than let it spin out to max_tokens (or forever).
        if (guard && (c || r) && guard.push(c ?? r ?? '')) {
          console.warn(`[llama] ${baseUrl} repetition loop detected; cutting the stream short`);
          looped = true;
          break;
        }
      }
      if (looped) controller.abort(); // release the socket; we've stopped reading

      return parseJsonDecision(baseUrl, content, usage);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One ASSISTANT TURN of the agentic loop, STREAMED. Sends the running transcript
   * with NATIVE OpenAI tool-calling (`tools` + `tool_choice: auto`), streams visible
   * content + reasoning to `onChunk` for the live view, and accumulates the model's
   * `tool_calls` from their deltas — resolving to the {@link LLMTurn} (content + the
   * calls to run, or none when the model yields). Pre-first-token failover only, like
   * {@link decideStream}. If a server returns no native tool_calls but its content is
   * our JSON `{tool,args}` contract, that is parsed as a single call (resilience for
   * servers without tool support).
   */
  async converseStream(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    onChunk: StreamSink,
  ): Promise<LLMTurn> {
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.urls.length;

    const errors: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(start + i) % this.urls.length]!;
      const progress = { emitted: false };
      try {
        return await this.callConverseStream(url, messages, tools, onChunk, progress);
      } catch (err) {
        if (progress.emitted) throw err;
        errors.push(`${url}: ${errMsg(err)}`);
        console.warn(`[llama] converse stream failed pre-token, failing over: ${url}: ${errMsg(err)}`);
      }
    }
    throw new Error(`all ${this.urls.length} llama server(s) failed: ${errors.join('; ')}`);
  }

  /** One streaming converse attempt against a single server. Throws on transport/HTTP error. */
  private async callConverseStream(
    baseUrl: string,
    messages: LlmMessage[],
    tools: ToolDefinition[],
    onChunk: StreamSink,
    progress: { emitted: boolean },
  ): Promise<LLMTurn> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.7,
          ...this.sampling,
          tools: tools.map(toOpenAiTool),
          tool_choice: 'auto',
          ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
          messages: messages.map(toOpenAiMessage),
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`responded ${res.status} ${res.statusText}`);
      }

      const guard = this.makeGuard();
      let looped = false;
      let content = '';
      let usage: LlmUsage | undefined;
      const calls = new Map<number, ToolCallAccum>();
      for await (const data of readSse(res.body)) {
        if (data === '[DONE]') break;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue;
        }
        const u = parseUsage(chunk.usage);
        if (u) usage = u;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        const c = delta.content ?? undefined;
        const r = delta.reasoning_content ?? undefined;
        if (c) content += c;
        if (c || r) {
          progress.emitted = true;
          onChunk({ ...(c ? { content: c } : {}), ...(r ? { reasoning: r } : {}) });
        }
        // Accumulate native tool-call deltas by index (id/name on the first, args appended).
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = calls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          calls.set(idx, acc);
        }
        // Watchdog: cut a repeating loop short rather than spin to max_tokens.
        if (guard && (c || r) && guard.push(c ?? r ?? '')) {
          console.warn(`[llama] ${baseUrl} repetition loop detected; cutting the stream short`);
          looped = true;
          break;
        }
      }
      if (looped) controller.abort(); // release the socket; we've stopped reading

      return assembleTurn(content, calls, usage);
    } finally {
      clearTimeout(timer);
    }
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
          ...this.sampling,
          response_format: { type: 'json_object' },
          // Only sent when configured (LLM_MAX_TOKENS / option); otherwise the
          // server's own default applies, as before.
          ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
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
    const usage = parseUsage(body.usage);
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
      return { call: { name: fn.name, input }, raw, ...(usage ? { usage } : {}) };
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
    return { call: { name: reply.tool, input: reply.args ?? {} }, raw: content, ...(usage ? { usage } : {}) };
  }
}

/**
 * Normalise an OpenAI-compatible `usage` block to our {@link LlmUsage}, or undefined
 * when the server reported none. `reasoning_tokens` (the model's hidden "thinking",
 * already counted within completion_tokens) is surfaced separately when present.
 */
function parseUsage(usage: ChatCompletionResponse['usage']): LlmUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const think = usage.completion_tokens_details?.reasoning_tokens;
  return { inputTokens, outputTokens, ...(typeof think === 'number' ? { thinkTokens: think } : {}) };
}

/**
 * Parse a fully-accumulated JSON-mode reply into a decision — the streaming
 * counterpart of {@link LlamaProvider}'s buffered JSON path. A reply that is
 * empty / not JSON / missing a `tool` field becomes a null decision (skip the
 * turn) rather than throwing, so unvalidated output never reaches the bus.
 */
function parseJsonDecision(baseUrl: string, content: string, usage: LlmUsage | undefined): LLMDecision {
  if (!content) {
    console.warn(`[llama] ${baseUrl} streamed empty content; skipping turn`);
    return { call: null, raw: '' };
  }
  let reply: JsonToolReply;
  try {
    reply = JSON.parse(content) as JsonToolReply;
  } catch {
    console.warn(`[llama] ${baseUrl} streamed non-JSON content; skipping turn:`, content.slice(0, 200));
    return { call: null, raw: content };
  }
  if (typeof reply.tool !== 'string') {
    console.warn(`[llama] ${baseUrl} streamed reply had no "tool" field; skipping turn`);
    return { call: null, raw: content };
  }
  return { call: { name: reply.tool, input: reply.args ?? {} }, raw: content, ...(usage ? { usage } : {}) };
}

/**
 * Iterate the `data:` payloads of an SSE response body, one per yielded string
 * (the OpenAI streaming wire format). Frames are reassembled across chunk
 * boundaries; comment/blank lines are skipped. The caller stops on `[DONE]`.
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

/** Map a provider-neutral tool definition to the OpenAI `tools` entry shape. */
function toOpenAiTool(tool: ToolDefinition): unknown {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  };
}

/** Map one transcript message to the OpenAI chat message shape (incl. tool calls / results). */
function toOpenAiMessage(msg: LlmMessage): unknown {
  switch (msg.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: msg.content ?? '',
        ...(msg.toolCalls && msg.toolCalls.length > 0
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    default:
      return { role: msg.role, content: msg.content };
  }
}

/**
 * Build the final {@link LLMTurn} from the accumulated content + tool calls. Falls
 * back to parsing the JSON `{tool,args}` contract out of `content` when the server
 * returned no native tool_calls — so a server without tool support still drives the
 * loop one call at a time.
 */
function assembleTurn(content: string, calls: Map<number, ToolCallAccum>, usage: LlmUsage | undefined): LLMTurn {
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  let toolCalls: LLMToolCall[] = ordered
    .filter((c) => c.name)
    .map((c) => ({ id: c.id || c.name, name: c.name, input: parseArgs(c.args) }));

  if (toolCalls.length === 0 && content.trim().startsWith('{')) {
    const fallback = parseJsonContractCall(content);
    if (fallback) toolCalls = [fallback];
  }
  return { content, toolCalls, raw: content, ...(usage ? { usage } : {}) };
}

/** Parse a tool-call arguments JSON string into an object; {} on empty/invalid. */
function parseArgs(args: string): unknown {
  if (!args || !args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Parse our `{ "tool": "...", "args": {...} }` JSON contract from content, or null. */
function parseJsonContractCall(content: string): LLMToolCall | null {
  try {
    const reply = JSON.parse(content) as { tool?: unknown; args?: unknown };
    if (typeof reply.tool === 'string' && reply.tool) {
      return { id: reply.tool, name: reply.tool, input: reply.args ?? {} };
    }
  } catch {
    /* not the JSON contract — treat as a plain yield */
  }
  return null;
}

/** Split a comma-separated URL list, trimming blanks and trailing slashes. */
function parseUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** Parse a positive token cap from an env value; undefined for unset/invalid/≤0. */
function parseMaxTokens(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** A finite float from an env value, or `fallback` for unset/blank/non-numeric. */
function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** A non-negative integer from an env value, or `fallback` for unset/blank/invalid. */
function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * A streaming repetition watchdog. Fed each visible slice, it keeps a bounded tail
 * of the output and reports a LOOP once that tail ends in the same block repeated
 * `minRepeats` times back-to-back — the signature of a model stuck emitting the same
 * word or phrase. Catches periods from a couple of characters ("ha ha ha …") up to a
 * long sentence, while requiring several verbatim repeats so ordinary prose (which
 * rarely repeats a non-trivial block 4× exactly) doesn't trip it. Scans are throttled
 * to once per {@link STRIDE} new characters so a token-by-token stream stays cheap.
 */
class RepetitionGuard {
  /** Bounded tail of recent output we scan for a cycle. */
  private buf = '';
  /** Chars accumulated since the last scan, for stride throttling. */
  private since = 0;

  /** Longest window we retain + scan (chars). Bounds both memory and scan cost. */
  private static readonly WINDOW = 800;
  /** Shortest repeating block to consider, so single repeated spaces don't count. */
  private static readonly MIN_PERIOD = 2;
  /** Longest repeating block to consider (a long looped sentence). */
  private static readonly MAX_PERIOD = 240;
  /** Only re-scan once this many new chars have arrived. */
  private static readonly STRIDE = 16;

  constructor(private readonly minRepeats: number) {}

  /** Feed a slice; returns true the first time the tail looks like a runaway loop. */
  push(slice: string): boolean {
    if (!slice) return false;
    this.buf += slice;
    if (this.buf.length > RepetitionGuard.WINDOW) {
      this.buf = this.buf.slice(-RepetitionGuard.WINDOW);
    }
    this.since += slice.length;
    if (this.since < RepetitionGuard.STRIDE) return false;
    this.since = 0;
    return this.isLooping();
  }

  /** True when the tail is a `block` repeated `minRepeats`× in a row (block not blank). */
  private isLooping(): boolean {
    const s = this.buf;
    const n = s.length;
    const maxP = Math.min(RepetitionGuard.MAX_PERIOD, Math.floor(n / this.minRepeats));
    for (let p = RepetitionGuard.MIN_PERIOD; p <= maxP; p++) {
      const block = s.slice(n - p);
      if (block.trim().length < 2) continue; // ignore whitespace-only cycles
      let ok = true;
      for (let k = 2; k <= this.minRepeats; k++) {
        if (s.slice(n - p * k, n - p * (k - 1)) !== block) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }
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
