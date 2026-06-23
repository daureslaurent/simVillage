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
 * Endpoints (all POST, JSON in/out):
 *   /decide   { system, userMessage, tools }  -> LLMDecision { call, raw }
 *   /complete { system, user }                 -> { text }
 *   /embed    { texts: string[] }              -> { vectors: number[][] }
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
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJson(req);
  switch (req.url) {
    case '/decide':
      sendJson(res, 200, await engine.decide(body));
      return;
    case '/complete':
      sendJson(res, 200, { text: await engine.synthesize(body) });
      return;
    case '/embed':
      sendJson(res, 200, { vectors: await engine.embed(body.texts ?? []) });
      return;
    default:
      sendJson(res, 404, { error: `unknown endpoint ${req.url}` });
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
