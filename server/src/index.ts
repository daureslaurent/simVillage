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

import {
  EXCHANGES,
  type UserSetReasoningEffortEvent,
  type UserSetLlmModelEvent,
  type UserRefreshLlmModelsEvent,
  type UserGenerateWorldEvent,
  type UserPreviewStyleEvent,
  type UserResetWorldEvent,
  type UserGenerateWorldPayload,
  type WorldGeneratingPayload,
} from '../../shared/events';
import { InProcessBus, makeEvent } from '../../bus/EventBus';
import {
  DEFAULT_REASONING_EFFORT,
  isEffortPurpose,
  isReasoningEffort,
  type LlmModelConfig,
  type ReasoningEffortSettings,
  type VillageSize,
  type VillagerMemory,
  type VillagerPersona,
  type RivalSetupParams,
  type CompetitionIntensity,
  DEFAULT_COMPETITION_INTENSITY,
  DEFAULT_VILLAGE_ID,
  RIVAL_VILLAGE_ID,
} from '../../shared/types';
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
import { MongoRuntimeStateStore } from './persistence/MongoRuntimeStateStore';
import type { RuntimeStateStore } from './persistence/RuntimeStateStore';
import { MongoDailyReportStore } from './persistence/MongoDailyReportStore';
import type { DailyReportStore } from './persistence/DailyReportStore';
import { DailyReportRecorder } from './DailyReportRecorder';
import { RelationshipTracker } from './RelationshipTracker';
import { GroupCoordinator } from './GroupCoordinator';
import { AgendaCoordinator } from './AgendaCoordinator';
import { MomentCoordinator } from './MomentCoordinator';
import { BuildingLog } from './BuildingLog';
import { MindScheduler } from './MindScheduler';
import { MindRegistry } from './MindRegistry';
import { RabbitMqTransport } from './transport/RabbitMqTransport';
import type { Transport } from './transport/Transport';
import { DailySummaryAggregator } from './DailySummaryAggregator';
import { generateSeed, generateRivalSeed } from './world/seed';
import { generateWorldWithLLM, generateRivalWorldWithLLM, previewStyle } from './world/llmGenerate';
import { IngressGateway } from '../../gateway/src/IngressGateway';
import { SupervisorService } from '../../supervisor/src/SupervisorService';
import { SupervisorMemory, SUPERVISOR_OWNER } from '../../supervisor/src/SupervisorMemory';
import { loadProfiles, defaultProfile, type CharacterProfile } from '../../agent/src/profile';
import { loadWorldBible } from '../../agent/src/worldBible';
import { HttpLLMClient } from '../../agent/src/llm/HttpLLMClient';
import { LlmEngineMonitor } from './LlmEngineMonitor';
import { QdrantMemoryStore } from '../../agent/src/memory/QdrantMemoryStore';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/simvillage';

/** Clamp the master time-scale to a sane range, falling back to 1 on a bad value. */
function clampSpeed(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.max(0.1, Math.min(20, v)) : 1;
}
// MASTER TIME-SCALE for the whole simulation. SIM_SPEED > 1 runs EVERYTHING faster in
// lock-step — bodies move quicker (more physics ticks/sec), the in-world clock and so
// the needs/economy/weather advance sooner, and minds think more often — without
// changing the world's internal proportions (a raider still crosses the map in the
// same number of in-world seconds, needs still drift the same per in-world day). 1 =
// normal; 2 = twice as fast; 0.5 = half speed. Clamped to [0.1, 20].
const SIM_SPEED = clampSpeed(Number(process.env.SIM_SPEED ?? 1));

// How often to persist a world snapshot (wall-clock). The emitted tick is now the
// in-world clock (a round counter that holds during LLM waits), so snapshotting is
// paced by real time rather than a tick count.
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 15_000);
// The physics loop runs several times a second so bodies move smoothly; minds
// think far less often (paced by the scheduler), and a villager still covers a
// meaningful distance between thoughts so neighbours stay near long enough to
// interact. Tune via WORLD_TICK_RATE (ticks/second); scaled by SIM_SPEED so the
// physics keep pace with the in-world clock when the whole sim is sped up.
const WORLD_TICK_RATE = Number(process.env.WORLD_TICK_RATE ?? 3) * SIM_SPEED;
const GATEWAY_WS_PORT = Number(process.env.GATEWAY_WS_PORT ?? 8080);

const THINK_INTERVAL_MS = Number(process.env.VILLAGER_THINK_INTERVAL_MS ?? 12000) / SIM_SPEED;
// The in-world clock now advances on WALL TIME, not per LLM round, so time flows
// steadily no matter how many (or few) minds are thinking. One in-world tick
// (SIM_SECONDS_PER_TICK simulated seconds) elapses every this-many real ms;
// the 5s default keeps the same time-rate the old per-round clock had. Divided by
// SIM_SPEED so a sped-up sim reaches each in-world round proportionally sooner.
const SIM_TICK_REAL_MS = Number(process.env.SIM_TICK_REAL_MS ?? 5_000) / SIM_SPEED;
// A mind with nothing happening still thinks at least this often (the scheduler's
// idle heartbeat); stimuli interrupt sooner. Tune via VILLAGER_HEARTBEAT_MS; scaled
// down by SIM_SPEED so minds keep up with a faster-moving world.
const VILLAGER_HEARTBEAT_MS = Number(process.env.VILLAGER_HEARTBEAT_MS ?? 30_000) / SIM_SPEED;
const MEMORY_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.VILLAGER_MEMORY ?? '').trim().toLowerCase(),
);
// v3 — which BRAIN drives the villagers. `utility` swaps every villager onto the
// cheap rule-driven UtilityBrain (no LLM calls); anything else keeps the v2 LLM
// minds. The whole village runs in either mode (design §11, P1).
const VILLAGER_BRAIN: 'llm' | 'utility' =
  (process.env.VILLAGER_BRAIN ?? '').trim().toLowerCase() === 'utility' ? 'utility' : 'llm';
// v3 P5 (design §10) — start a TWO-village world: a home settlement + a rival, each its
// own god, for soft competition (raids). A dev/demo flag; only acts on a FRESH world.
const RIVAL_VILLAGE = ['1', 'true', 'yes', 'on'].includes(
  (process.env.RIVAL_VILLAGE ?? '').trim().toLowerCase(),
);
const SUPERVISOR_CHARTER = process.env.SUPERVISOR_CHARTER;
const SUPERVISOR_MIN_DAYS = Number(process.env.SUPERVISOR_MIN_DAYS_BETWEEN_ACTS ?? 1);
// LLM world generation. When there is NO world yet, the FRONTEND drives the choice:
// the player picks auto-generate (LLM) vs the classic static village, the style, the
// villager count and the size, on a first-run setup screen. The env vars now just
// shape that flow:
//   GENERATE_LLM   — whether the auto-generate option is offered at all (default on).
//   GENERATE_AUTO  — skip the setup screen and auto-generate HEADLESSLY with the env
//                    style/count (for dev/CI with no browser). Default off.
//   GENERATE_THEME — prefills the style field (and is the style used headless).
//   MAX_GENERATE_VILLAGERS — the villager-count ceiling (slider max).
const GENERATE_LLM = ['1', 'true', 'yes', 'on'].includes(
  (process.env.GENERATE_LLM ?? 'on').trim().toLowerCase(),
);
const GENERATE_AUTO = ['1', 'true', 'yes', 'on'].includes(
  (process.env.GENERATE_AUTO ?? '').trim().toLowerCase(),
);
const GENERATE_THEME = (process.env.GENERATE_THEME ?? '').trim();
const MAX_GENERATE_VILLAGERS = Math.max(1, Number(process.env.MAX_GENERATE_VILLAGERS ?? 6));
const GENERATE_RETRIES = Math.max(0, Number(process.env.GENERATE_RETRIES ?? 2));
const GENERATE_LLM_TIMEOUT_MS = Number(process.env.GENERATE_LLM_TIMEOUT_MS ?? 240_000);
/** Default villager count when the setup form first opens (and for headless). */
const DEFAULT_GENERATE_VILLAGERS = Math.min(5, MAX_GENERATE_VILLAGERS);
/** Where the generated roster + bible + theme are persisted, so a reboot reuses them. */
const GENERATED_WORLD_KEY = 'generated-world';

/** The generated personas/bible/theme persisted alongside an LLM-generated world. */
interface GeneratedWorldState {
  profiles: CharacterProfile[];
  bible: string;
  theme: string;
  setting: string;
  /**
   * Per-village bibles, keyed by villageId, for an LLM-generated TWO-village (rival)
   * world where each side is themed independently. Absent for a one-village world
   * (every mind shares the single `bible` above).
   */
  bibleByVillage?: Record<string, string>;
  /**
   * Each village's chosen RAID STANCE (competition intensity), keyed by villageId, so
   * a reboot re-applies it to that side's god. Absent for a one-village world.
   */
  intensityByVillage?: Record<string, CompetitionIntensity>;
}

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
  // Generic key/value store for LIVE service state that isn't part of the world
  // snapshot but must survive a restart: the god's cooldown + pending prayers, the
  // villagers' reflected-day watermarks, and the village's shared group plans.
  const runtimeState: RuntimeStateStore = new MongoRuntimeStateStore(MONGO_URL);
  await runtimeState.connect();
  // Append-only log of the god's nightly chronicles, so the summary window's
  // history survives a reboot (served read-only over GET /daily-reports).
  const dailyReports: DailyReportStore = new MongoDailyReportStore(MONGO_URL);
  await dailyReports.connect();

  // 1b. The bus + browser-facing gateway come up FIRST — before we (possibly) spend
  //     minutes generating a village with the LLM — so a browser can connect during
  //     the build and watch a live progress overlay (`world.generating`). None of
  //     these need the engine/seed; they only consume the bus + the read stores.
  const bus = new InProcessBus({ name: 'backend' });
  await bus.connect();

  // The rolling per-building activity log + the social/plan/agenda trackers the
  // gateway serves from. Started before the gateway (so it can answer their HTTP
  // endpoints) and harmlessly idle until the engine starts producing world events.
  const buildingLog = new BuildingLog(bus);
  await buildingLog.start();
  const relationshipTracker = new RelationshipTracker(bus, relationshipStore);
  await relationshipTracker.start();
  const groupCoordinator = new GroupCoordinator(bus, runtimeState);
  await groupCoordinator.start();
  const agendaCoordinator = new AgendaCoordinator(bus, runtimeState);
  await agendaCoordinator.start();

  // Static personas + the memory store reach the gateway through small mutable
  // holders: the gateway is built now (so it can serve during generation), but the
  // personas and vector store aren't resolved until the world boots below. The
  // readers close over these holders, so they answer correctly once populated.
  const personaById = new Map<string, VillagerPersona>();
  const personaReader = { get: (id: string): VillagerPersona | null => personaById.get(id) ?? null };
  const memoryRef: { store: QdrantMemoryStore | null } = { store: null };
  const memoryReader = {
    recent: async (id: string, limit: number): Promise<VillagerMemory[]> => {
      if (!memoryRef.store) return [];
      const records = await memoryRef.store.recent(id, { limit });
      return records.map((r) => ({
        id: r.id,
        text: r.text,
        kind: r.kind,
        importance: r.importance,
        timestamp: r.timestamp,
        ...(r.tick !== undefined ? { tick: r.tick } : {}),
      }));
    },
  };

  // The WebSocket gateway — listening now, so a browser that loads during generation
  // connects and receives the progress overlay instead of a dead socket.
  const gateway = new IngressGateway(
    bus,
    GATEWAY_WS_PORT,
    actions,
    conversations,
    buildingLog,
    relationshipTracker,
    groupCoordinator,
    dailyReports,
    agendaCoordinator,
    personaReader,
    memoryReader,
  );
  await gateway.start();

  /** Publish one generation-progress step to the browser (loading overlay). */
  const publishGenerating = (payload: WorldGeneratingPayload): void => {
    bus.publish(EXCHANGES.worldEvents, makeEvent('world.generating', payload));
  };

  // 1c. The generation LLM client — shared by the live style PREVIEW (during setup)
  //     and the full build. A control-plane client (no telemetry monitor); steered to
  //     'low' reasoning so the thinking model emits JSON rather than an essay.
  const genLlm = new HttpLLMClient({ timeoutMs: GENERATE_LLM_TIMEOUT_MS });
  genLlm.setEffort('plan', 'low');

  // The setup screen drives a one-shot choice: a Promise the `generate_world` command
  // resolves. `awaitSetupChoice` arms it; the command handler below fulfils it.
  let setupResolver: ((cmd: UserGenerateWorldPayload) => void) | null = null;
  const awaitSetupChoice = (): Promise<UserGenerateWorldPayload> =>
    new Promise((resolve) => {
      setupResolver = resolve;
    });

  // Setup control channel: the create/preview/reset commands from the browser. These
  // are `user.config.*` keys the engine's one-word `user.*` binding skips, so only the
  // backend handles them. Subscribed BEFORE world resolution so a choice made on the
  // setup screen is received while we wait.
  await bus.subscribe<UserGenerateWorldEvent | UserPreviewStyleEvent | UserResetWorldEvent>(
    EXCHANGES.userCommands,
    'user.config.*',
    async (event) => {
      if (event.type === 'user.config.generate_world') {
        setupResolver?.(event.payload);
        setupResolver = null;
        return;
      }
      if (event.type === 'user.config.preview_style') {
        // Best-effort live colour swatch for the setup screen.
        const { requestId, style } = event.payload;
        const preview = await previewStyle(genLlm, style);
        bus.publish(
          EXCHANGES.worldEvents,
          makeEvent('world.style_preview', { requestId, theme: preview.theme, palette: preview.palette }),
        );
        return;
      }
      if (event.type === 'user.config.reset_world') {
        // "New Village": wipe the world + its generated roster, then restart the
        // process. Under Docker `restart: unless-stopped` the backend comes straight
        // back up to an empty world and shows the setup screen again.
        console.log('[boot] reset requested — wiping world and restarting');
        try {
          await store.clear();
          await runtimeState.set(GENERATED_WORLD_KEY, null);
        } catch (err) {
          console.error('[boot] reset failed:', err);
        }
        // Give the bus a tick to flush, then exit for the supervisor to restart us.
        setTimeout(() => process.exit(0), 250);
        return;
      }
    },
  );

  /** Broadcast the first-run setup prompt to any connected (or future) browser. */
  const publishNeedsSetup = (): void => {
    bus.publish(
      EXCHANGES.worldEvents,
      makeEvent('world.needs_setup', {
        canAuto: GENERATE_LLM,
        defaultStyle: GENERATE_THEME,
        maxVillagers: MAX_GENERATE_VILLAGERS,
        defaultVillagers: DEFAULT_GENERATE_VILLAGERS,
        defaultSize: 'medium' as VillageSize,
        rival: RIVAL_VILLAGE,
      }),
    );
  };

  // 2. The world + its roster + bible. THREE moving parts that must line up: the
  //    seed (bodies), the personas (minds), and the shared world bible (grounding).
  //    How they're sourced depends on GENERATE_LLM and whether a world already
  //    exists — resolved together by `resolveWorld` below.
  //
  //    - classic (GENERATE_LLM=off): personas from villagers.json, bible from
  //      villagers.md, world from the hand-authored seed (generated if absent).
  //    - LLM (GENERATE_LLM=on): on a FIRST boot, the map, roster and bible are all
  //      generated with the LLM engine and persisted; a subsequent boot RESUMES the
  //      generated world and reloads its persisted roster/bible from runtime state.
  const world = await resolveWorld();
  let seed = world.seed;
  const profiles = world.profiles;
  const villagerIds = profiles.map((p) => p.id);
  // id -> display name, so conversations read with human names, not raw ids.
  const nameById = new Map(profiles.map((p) => [p.id, p.name] as const));
  // Surface each persona (identity, not live state) to the gateway's `/persona`
  // endpoint so the roster can show a villager's character. The appearance is for
  // the map, not this view, so it's intentionally dropped.
  for (const p of profiles) {
    personaById.set(p.id, {
      id: p.id,
      name: p.name,
      traits: p.traits,
      goal: p.goal,
      ...(p.backstory ? { backstory: p.backstory } : {}),
    });
  }

  /** The shape every world-source path returns: bodies + minds + grounding. */
  type ResolvedWorld = {
    seed: NonNullable<Awaited<ReturnType<typeof store.loadSeed>>>;
    profiles: CharacterProfile[];
    bible: string;
    theme?: string;
    setting?: string;
    /** Per-village bibles (LLM rival world); absent for a one-village world. */
    bibleByVillage?: Record<string, string>;
    /** Per-village raid stance (rival world); absent for a one-village world. */
    intensityByVillage?: Record<string, CompetitionIntensity>;
  };

  /**
   * Decide where this boot's world comes from:
   *   1. an EXISTING world in Mongo  -> resume it (generated roster/bible, or classic);
   *   2. no world + GENERATE_AUTO     -> headless auto-generation (dev/CI);
   *   3. no world (the normal case)   -> ask the FRONTEND (the setup screen) and build
   *      what the player chose (auto with a style/size/count, or the static village).
   */
  async function resolveWorld(): Promise<ResolvedWorld> {
    const existing = await store.loadSeed();
    const hasVillage =
      !!existing && Array.isArray(existing.villagers) && Array.isArray(existing.buildings);

    // 1. Resume an existing world.
    if (hasVillage) {
      const saved = await runtimeState.get<GeneratedWorldState>(GENERATED_WORLD_KEY);
      if (saved && saved.profiles?.length) {
        console.log(`[boot] resumed LLM-generated world from Mongo (theme: ${saved.theme || 'n/a'})`);
        return {
          seed: existing!,
          profiles: saved.profiles,
          bible: saved.bible ?? '',
          ...(saved.bibleByVillage ? { bibleByVillage: saved.bibleByVillage } : {}),
          ...(saved.intensityByVillage ? { intensityByVillage: saved.intensityByVillage } : {}),
          ...(existing!.theme ? { theme: existing!.theme } : {}),
          ...(existing!.setting ? { setting: existing!.setting } : {}),
        };
      }
      const fileProfiles = loadProfiles();
      const ids = fileProfiles.map((p) => p.id);
      const rosterMatches =
        existing!.villagers.length === ids.length &&
        ids.every((id) => existing!.villagers.some((v) => v.id === id));
      if (rosterMatches) return resumeClassic(existing!);
      console.warn('[boot] persisted world is incompatible with the current roster; starting fresh');
      // fall through to fresh setup
    }

    // 1b. No usable world + the rival flag: seed a TWO-village world (home + rival), each
    //     with its own roster + god, for v3 soft competition. Unlike the single-village
    //     path it ALWAYS asks the browser (the rival setup screen), so the player can pick
    //     a shared map theme plus independent per-side style/count/size/raid-stance.
    if (RIVAL_VILLAGE) {
      console.log('[boot] RIVAL_VILLAGE set — awaiting the rival setup choice from the browser');
      publishNeedsSetup();
      const choice = await awaitSetupChoice();
      return generateRivalFresh(choice);
    }

    // 2. No usable world + headless flag: auto-generate without a browser (dev/CI).
    if (GENERATE_AUTO && GENERATE_LLM) {
      console.log('[boot] GENERATE_AUTO set — generating headlessly with the LLM');
      return autoGenerate({ style: GENERATE_THEME, villagers: DEFAULT_GENERATE_VILLAGERS, size: 'medium' });
    }

    // 3. Ask the frontend. The gateway caches `world.needs_setup`, so a browser that
    //    connects later still gets the prompt; we block here until the player chooses.
    console.log('[boot] no world yet — awaiting the setup choice from the browser');
    publishNeedsSetup();
    const choice = await awaitSetupChoice();
    if (choice.mode === 'static' || !GENERATE_LLM) {
      console.log('[boot] setup: static village chosen');
      return generateClassicFresh();
    }
    console.log(
      `[boot] setup: auto-generate (style: ${choice.style || 'model-invented'}, ${choice.villagers ?? DEFAULT_GENERATE_VILLAGERS} villagers, size: ${choice.size ?? 'medium'})`,
    );
    return autoGenerate({
      style: (choice.style ?? '').trim(),
      villagers: choice.villagers,
      size: choice.size ?? 'medium',
    });
  }

  /**
   * Generate a village with the LLM, persist it, and stream progress to the overlay.
   * Falls back to the classic village if generation fails after its retries, so the
   * simulation always comes up.
   */
  async function autoGenerate(opts: { style: string; villagers?: number; size: VillageSize }): Promise<ResolvedWorld> {
    try {
      const generated = await generateWorldWithLLM(genLlm, (i) => `villager_${i + 1}`, {
        theme: opts.style,
        maxVillagers: MAX_GENERATE_VILLAGERS,
        ...(opts.villagers !== undefined ? { villagers: opts.villagers } : {}),
        size: opts.size,
        retries: GENERATE_RETRIES,
        onProgress: (s) => publishGenerating(s),
      });
      // Tell the overlay the build is done; `world.init` follows once the engine is up.
      publishGenerating({ phase: 'assembling', label: 'The village is ready', done: true });
      await store.saveSeed(generated.seed);
      await runtimeState.set<GeneratedWorldState>(GENERATED_WORLD_KEY, {
        profiles: generated.profiles,
        bible: generated.bible,
        theme: generated.theme,
        setting: generated.setting,
      });
      console.log(
        `[boot] generated village "${generated.theme}": ${generated.seed.buildings.length} buildings, ${generated.profiles.length} villagers.`,
      );
      return {
        seed: generated.seed,
        profiles: generated.profiles,
        bible: generated.bible,
        theme: generated.theme,
        setting: generated.setting,
      };
    } catch (err) {
      console.error(
        `[boot] LLM generation failed (${err instanceof Error ? err.message : String(err)}); falling back to the classic village`,
      );
      return generateClassicFresh();
    }
  }

  /** Resume an existing classic world with file-sourced personas + bible. */
  function resumeClassic(
    existing: NonNullable<Awaited<ReturnType<typeof store.loadSeed>>>,
  ): { seed: typeof existing; profiles: CharacterProfile[]; bible: string } {
    console.log('[boot] resumed world from Mongo');
    return { seed: existing, profiles: loadProfiles(), bible: loadWorldBible() };
  }

  /**
   * Seed a fresh TWO-village world (v3 P5). With the LLM generator on (GENERATE_LLM,
   * the default) each side is GENERATED — its own themed map, roster and bible — and
   * the rival is themed as the home's contrasting neighbour. Falls back to the
   * fixed-blueprint rival villages if generation fails (so the demo always comes up).
   */
  /** Clamp a chosen villager count into [1, MAX_GENERATE_VILLAGERS]. */
  function clampVillagers(n: number): number {
    return Math.max(1, Math.min(MAX_GENERATE_VILLAGERS, Math.round(n)));
  }

  /** The per-village raid stances from the setup choice, defaulting to balanced. */
  function rivalIntensities(rival: RivalSetupParams | undefined): Record<string, CompetitionIntensity> {
    return {
      [DEFAULT_VILLAGE_ID]: rival?.home.intensity ?? DEFAULT_COMPETITION_INTENSITY,
      [RIVAL_VILLAGE_ID]: rival?.rival.intensity ?? DEFAULT_COMPETITION_INTENSITY,
    };
  }

  async function generateRivalFresh(choice: UserGenerateWorldPayload): Promise<ResolvedWorld> {
    const rival = choice.rival;
    if (choice.mode !== 'static' && GENERATE_LLM) {
      try {
        return await generateRivalWithLLM(rival);
      } catch (err) {
        console.error(
          `[boot] LLM rival generation failed (${err instanceof Error ? err.message : String(err)}); ` +
            'falling back to the fixed-blueprint rival villages',
        );
      }
    }
    console.log('[boot] setup: classic (fixed-blueprint) rival villages chosen');
    return generateRivalClassic(rival);
  }

  /**
   * Generate BOTH villages with the LLM, persist the combined roster + per-village
   * bibles, and stream progress to the overlay. Headless (env-driven), like the
   * single-village auto path — the rival flag precedes the setup screen.
   */
  async function generateRivalWithLLM(rival: RivalSetupParams | undefined): Promise<ResolvedWorld> {
    const homeParams = rival?.home ?? {};
    const rivalParams = rival?.rival ?? {};
    const generated = await generateRivalWorldWithLLM(
      genLlm,
      (i) => `villager_${i + 1}`,
      (i) => `rival_${i + 1}`,
      {
        mapTheme: (rival?.mapTheme ?? GENERATE_THEME).trim(),
        maxVillagers: MAX_GENERATE_VILLAGERS,
        retries: GENERATE_RETRIES,
        onProgress: (s) => publishGenerating(s),
        home: {
          ...(homeParams.style ? { style: homeParams.style } : {}),
          villagers: homeParams.villagers ?? DEFAULT_GENERATE_VILLAGERS,
          size: homeParams.size ?? 'medium',
        },
        rival: {
          ...(rivalParams.style ? { style: rivalParams.style } : {}),
          villagers: rivalParams.villagers ?? DEFAULT_GENERATE_VILLAGERS,
          size: rivalParams.size ?? 'medium',
        },
      },
    );
    publishGenerating({ phase: 'assembling', label: 'The two villages are ready', done: true });
    await store.saveSeed(generated.seed);
    const profiles = [...generated.home.profiles, ...generated.rival.profiles];
    const bibleByVillage: Record<string, string> = {
      [DEFAULT_VILLAGE_ID]: generated.home.bible,
      [RIVAL_VILLAGE_ID]: generated.rival.bible,
    };
    await runtimeState.set<GeneratedWorldState>(GENERATED_WORLD_KEY, {
      profiles,
      bible: generated.home.bible,
      bibleByVillage,
      theme: generated.home.theme,
      setting: generated.home.setting,
      intensityByVillage: rivalIntensities(rival),
    });
    console.log(
      `[boot] generated two LLM villages: "${generated.home.theme}" (home, ${generated.home.profiles.length}) ` +
        `vs "${generated.rival.theme}" (rival, ${generated.rival.profiles.length}); ${generated.seed.buildings.length} buildings`,
    );
    return {
      seed: generated.seed,
      profiles,
      bible: generated.home.bible,
      bibleByVillage,
      intensityByVillage: rivalIntensities(rival),
      theme: generated.home.theme,
      setting: generated.home.setting,
    };
  }

  /**
   * Seed a fresh TWO-village world from the FIXED blueprint (the fallback when the LLM
   * generator is off or fails). The home village reuses the file roster (stamped
   * village_0); the rival gets a deterministic roster of the same size (stamped
   * village_1). Both rosters + the shared bible are persisted under the generated-world
   * key so a reboot RESUMES the two villages (the file roster alone wouldn't match the
   * doubled-up world).
   */
  async function generateRivalClassic(rival: RivalSetupParams | undefined): Promise<ResolvedWorld> {
    // Honour the per-side villager counts from the setup screen (classic ignores the
    // styles/sizes/stances). Clamp to the ceiling; default to the file roster's size.
    const fileRoster = loadProfiles();
    const homeCount = clampVillagers(rival?.home.villagers ?? fileRoster.length);
    const rivalCount = clampVillagers(rival?.rival.villagers ?? fileRoster.length);

    // Home keeps the hand-authored personas, trimmed or padded to the chosen count.
    const homeProfiles: CharacterProfile[] = Array.from({ length: homeCount }, (_, i) => {
      const id = `villager_${i + 1}`;
      const base = fileRoster[i] ?? defaultProfile(id);
      return { ...base, id, villageId: DEFAULT_VILLAGE_ID };
    });
    // A rival roster of the chosen size — deterministic ids/personas, no LLM needed.
    const rivalTraits = ['proud', 'industrious', 'wary'];
    const rivalProfiles: CharacterProfile[] = Array.from({ length: rivalCount }, (_, i) => ({
      ...defaultProfile(`rival_${i + 1}`),
      name: `Rival ${i + 1}`,
      traits: rivalTraits,
      goal: 'Make your village outgrow the rivals across the valley.',
      villageId: RIVAL_VILLAGE_ID,
    }));
    const seed = generateRivalSeed(
      homeProfiles.map((p) => p.id),
      rivalProfiles.map((p) => p.id),
    );
    const profiles = [...homeProfiles, ...rivalProfiles];
    const bible = loadWorldBible();
    await store.saveSeed(seed);
    // Persist the combined roster so the resume path (step 1) rebuilds both villages.
    await runtimeState.set<GeneratedWorldState>(GENERATED_WORLD_KEY, {
      profiles,
      bible,
      theme: 'Two Villages',
      setting: 'A home settlement and a rival share one valley, each with its own god.',
      intensityByVillage: rivalIntensities(rival),
    });
    console.log(
      `[boot] seeded two villages: ${homeProfiles.length} home + ${rivalProfiles.length} rival ` +
        `villagers, ${seed.buildings.length} buildings`,
    );
    return { seed, profiles, bible, intensityByVillage: rivalIntensities(rival) };
  }

  /** Seed a fresh classic village (hand-authored layout + file personas/bible). */
  async function generateClassicFresh(): Promise<{
    seed: NonNullable<Awaited<ReturnType<typeof store.loadSeed>>>;
    profiles: CharacterProfile[];
    bible: string;
  }> {
    const fileProfiles = loadProfiles();
    const fresh = generateSeed({ villagerIds: fileProfiles.map((p) => p.id) });
    await store.saveSeed(fresh);
    console.log(`[boot] generated and persisted a fresh village (${fresh.buildings.length} buildings)`);
    return { seed: fresh, profiles: fileProfiles, bible: loadWorldBible() };
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

  // 3. The pure engine, built from the (now resolved/generated) seed. The bus and
  //    gateway are already up (see step 1b), so the `world.init` the transport
  //    publishes below reaches any browser that was watching the generation overlay.
  const engine = new WorldEngine(seed, { tickRate: WORLD_TICK_RATE });
  // Stamp the resumed time onto the engine now, so the first snapshots it emits
  // (before the coordinator announces its first round) already read at the resumed
  // clock rather than tick 0.
  engine.setClockTick(resumeClock);

  // 4a. Engine <-> bus bridge. Subscribes (and wires the engine's lifecycle)
  //     BEFORE the engine emits its first `init` below.
  const transport: Transport = new RabbitMqTransport(engine, bus);
  await transport.start();

  // 4b. Daily-summary aggregator -> the Supervisor's `village.daily_summary`.
  const aggregator = new DailySummaryAggregator(bus);
  await aggregator.start();

  // 4c-bis. Persist every villager action off the telemetry stream.
  const recorder = new ActionRecorder(bus, actions);
  await recorder.start();

  // 4c-quater. Persist the god's nightly chronicles off the village stream, so the
  //   summary window's history survives a reboot.
  const reportRecorder = new DailyReportRecorder(bus, dailyReports);
  await reportRecorder.start();

  // 4d. The shared LLM engine, reached over HTTP. One client for the whole
  //     backend (decisions + reflection + embeddings all funnel through it).
  //     Every round-trip is mirrored onto the bus for the debug window.
  const llm = new HttpLLMClient({ monitor: new LlmEngineMonitor(bus) });

  // 4d-bis. REASONING EFFORT — how hard the model is asked to think, per call
  //   purpose (decide / supervisor / reflect / plan). A pure prompt lever owned by
  //   the LLM client; the human tunes it from the Settings window. Restore the saved
  //   levels so a reboot resumes at the same effort, apply them, and broadcast the
  //   live config so the (already-subscribed) gateway can mirror it to every browser.
  const EFFORT_KEY = 'reasoning-effort';
  const savedEffort = (await runtimeState.get<Partial<ReasoningEffortSettings>>(EFFORT_KEY)) ?? {};
  const effort: ReasoningEffortSettings = { ...DEFAULT_REASONING_EFFORT, ...savedEffort };
  for (const purpose of ['decide', 'supervisor', 'reflect', 'plan'] as const) {
    llm.setEffort(purpose, effort[purpose]);
  }
  const broadcastEffort = (): void => {
    bus.publish(EXCHANGES.engineTelemetry, makeEvent('engine.reasoning_effort', { settings: llm.getEffort() }));
  };
  // Apply one operator change from the Settings window: update the client, persist the
  // full config, and re-broadcast so every open tab reflects it. Multi-word key the
  // engine's `user.*` binding skips; only the backend handles `user.config.*`.
  await bus.subscribe<UserSetReasoningEffortEvent>(
    EXCHANGES.userCommands,
    'user.config.*',
    (event) => {
      if (event.type !== 'user.config.set_reasoning_effort') return;
      const { purpose, level } = event.payload;
      if (!isEffortPurpose(purpose) || !isReasoningEffort(level)) return;
      llm.setEffort(purpose, level);
      console.log(`[boot] reasoning effort: ${purpose} -> ${level}`);
      void runtimeState.set(EFFORT_KEY, llm.getEffort());
      broadcastEffort();
    },
  );
  // Announce the restored/default config now that the gateway is listening.
  broadcastEffort();
  console.log(`[boot] reasoning effort: ${JSON.stringify(llm.getEffort())}`);

  // 4d-ter. LLM MODEL — which chat model the engine thinks with. Owned by the
  //   engine (it sits next to the llama server); the backend persists the operator's
  //   choice and re-applies it on reboot, and mirrors the live config (current + the
  //   models discovered from the backend) to every browser, exactly like effort above.
  const MODEL_KEY = 'llm-model';
  const broadcastModel = async (): Promise<LlmModelConfig> => {
    const config = await llm.getModelConfig();
    bus.publish(EXCHANGES.engineTelemetry, makeEvent('engine.llm_model', { config }));
    return config;
  };
  // Push the LLM POOL shape (endpoints + live busy flags) so the engine window can
  // show what's spread across which server. Polled on a short interval since the
  // busy flags are real-time and live in the (separate) engine process.
  const broadcastPool = async (): Promise<void> => {
    bus.publish(EXCHANGES.engineTelemetry, makeEvent('engine.llm_pool', { config: await llm.getPool() }));
  };
  // Re-apply the persisted choice so a reboot resumes on the same model. Best-effort:
  // if the engine/llama server isn't reachable yet, log and carry on — the operator's
  // next change (or a Settings-window refresh) re-syncs it.
  const savedModel = await runtimeState.get<string>(MODEL_KEY);
  if (savedModel) {
    try {
      await llm.setModel(savedModel);
    } catch (err) {
      console.warn(`[boot] could not restore llm model "${savedModel}":`, err);
    }
  }
  await bus.subscribe<UserSetLlmModelEvent | UserRefreshLlmModelsEvent>(
    EXCHANGES.userCommands,
    'user.config.*',
    (event) => {
      if (event.type === 'user.config.set_llm_model') {
        const { model } = event.payload;
        if (typeof model !== 'string' || !model) return;
        void (async () => {
          try {
            await llm.setModel(model);
            await runtimeState.set(MODEL_KEY, model);
            console.log(`[boot] llm model -> ${model}`);
          } catch (err) {
            console.warn(`[boot] could not switch llm model to "${model}":`, err);
          }
          await broadcastModel();
        })();
        return;
      }
      if (event.type === 'user.config.refresh_llm_models') {
        // Re-discover the backend's models (e.g. one that came online after boot).
        void broadcastModel();
      }
    },
  );
  // Announce the current model + discovered list now that the gateway is listening.
  const modelConfig = await broadcastModel();
  console.log(`[boot] llm model: ${modelConfig.current || '(unknown)'} (${modelConfig.available.length} available)`);
  // Announce the pool now, then keep it fresh so the engine window's busy flags stay live.
  await broadcastPool();
  const poolTimer = setInterval(() => {
    void broadcastPool();
  }, Number(process.env.LLM_POOL_BROADCAST_MS ?? 1_500));

  // 4e. The minds. Every villager shares the bus, the LLM client (now a parallel
  //     endpoint pool), and a single vector store (memories isolate by villagerId).
  //     The shared world bible is resolved ONCE (from villagers.md in classic mode,
  //     or the LLM-generated themed bible) and handed to every mind, so the long
  //     common prompt prefix is identical across villagers (cache-friendly).
  const bible = world.bible;
  // For an LLM-generated TWO-village world each side has its OWN themed bible; resolve
  // per villager by its villageId, falling back to the shared bible. One-village worlds
  // hand the single string to every mind unchanged.
  const bibleByVillage = world.bibleByVillage;
  const bibleFor: string | ((villageId: string | undefined) => string) = bibleByVillage
    ? (villageId: string | undefined) => bibleByVillage[villageId ?? DEFAULT_VILLAGE_ID] ?? bible
    : bible;
  const store4mem = MEMORY_ENABLED ? new QdrantMemoryStore({ dimensions: llm.dimensions }) : null;
  // Hand the live store to the gateway's `/memories` reader, declared up top.
  memoryRef.store = store4mem;
  // Seed each mind's SOCIAL BOOK from whatever was persisted, so opinions of
  // neighbours survive a restart.
  const storedBooks = new Map((await relationshipStore.list()).map((b) => [b.villagerId, b.relationships]));

  // 4e-bis. The scheduler — who thinks, when, and how many at once. Its parallel
  //   capacity is the LLM pool's (= number of endpoints), so adding endpoints lets
  //   more minds think simultaneously. Started AFTER the minds subscribe to grants.
  const pool = await llm.getPool();
  const scheduler = new MindScheduler(bus, {
    capacity: pool.capacity,
    idleHeartbeatMs: VILLAGER_HEARTBEAT_MS,
    turnTimeoutMs: Number(process.env.LLM_CLIENT_TIMEOUT_MS ?? 120_000) + 10_000,
  });

  // 4e-ter. The registry gives every body a brain — the seeded personas now, and
  //   any villager spawned later (a God-made "Newcomer" comes alive on its own).
  const registry = new MindRegistry(bus, llm, scheduler, {
    bible: bibleFor,
    memoryStore: store4mem,
    runtimeState,
    storedBooks,
    profilesById: new Map(profiles.map((p) => [p.id, p])),
    thinkIntervalMs: THINK_INTERVAL_MS,
    villagerBrain: VILLAGER_BRAIN,
  });
  console.log(
    `[server] villager brain: ${VILLAGER_BRAIN}` +
      (VILLAGER_BRAIN === 'utility' ? ' (v3 rule-driven — no villager LLM calls)' : ' (per-villager LLM)'),
  );
  await registry.start(villagerIds);
  await scheduler.start();

  // 4e-quinquies. v3 P4 — the rare villager-LLM MOMENT budget (design §7). Only meaningful
  //   under the utility brain (LLM minds already speak for themselves and ignore moments):
  //   it hands a single real LLM turn to one villager on a notable beat (a crisis, the god's
  //   whisper), then they drop back to the cheap brain. Started AFTER the minds subscribe to
  //   `village.moment`, so a moment is never published before a villager can hear it.
  if (VILLAGER_BRAIN === 'utility') {
    const moments = new MomentCoordinator(bus);
    await moments.start();
  }

  // 4e-quater. The in-world CLOCK on WALL TIME: one tick every SIM_TICK_REAL_MS,
  //   resumed from the last snapshot, so simulated time flows steadily regardless of
  //   how many minds are thinking (it no longer waits on LLM rounds). The engine
  //   stamps this tick onto every world snapshot the village reads.
  let clockTick = resumeClock;
  const clockTimer = setInterval(() => {
    clockTick += 1;
    engine.setClockTick(clockTick);
  }, SIM_TICK_REAL_MS);

  // 4e-bis. Collect villager speech into the rolling village chat, persist + push it live.
  const conversationTracker = new ConversationTracker(bus, conversations, {
    nameById: (id) => nameById.get(id) ?? id,
    maxLines: Number(process.env.CHAT_MAX_LINES ?? 200),
  });
  await conversationTracker.start();

  // 4f. The God Agent. v3 P4 — when long-term memory is enabled, the god gets a
  //   hippocampus of its own: the SAME Qdrant store the villagers use (memories
  //   isolate by owner id, so the god's strategy lives under a synthetic owner that
  //   can't collide with a villager). The LLM client doubles as the embedder and the
  //   synthesizer for the nightly strategy. Under the utility brain the villagers no
  //   longer recall from this store, so the memory has, in effect, moved UP to the god.
  //   v3 P5 (design §10) — one god PER village. The seam is keyed off entity villageIds:
  //   gather the distinct villages present in the world and bring up a SupervisorService for
  //   each, every god scoped (state / durable queue / steer broadcasts) to its own village and
  //   given its own namespaced long-term memory so two gods never recall each other's strategy.
  //   With a single village this is exactly one god — unchanged behaviour.
  const villageIds = [...new Set(seed.villagers.map((v) => v.villageId ?? DEFAULT_VILLAGE_ID))];
  const supervisors: SupervisorService[] = [];
  for (const villageId of villageIds) {
    const supervisorMemory = store4mem
      ? new SupervisorMemory(llm, store4mem, llm, {
          // The home village keeps the original owner id (back-compat); a rival is namespaced.
          ...(villageId === DEFAULT_VILLAGE_ID ? {} : { ownerId: `${SUPERVISOR_OWNER}:${villageId}` }),
        })
      : undefined;
    // The raid stance chosen at setup for this side (rival worlds only); shapes how
    // readily this god raids. Only meaningful with a rival present.
    const competitionIntensity = world.intensityByVillage?.[villageId];
    const supervisor = new SupervisorService(bus, llm, {
      villageId,
      ...(SUPERVISOR_CHARTER ? { charter: SUPERVISOR_CHARTER } : {}),
      ...(competitionIntensity ? { competitionIntensity } : {}),
      minDaysBetweenActs: SUPERVISOR_MIN_DAYS,
      // Remember the god's cooldown + pending prayers across a restart.
      state: runtimeState,
      // The free-text seam the god uses to author the nightly chronicle.
      chronicler: llm,
      // The god's long-term memory of past days + the strategy distilled from them.
      ...(supervisorMemory ? { memory: supervisorMemory } : {}),
    });
    await supervisor.start();
    supervisors.push(supervisor);
  }
  console.log(`[boot] ${supervisors.length} supervisor(s) online for village(s): ${villageIds.join(', ')}`);

  // 5. Snapshot persistence on a wall-clock interval. Fire-and-forget so a slow disk
  //    never stalls the simulation loop.
  const snapshotTimer = setInterval(() => {
    store.saveSnapshot(engine.getSnapshot()).catch((err) => {
      console.warn('[mongo] snapshot failed:', err);
    });
  }, SNAPSHOT_INTERVAL_MS);

  // 6. Run.
  engine.start();
  console.log(
    `[boot] backend running at ${engine.tickRate} ticks/s` +
      (SIM_SPEED !== 1 ? ` (SIM_SPEED ${SIM_SPEED}×; round every ${Math.round(SIM_TICK_REAL_MS)}ms)` : '') +
      `; WS on :${GATEWAY_WS_PORT}`,
  );

  // Graceful shutdown: stop the loop, close sockets, flush a final snapshot.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[shutdown] received ${signal}, stopping...`);
    clearInterval(snapshotTimer);
    clearInterval(clockTimer);
    clearInterval(poolTimer);
    scheduler.stop();
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
    await runtimeState.close();
    await dailyReports.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal] backend failed to start:', err);
  process.exit(1);
});
