# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

simVillage is an LLM-driven AI village simulation: autonomous villagers live, work, trade, talk, pray and build on their own while a human watches and optionally nudges. It is a TypeScript monorepo (one root `package.json`, no per-package manifests) split into source folders that compile into a few Docker images. There is **no test framework** in this repo.

## Commands

```bash
# Local dev (hot reload): runs backend + llm engine + vite client concurrently
npm run dev
#   npm run dev:server   — tsx watch server/src/index.ts   (the whole backend)
#   npm run dev:llm       — tsx watch llm/src/index.ts       (the LLM engine)
#   npm run dev:client    — vite                              (browser app)

npm run typecheck   # tsc --noEmit across server, llm, client projects — the de-facto build check
npm run build       # tsc -p server/tsconfig.json && vite build

# Full stack via Docker (the real way it runs — see Memory: "Docker Compose launch")
npm run up                              # = APP_VERSION=$(appver) docker compose up --build
docker compose up --build               # mongo + qdrant + embed + llm + backend + client
docker compose -f docker-compose.yml -f docker-compose.dev.yml up   # dev overlay: bind-mounts source for hot reload
./update_run.sh                         # remote: git reset --hard origin/master, rebuild, WIPES VOLUMES, restart
```

Reaching the app: browser hits **http://localhost:5172** (client nginx) only; nginx reverse-proxies the WebSocket + REST to the backend. The backend gateway is never exposed to the host. Mongo is published on 27017 for inspection.

There is no lint step and no unit tests — `npm run typecheck` is the verification gate. Strictness is maximal by design (see `tsconfig.base.json`); the type system is the contract between engine, wire protocol and UI.

## Architecture (the big picture)

**One backend process is the whole village** except its face (the browser client) and its brain-stem (the LLM engine). `server/src/index.ts` wires every "service" together over a single **in-process event bus** (`bus/EventBus.ts` → `InProcessBus`). The folder names (`gateway/`, `agent/`, `supervisor/`) are historical separate-service boundaries; they now all run in-process and are type-checked together by `server/tsconfig.json` (which `include`s `shared`, `bus`, `gateway`, `agent`, `supervisor`).

The decoupling seams that matter:

- **`WorldEngine` (`server/src/WorldEngine.ts`) is the sole source of truth and is pure** — it imports no networking and no DB driver. It's a typed `EventEmitter`: emits `init`/`tick`, accepts intentions only through `dispatchCommand`. All transport/persistence lives in subscribers.
- **The event bus is a set of topic exchanges** (`shared/events.ts`, `EXCHANGES`) with dotted routing keys. Producers and consumers never reference each other. Key flows: `world.events` (engine→all), `villager.intents` (villagers→engine), `user.commands` (browser→engine), `village.events` (aggregator→all, daily summaries), `supervisor.commands` / `user.supervisor.*` (God Agent + human console→engine).
- **The LLM never touches the engine.** A mind's only outlet is a validated intent envelope on the bus; malformed tool calls are dropped. Everything LLM goes over HTTP to the single `llm` engine (`llm/src/index.ts`, `LlamaEngine`), which **serializes** access so the lone llama server is never hit concurrently. The backend POSTs `/decide` (SSE), `/complete`, `/embed`.

**Boot order matters:** every subscriber must bind before the engine starts ticking so none miss the first `world.init`.

### Two villager brains (v2 → v3 inversion — read `docs/v3-supervisor-driven-design.md`)

The branch is mid-migration from v2 to v3. Selected by `VILLAGER_BRAIN`:

- **`llm` (v2, "parallel minds"):** every villager is an `AgentService` (`agent/src/AgentService.ts`) running Sense→Think→Act with its own LLM call, scheduled by `MindScheduler` over an endpoint pool, with Qdrant RAG long-term memory + nightly reflection. `MindRegistry` gives every body (including ones spawned after boot) a mind.
- **`utility` (v3, the inversion):** villagers are cheap automatons — `agent/src/brain/UtilityBrain.ts` scores candidate actions (`need_pressure × trait_modifier × supervisor_weight + order_bonus − switching/distance cost`) and emits the **same `AgentDecision`s** the engine already executes. Intelligence moves UP to the supervisor, which sets a standing **policy** (priority weights) and occasional **orders**. Goal: a living village at ~1–2 LLM calls total. `docker-compose.yml` currently sets `VILLAGER_BRAIN=utility` and `RIVAL_VILLAGE=on`.

The crucial design property: the utility brain is a *new chooser in front of the same effect layer*. New villager behavior should reuse existing `AgentDecision` actions (`move_to`, `work_at`, `take_from`, `give_to`, `propose_build`, …) rather than adding engine effects.

### The Supervisor (God Agent)

`supervisor/src/SupervisorService.ts` is the macro-mind: senses one day at a time (`village.daily_summary`), thinks via the LLM against a charter, and acts with validated god-tools (`supervisor/src/tools.ts` `GOD_TOOLS`) — `set_priorities`, `issue_order`, plus escalations `change_weather` / `spawn_entity` / `plant_idea`. Humans can seize the wheel through the `user.supervisor.*` console channel. In v3 it also owns the rival-village seam (`RIVAL_VILLAGE`, `RIVAL_VILLAGE_ID` vs `DEFAULT_VILLAGE_ID` in `shared/types.ts`): two villages, one supervisor per side, soft competition (raids/territory), no death.

### Persistence & memory

- **MongoDB** — world snapshots (paced by wall-clock `SNAPSHOT_INTERVAL_MS`) plus conversations, relationships, actions, daily reports, and `RuntimeStateStore` (weather/sleep/reflection/plan watermarks so a reboot resumes). All under `server/src/persistence/` behind `*Store` interfaces with `Mongo*` implementations.
- **Qdrant** — per-villager vector memory (RAG), used only when `VILLAGER_MEMORY=on`. Embeddings come from the local `embed` service (nomic-embed-text, 768-dim; `EMBED_DIM` must match end to end). Likely retired under the v3 utility brain.

### Time model

The in-world clock advances on **wall time**, not per LLM round, so time flows steadily regardless of how many minds are thinking. `SIM_SPEED` is a master time-scale (clamped [0.1, 20]) that speeds up movement, the clock, needs/economy/weather and think cadence in lock-step without changing the world's internal proportions. `WORLD_TICK_RATE` is the physics rate; minds think far less often (paced by the scheduler's heartbeat + interrupts).

### Client

`client/` is a vanilla TS + Canvas app built by Vite (`vite.config.ts` lives at repo root with `root: 'client'`; `fs.allow: ['..']` lets it import `shared/`). `NetworkClient.ts` is the WS link; the rest are panels (`InspectorPanel`, `RosterPanel`, `SupervisorPanel`, `SetupScreen`, etc.) coordinated by `WindowManager`. First boot with no world shows a setup screen (auto-generate via LLM with a style/count/size, or the hand-crafted village).

## Conventions

- **Imports are extension-less, alias-free, relative** (`moduleResolution: "Bundler"`), understood by both tsx and Vite. Cross-package imports reach across folders directly, e.g. `../../shared/types`, `../../bus/EventBus`.
- **`shared/` is the wire contract** — `events.ts` (envelopes/exchanges), `types.ts` (domain types), plus `buildings.ts`, `climate.ts`, `perception.ts`, `simClock.ts`, `appearance.ts`. Both server and client depend on it; change it deliberately.
- Configuration is entirely env-var driven. `.env.example` is the authoritative, heavily-commented list of every knob; `docker-compose.yml` carries the runtime defaults.
