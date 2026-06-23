/**
 * server/src/index.ts
 * ---------------------------------------------------------------------------
 * The BACKEND. One process that is the whole village except its face (the
 * browser client) and its brain-stem (the llm engine).
 *
 * Everything that used to be a separate broker-connected service now runs here,
 * wired together over a single in-process bus — so there is no RabbitMQ to run:
 *
 *   - WorldEngine        the pure simulation (ticks the world)
 *   - RabbitMqTransport  bridges engine <-> bus (now in-process; name kept)
 *   - IngressGateway     the browser-facing WebSocket server
 *   - villagers          one AgentService mind per seeded body
 *   - SupervisorService  the "God Agent" macro-author
 *   - DailySummaryAggregator + Mongo persistence
 *
 * The minds reach the single shared LLM engine over HTTP (LLM_URL); Mongo is the
 * only external dependency besides that engine.
 *
 * Boot order matters: every subscriber binds before the engine starts ticking,
 * so none miss the first `world.init`.
 * ---------------------------------------------------------------------------
 */

import { EXCHANGES, type SimTickEvent } from '../../shared/events';
import { InProcessBus } from '../../bus/EventBus';
import { WorldEngine } from './WorldEngine';
import { MongoWorldStore } from './persistence/MongoWorldStore';
import type { WorldStore } from './persistence/WorldStore';
import { MongoActionStore } from './persistence/MongoActionStore';
import type { ActionStore } from './persistence/ActionStore';
import { ActionRecorder } from './ActionRecorder';
import { MongoConversationStore } from './persistence/MongoConversationStore';
import type { ConversationStore } from './persistence/ConversationStore';
import { ConversationTracker } from './ConversationTracker';
import { MongoRelationshipStore } from './persistence/MongoRelationshipStore';
import type { RelationshipStore } from './persistence/RelationshipStore';
import { RelationshipTracker } from './RelationshipTracker';
import { RelationshipBook } from '../../agent/src/social/RelationshipBook';
import { GroupCoordinator } from './GroupCoordinator';
import { BuildingLog } from './BuildingLog';
import { TurnCoordinator } from './TurnCoordinator';
import { RabbitMqTransport } from './transport/RabbitMqTransport';
import type { Transport } from './transport/Transport';
import { DailySummaryAggregator } from './DailySummaryAggregator';
import { generateSeed } from './world/seed';
import { IngressGateway } from '../../gateway/src/IngressGateway';
import { AgentService } from '../../agent/src/AgentService';
import { SupervisorService } from '../../supervisor/src/SupervisorService';
import { loadProfiles } from '../../agent/src/profile';
import { loadWorldBible } from '../../agent/src/worldBible';
import { HttpLLMClient } from '../../agent/src/llm/HttpLLMClient';
import { LlmEngineMonitor } from './LlmEngineMonitor';
import { QdrantMemoryStore } from '../../agent/src/memory/QdrantMemoryStore';
import { MemoryStream } from '../../agent/src/memory/MemoryStream';
import { SimClock } from '../../agent/src/memory/narrative';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/simvillage';
// How often to persist a world snapshot (wall-clock). The emitted tick is now the
// in-world clock (a round counter that holds during LLM waits), so snapshotting is
// paced by real time rather than a tick count.
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 15_000);
// Minds think on a single shared llama server, so they act far less often than
// 10 ticks/s. Slow the world clock to match: at a calmer rate, a villager still
// moves a meaningful distance between thoughts, so neighbours stay near long
// enough to actually interact. Tune via WORLD_TICK_RATE (ticks/second).
const WORLD_TICK_RATE = Number(process.env.WORLD_TICK_RATE ?? 3);
const GATEWAY_WS_PORT = Number(process.env.GATEWAY_WS_PORT ?? 8080);

const THINK_INTERVAL_MS = Number(process.env.VILLAGER_THINK_INTERVAL_MS ?? 12000);
// Turn coordinator: rounds a villager rests (no LLM) after taking an action.
const COOLDOWN_TICKS = Number(process.env.VILLAGER_COOLDOWN_TICKS ?? 3);
const MEMORY_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.VILLAGER_MEMORY ?? '').trim().toLowerCase(),
);
const SUPERVISOR_CHARTER = process.env.SUPERVISOR_CHARTER;
const SUPERVISOR_MIN_DAYS = Number(process.env.SUPERVISOR_MIN_DAYS_BETWEEN_ACTS ?? 1);

async function main(): Promise<void> {
  // 1. Persistence. Two stores, same Mongo: the world snapshot (overwritten in
  //    place) and the append-only villager action log.
  const store: WorldStore = new MongoWorldStore(MONGO_URL);
  await store.connect();
  const actions: ActionStore = new MongoActionStore(MONGO_URL);
  await actions.connect();
  const conversations: ConversationStore = new MongoConversationStore(MONGO_URL);
  await conversations.connect();
  const relationshipStore: RelationshipStore = new MongoRelationshipStore(MONGO_URL);
  await relationshipStore.connect();

  // 2. The villager roster (personas) — loaded up front so the world is seeded
  //    with exactly the bodies our minds will inhabit, ids lined up.
  const profiles = loadProfiles();
  const villagerIds = profiles.map((p) => p.id);
  // id -> display name, so conversations read with human names, not raw ids.
  const nameById = new Map(profiles.map((p) => [p.id, p.name] as const));

  // 3. Load or generate the world. A persisted world from an older schema won't
  //    have a `villagers` array, and pre-village saves won't have `buildings`;
  //    in either case treat it as incompatible and regenerate a fresh village.
  let seed = await store.loadSeed();
  const rosterMatches = (s: typeof seed): boolean =>
    !!s &&
    Array.isArray(s.villagers) &&
    s.villagers.length === villagerIds.length &&
    villagerIds.every((id) => s.villagers.some((v) => v.id === id));
  if (seed && Array.isArray(seed.villagers) && Array.isArray(seed.buildings) && rosterMatches(seed)) {
    console.log('[boot] resumed world from Mongo');
  } else {
    if (seed && !rosterMatches(seed)) {
      console.warn(`[boot] persisted roster differs from the current one (${villagerIds.length} villagers); regenerating`);
    } else if (seed) {
      console.warn('[boot] persisted world is incompatible (no buildings); regenerating');
    }
    seed = generateSeed({ villagerIds });
    await store.saveSeed(seed);
    console.log(`[boot] generated and persisted a fresh village (${seed.buildings.length} buildings)`);
  }

  // Stamp human display names from the persona roster onto the bodies, so names
  // are correct everywhere (map cards, roster) without waiting for the thought
  // stream — and so resumed worlds pick up roster renames too.
  for (const villager of seed.villagers) {
    villager.name = nameById.get(villager.id) ?? villager.name ?? villager.id;
  }

  // The in-world clock to resume from: the round tick the last snapshot was taken
  // at, so simulated time picks up where it left off instead of restarting at Day 1.
  // A freshly generated (or pre-clock) seed has none, so we begin at 0.
  const resumeClock = Math.max(0, Math.floor(seed.clock ?? 0));

  // 3. The pure engine.
  const engine = new WorldEngine(seed, { tickRate: WORLD_TICK_RATE });
  // Stamp the resumed time onto the engine now, so the first snapshots it emits
  // (before the coordinator announces its first round) already read at the resumed
  // clock rather than tick 0.
  engine.setClockTick(resumeClock);

  // 4. The in-process bus. Every backend service shares this one instance.
  const bus = new InProcessBus({ name: 'backend' });
  await bus.connect();

  // 4a. Engine <-> bus bridge. Subscribes (and wires the engine's lifecycle)
  //     BEFORE the engine emits its first `init` below.
  const transport: Transport = new RabbitMqTransport(engine, bus);
  await transport.start();

  // 4b. Daily-summary aggregator -> the Supervisor's `village.daily_summary`.
  const aggregator = new DailySummaryAggregator(bus);
  await aggregator.start();

  // 4c-pre. The rolling per-building activity log (in-memory). Started before the
  //     gateway so the gateway can serve its history endpoint from it.
  const buildingLog = new BuildingLog(bus);
  await buildingLog.start();

  // 4c-bis. Persist + serve villagers' social books. Started before the gateway so
  //     the gateway can answer GET /relationships from its write-through cache, and
  //     subscribed before the minds reflect so no nightly revision is missed.
  const relationshipTracker = new RelationshipTracker(bus, relationshipStore);
  await relationshipTracker.start();

  // 4c-ter. The shared-plan keeper: turns villagers' propose_plan / join_plan
  //     intents into live group agendas (work crews, prayer rituals). Started
  //     before the gateway so it can serve GET /group-plans, and before the minds
  //     act so no proposal is missed.
  const groupCoordinator = new GroupCoordinator(bus);
  await groupCoordinator.start();

  // 4c. The browser-facing WebSocket gateway. It also serves the read-only
  //     action-history, conversation, building-log, relationships, and
  //     group-plan endpoints.
  const gateway = new IngressGateway(
    bus,
    GATEWAY_WS_PORT,
    actions,
    conversations,
    buildingLog,
    relationshipTracker,
    groupCoordinator,
  );
  await gateway.start();

  // 4c-bis. Persist every villager action off the telemetry stream.
  const recorder = new ActionRecorder(bus, actions);
  await recorder.start();

  // 4d. The shared LLM engine, reached over HTTP. One client for the whole
  //     backend (decisions + reflection + embeddings all funnel through it).
  //     Every round-trip is mirrored onto the bus for the debug window.
  const llm = new HttpLLMClient({ monitor: new LlmEngineMonitor(bus) });

  // 4e. One mind per seeded villager. They share the bus, the LLM client, and a
  //     single vector store (memories isolate by villagerId, not by collection).
  //     The shared world bible is loaded ONCE and handed to every mind, so the long
  //     common prompt prefix is identical across villagers (cache-friendly).
  const bible = loadWorldBible();
  const store4mem = MEMORY_ENABLED ? new QdrantMemoryStore({ dimensions: llm.dimensions }) : null;

  // Seed each mind's SOCIAL BOOK from whatever was persisted, so opinions of
  // neighbours survive a restart. The roster (id + name of everyone) is shared by
  // all minds for the nightly relation pass; names come from the persona roster.
  const storedBooks = new Map((await relationshipStore.list()).map((b) => [b.villagerId, b.relationships]));
  const roster = () => profiles.map((p) => ({ id: p.id, name: p.name }));

  for (const profile of profiles) {
    const memory = store4mem
      ? new MemoryStream(profile.id, llm, store4mem, llm, { clock: new SimClock() })
      : undefined;
    const villager = new AgentService(bus, profile, llm, {
      thinkIntervalMs: THINK_INTERVAL_MS,
      coordinated: true, // think on a granted turn from the TurnCoordinator
      bible,
      planner: llm, // sketch a daily agenda each morning over the shared /complete seam
      relationships: new RelationshipBook(storedBooks.get(profile.id) ?? []),
      roster,
      ...(memory ? { memory } : {}),
    });
    await villager.start();
  }
  console.log(`[boot] ${profiles.length} villager mind(s) online`);

  // 4e-ter. The turn coordinator: the logical-tick clock. Started AFTER the minds
  //   are subscribed to their turn grants, so the first round reaches them. It
  //   serializes LLM use (one mind per grant) and enforces the post-action cooldown.
  const coordinator = new TurnCoordinator(bus, {
    roster: villagerIds,
    cooldownTicks: COOLDOWN_TICKS,
    turnTimeoutMs: Number(process.env.LLM_CLIENT_TIMEOUT_MS ?? 120_000) + 10_000,
    // A round lasts at least this long; if the round's LLM calls run longer, it
    // takes that long instead. Floor of 5s keeps a steady heartbeat. Tune via env.
    minRoundMs: Number(process.env.MIN_ROUND_MS ?? 5_000),
    // Resume the round clock from the last snapshot (the next round after it), so
    // in-world time continues across a restart instead of resetting to Day 1.
    startTick: resumeClock + 1,
  });
  await coordinator.start();

  // 4e-quater. Drive the in-world CLOCK from the round tick: each round the
  //   coordinator announces becomes the simulated time everyone reads. This is what
  //   keeps the date/time tied to ticks — it holds while a round waits on the LLM
  //   instead of racing ahead on the engine's free-running physics loop.
  await bus.subscribe<SimTickEvent>(EXCHANGES.simulation, 'sim.tick', (event) => {
    engine.setClockTick(event.payload.tick);
  });

  // 4e-bis. Collect villager speech into the rolling village chat, persist + push it live.
  const conversationTracker = new ConversationTracker(bus, conversations, {
    nameById: (id) => nameById.get(id) ?? id,
    maxLines: Number(process.env.CHAT_MAX_LINES ?? 200),
  });
  await conversationTracker.start();

  // 4f. The God Agent.
  const supervisor = new SupervisorService(bus, llm, {
    ...(SUPERVISOR_CHARTER ? { charter: SUPERVISOR_CHARTER } : {}),
    minDaysBetweenActs: SUPERVISOR_MIN_DAYS,
  });
  await supervisor.start();

  // 5. Snapshot persistence on a wall-clock interval. Fire-and-forget so a slow disk
  //    never stalls the simulation loop.
  const snapshotTimer = setInterval(() => {
    store.saveSnapshot(engine.getSnapshot()).catch((err) => {
      console.warn('[mongo] snapshot failed:', err);
    });
  }, SNAPSHOT_INTERVAL_MS);

  // 6. Run.
  engine.start();
  console.log(`[boot] backend running at ${engine.tickRate} ticks/s; WS on :${GATEWAY_WS_PORT}`);

  // Graceful shutdown: stop the loop, close sockets, flush a final snapshot.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[shutdown] received ${signal}, stopping...`);
    clearInterval(snapshotTimer);
    await coordinator.stop();
    engine.stop();
    await transport.stop();
    await gateway.stop();
    try {
      await store.saveSnapshot(engine.getSnapshot());
    } catch (err) {
      console.warn('[shutdown] final snapshot failed:', err);
    }
    await store.close();
    await actions.close();
    await conversations.close();
    await relationshipStore.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal] backend failed to start:', err);
  process.exit(1);
});
