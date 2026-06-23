# simVillage — Phase 2: The Nervous System

An event-driven, multi-villager AI village simulation. Phase 2 rewires the system to be
**fully event-driven over RabbitMQ**. The tick-driven **World Engine** no longer talks to
browsers directly; instead it consumes intents/commands and publishes world events on a
message bus. A new **Ingress Gateway** owns the WebSocket connections and bridges the bus to
the **Canvas viewport**. **MongoDB** persistence is unchanged — all via Docker Compose.

## Architecture (the important part)

Three Topic Exchanges form the bus, one per direction of flow:

| Exchange         | Direction          | Carries                                  |
|------------------|--------------------|------------------------------------------|
| `world.events`   | engine → observers | `world.init`, `world.map_updated`        |
| `villager.intents`  | villagers → engine    | `villager.move`                             |
| `user.commands`  | gateway → engine   | `user.force_move`, `user.sync`           |

Every message is wrapped in a strongly-typed `EventEnvelope` carrying `eventId`,
`timestamp`, `type`, and `payload` (the `type` doubles as the AMQP routing key).

```
   browser  ⇄ WS ⇄  Ingress Gateway  ⇄ amqp ⇄   RabbitMQ   ⇄ amqp ⇄  World Engine  ⇄  Mongo
   (Canvas)         (holds sockets)            (3 exchanges)         (pure sim core)
                         │                                                 │
            publishes user.commands                          subscribes user.commands
            subscribes world.events                          subscribes villager.intents
                                                             publishes  world.events
```

The `WorldEngine` stays a **pure** state machine (no `ws`, no `amqplib`, no `mongodb`). As
Phase 1 promised, swapping the transport touched zero engine lines — `WebSocketTransport` was
simply replaced by `RabbitMqTransport`, both implementing the same `Transport` seam.

- `shared/types.ts` — the browser ⇄ gateway wire protocol (unchanged; the client needs no edits).
- `shared/events.ts` — the bus contract: exchange names + typed event envelopes.
- `bus/EventBus.ts` — the `amqplib` wrapper: publish/subscribe, reconnect with backoff, the *only* file that imports `amqplib`.
- `server/src/WorldEngine.ts` — pure simulation; typed `on('tick'|'init')` events + `dispatchCommand`.
- `server/src/transport/RabbitMqTransport.ts` — bridges the engine ⇄ bus.
- `server/src/persistence/` — `WorldStore` interface + `MongoWorldStore`.
- `gateway/src/IngressGateway.ts` — owns browser WebSockets; bridges browser ⇄ bus.
- `client/src/` — `NetworkClient` (WS) + `Renderer` (Canvas + God Hand clicks).

## Run

```bash
cp .env.example .env      # optional; compose has the same defaults baked in
docker compose up --build
```

This **builds** self-contained images (esbuild bundle for the backend/llm, `vite
build` for the client served by nginx) — nothing is bind-mounted from the host.
For a hot-reloading dev workflow that mounts the working tree, add the dev overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Then open **http://localhost:5173**. The RabbitMQ management UI is at
**http://localhost:15672** (`guest` / `guest`).

- Trees render as green squares, villagers as colored circles.
- **Click an empty tile** → the gateway publishes `user.force_move`; the engine moves
  `villager_1` over the next few ticks and broadcasts `world.map_updated` back down.
- State persists to Mongo: `docker compose restart server` resumes the world where it left off.
- Services are decoupled: restart the `gateway` and browsers reconnect; the engine keeps simulating.

## Local (without Docker)

Requires a reachable MongoDB (`MONGO_URL`) **and** RabbitMQ (`RABBITMQ_URL`). The quickest way
to get the broker is `docker compose up rabbitmq mongo`, then point the local URLs at
`localhost`:

```bash
npm install
npm run typecheck      # strict type-check across shared/bus/server/gateway/client
RABBITMQ_URL=amqp://localhost:5672 MONGO_URL=mongodb://localhost:27017/simvillage \
  npm run dev          # engine (tsx watch) + gateway (tsx watch) + client (vite)
```

## Config (env)

| Var                    | Default                              | Purpose                                       |
|------------------------|--------------------------------------|-----------------------------------------------|
| `MONGO_URL`            | `mongodb://mongo:27017/simvillage`   | Mongo connection string (engine)              |
| `RABBITMQ_URL`         | `amqp://rabbitmq:5672`               | RabbitMQ/AMQP URL (engine + gateway)          |
| `GATEWAY_WS_PORT`      | `8080`                               | Ingress Gateway WebSocket/HTTP port           |
| `SNAPSHOT_EVERY_TICKS` | `50`                                 | Snapshot cadence (ticks)                      |
| `VITE_WS_URL`          | `ws://localhost:8080`                | Browser-facing WS URL (points at the gateway) |
