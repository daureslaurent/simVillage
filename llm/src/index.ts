/**
 * llm/src/index.ts
 * ---------------------------------------------------------------------------
 * The LLM Engine service — the village's single brain-stem, over HTTP.
 *
 * One process == the ONE thing that talks to the lone llama server. The backend
 * (its villagers, the God Agent, the reflection writer) POSTs every piece of LLM
 * work here, and the engine serializes it so the single server is never
 * dog-piled. Run exactly one.
 *
 * Endpoints (all POST):
 *   /decide   { messages, tools } (or legacy { system, userMessage, tools })
 *                                              -> SSE: `delta`* then `done` { turn | decision }
 *   /complete { system, user }                 -> { text }
 *   /embed    { texts: string[] }              -> { vectors: number[][] }
 *   /models   (GET)                            -> LlmModelConfig { current, available }
 *   /model    { model }                        -> LlmModelConfig { current, available }
 *   /pool     (GET)                            -> LlmPoolConfig { endpoints, capacity, defaultModel }
 *   /health   (GET)                            -> "ok"
 * ---------------------------------------------------------------------------
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { LlamaEngine } from '../../agent/src/llm/LlamaEngine';

const LLM_PORT = Number(process.env.LLM_PORT ?? 8090);

async function main(): Promise<void> {
  // The single engine. Pacing between calls is opt-in via LLM_ENGINE_MIN_GAP_MS.
  const engine = new LlamaEngine();

  const server = createServer((req, res) => {
    void handle(engine, req, res).catch((err) => {
      sendJson(res, 500, { error: errMsg(err) });
    });
  });

  server.listen(LLM_PORT, () => {
    console.log(`[boot] llm engine listening on :${LLM_PORT} via ${engine.name}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n[shutdown] received ${signal}, stopping...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function handle(
  engine: LlamaEngine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  // The current chat model + the models the backend can serve (discovered live).
  if (req.method === 'GET' && req.url === '/models') {
    sendJson(res, 200, await engine.getModelConfig());
    return;
  }
  // The pool's shape: its endpoints, live busy flags, and parallel capacity.
  if (req.method === 'GET' && req.url === '/pool') {
    sendJson(res, 200, engine.getPoolConfig());
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJson(req);
  switch (req.url) {
    case '/decide':
      await streamDecide(engine, body, res);
      return;
    case '/complete':
      sendJson(res, 200, { text: await engine.synthesize(body) });
      return;
    case '/embed':
      sendJson(res, 200, { vectors: await engine.embed(body.texts ?? []) });
      return;
    case '/model': {
      // Switch the global chat model, then echo back the (re-discovered) config.
      if (typeof body.model !== 'string' || !body.model) {
        sendJson(res, 400, { error: 'body.model (non-empty string) is required' });
        return;
      }
      sendJson(res, 200, await engine.setModel(body.model));
      return;
    }
    default:
      sendJson(res, 404, { error: `unknown endpoint ${req.url}` });
  }
}

/**
 * Run a decision and STREAM it back as Server-Sent Events: one `delta` frame per
 * output slice the model emits, then a terminal `done` frame carrying the full
 * {@link LLMDecision} (or an `error` frame if the call fails outright). The
 * backend's `HttpLLMClient` consumes this and re-publishes the deltas onto the
 * telemetry bus for the Live LLM window. Errors are written into the stream
 * rather than thrown, since the SSE headers are already on the wire.
 */
async function streamDecide(
  engine: LlamaEngine,
  body: any,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  try {
    if (Array.isArray(body?.messages)) {
      // Agentic path: one assistant turn over a transcript, with native tool-calling.
      const turn = await engine.converseStream(
        body.messages,
        body.tools ?? [],
        body.route,
        (chunk) => send({ type: 'delta', ...chunk }),
      );
      send({ type: 'done', turn });
    } else {
      // Legacy single-decision path (system + userMessage + tools).
      const decision = await engine.decideStream(body, (chunk) => send({ type: 'delta', ...chunk }));
      send({ type: 'done', decision });
    }
  } catch (err) {
    send({ type: 'error', error: errMsg(err) });
  } finally {
    res.end();
  }
}

/** Read and JSON-parse a request body. */
function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error('[fatal] llm engine failed to start:', err);
  process.exit(1);
});
