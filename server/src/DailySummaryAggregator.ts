/**
 * server/src/DailySummaryAggregator.ts
 * ---------------------------------------------------------------------------
 * Final Phase — the feed for the "God Agent".
 *
 * The Supervisor reasons one village-day at a time, but the bus only carries
 * fine-grained per-tick world state and per-action intents. This small service
 * bridges that gap: it tallies the day's activity off the existing streams and,
 * at each day boundary, rolls the tallies up into a `village.daily_summary` on
 * `village.events` — then resets and starts the next day.
 *
 * v3 (rival-village seam, design §10): everything is tallied PER village. Each
 * villager/building carries a `villageId`; the aggregator groups by it and emits
 * ONE summary per village, each carrying that village's own digest + a fog-of-war
 * {@link RivalDigest} of the largest OTHER village. With a single village this is
 * exactly one summary tagged {@link DEFAULT_VILLAGE_ID} with no rival — unchanged.
 *
 * It is a pure bus citizen and holds no authoritative state (the engine remains
 * the source of truth). "A day" follows the shared sim clock, so the god's notion
 * of a day matches the villagers'.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type { VillagerIntentEvent, WorldEvent, SupervisorQueryEvent, SupervisorQueryKind } from '../../shared/events';
import type {
  WeatherKind,
  Villager,
  BuildingStock,
  ResourceKind,
  VillagerNeeds,
  WorldDigestVitals,
  NeedStat,
  BuildingKind,
  DigestEvent,
  DigestEventKind,
  DigestEventSalience,
  RivalDigest,
  VillageScore,
  VillageScoreboard,
} from '../../shared/types';
import { RESOURCE_KINDS, DEFAULT_VILLAGE_ID } from '../../shared/types';
import { buildingStockKinds } from '../../shared/buildings';
import { simTimeFromTick } from '../../shared/simClock';

/** How many recent utterances to carry into a summary as colour. */
const MAX_QUOTES = 5;

/** How many of the day's prayers to carry into a summary for the god to weigh. */
const MAX_PRAYERS = 5;

/** How many of the day's finished structures to carry into a summary. */
const MAX_BUILDS = 8;

/** Most events to retain between summaries, so a turbulent day can't grow it unbounded. */
const MAX_EVENTS = 12;

/**
 * One village's per-day tallies, reset at every day boundary. The aggregator holds
 * one of these per `villageId` it has seen, so a rival village's day is summarised
 * entirely separately from the home village's.
 */
interface VillageTally {
  conversations: number;
  movements: number;
  active: Set<string>;
  quotes: string[];
  prayers: string[];
  /** Structures this village finished this day (one human line each). */
  completedBuilds: string[];
  /** Salient events detected for this village since its last summary, oldest first. */
  eventsSinceSummary: DigestEvent[];
}

export class DailySummaryAggregator {
  /** The day currently being tallied; -1 until the first tick arrives. */
  private currentDay = -1;
  private weather: WeatherKind = 'clear';

  /** Per-village day tallies, keyed by villageId. Reset at every day boundary. */
  private tallies = new Map<string, VillageTally>();

  /** Building id -> kind, learned from `world.init`, so per-tick stocks group by kind. */
  private readonly buildingKinds = new Map<string, string>();
  /** Building id -> owning villageId, learned from `world.init` (re-announced on spawn). */
  private readonly buildingVillage = new Map<string, string>();
  /** Villager id -> owning villageId, rebuilt from each snapshot (for routing intents). */
  private readonly villagerVillage = new Map<string, string>();
  /** The latest villager snapshot (for the v3 needs digest); replaced each tick. */
  private latestVillagers: Villager[] = [];
  /** The latest per-building stock snapshot (for the v3 stocks/buildings digest). */
  private latestStocks: BuildingStock[] = [];

  /** A stocked building below this many total units counts as "running low" in the digest. */
  private static readonly LOW_STOCK = 5;

  /**
   * Conditions currently "firing", so an event triggers once on the rising edge and
   * re-arms only after the condition clears (hysteresis). Keyed by a village-qualified
   * condition id (e.g. "famine:hunger:village_0"), so each village has its own band.
   */
  private readonly activeConditions = new Set<string>();
  /** Population last snapshot, per village, to spot a NEWCOMER (the count rose). */
  private readonly lastPopulation = new Map<string, number>();
  /** Last tick a raid woke a village's god, per victim village — throttles raid alerts. */
  private readonly lastRaidAlert = new Map<string, number>();
  /** Running raids INFLICTED on rivals, per village — the offensive half of the defense score. */
  private readonly raidsInflicted = new Map<string, number>();
  /** Running raids SUFFERED from rivals, per village — the defensive half of the defense score. */
  private readonly raidsSuffered = new Map<string, number>();

  /** Latest sim tick seen (for stamping the real-time pulse digest). */
  private lastTick = 0;
  /** Wall-clock heartbeat that emits a live digest between day rollovers. */
  private pulseTimer?: ReturnType<typeof setInterval>;
  /** Real-time gap between heartbeat pulses (ms). */
  private static readonly PULSE_MS = Math.max(
    20_000,
    Number(process.env.SUPERVISOR_PULSE_MS ?? 120_000),
  );

  constructor(private readonly bus: EventBus) {}

  async start(): Promise<void> {
    // Tally the day's intents. Its OWN durable queue (distinct from the engine's)
    // so it sees every action without competing for the engine's copy.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.*',
      (event) => this.onIntent(event),
      { queue: 'aggregator.villager.intents', durable: true },
    );

    // Watch the world clock + population + weather. Exclusive queue: a restarted
    // aggregator wants only fresh ticks, not a backlog.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.*', (event) =>
      this.onWorld(event),
    );

    // The agentic god's live LOOKUPS: it asks this read-model questions mid-deliberation
    // (`supervisor.query` on the supervisor channel — the engine + gateway safely ignore the
    // unknown key) and we answer from the snapshot we already hold. Exclusive queue: a query
    // is answered live, never replayed from a backlog after a restart.
    await this.bus.subscribe<SupervisorQueryEvent>(
      EXCHANGES.supervisorCommands,
      'supervisor.query',
      (event) => this.onQuery(event),
    );

    // v3 — a real-time HEARTBEAT so the god steers several times an hour, not once per
    // ~40-minute in-game day. Emits a live per-village digest as `village.pulse`, which
    // the supervisor folds into an out-of-cadence policy/order nudge (no day bookkeeping).
    this.pulseTimer = setInterval(() => this.publishPulses(), DailySummaryAggregator.PULSE_MS);
    this.pulseTimer.unref?.(); // a heartbeat must not keep the process alive on its own

    console.log(
      `[aggregator] online; per-village digests on the sim clock + a ${Math.round(DailySummaryAggregator.PULSE_MS / 1000)}s heartbeat pulse`,
    );
  }

  /**
   * Emit a real-time digest for every village WITHOUT advancing the day. Built from the
   * live snapshot the aggregator already holds, so the god reasons on current vitals.
   * Best-effort: skipped until the first snapshot has populated the villager roster.
   */
  private publishPulses(): void {
    if (this.latestVillagers.length === 0) return;
    const byVillage = this.villagersByVillage();
    const stocksByVillage = this.stocksByVillage();
    const day = simTimeFromTick(this.lastTick).day;
    for (const [villageId, villagers] of byVillage) {
      if (villagers.length === 0) continue;
      const stocks = stocksByVillage.get(villageId) ?? [];
      const bucket = this.tally(villageId);
      this.bus.publish(
        EXCHANGES.villageEvents,
        makeEvent('village.pulse', {
          villageId,
          day,
          tick: this.lastTick,
          population: villagers.length,
          conversations: bucket.conversations,
          movements: bucket.movements,
          idleVillagers: Math.max(0, villagers.length - bucket.active.size),
          weather: this.weather,
          digest: this.buildDigest(villagers, stocks, villageId, byVillage),
        }),
      );
    }
    // One head-to-head scoreboard alongside the per-village pulses, so the HUD's
    // competition chip updates several times an hour, not just at day's end.
    this.publishScoreboard(byVillage, day, this.lastTick);
  }

  // -------------------------------------------------------------------------
  // Per-village bookkeeping helpers
  // -------------------------------------------------------------------------

  /** The village a villager belongs to (from the latest snapshot), or the default. */
  private villageOfVillager(villagerId: string): string {
    return this.villagerVillage.get(villagerId) ?? DEFAULT_VILLAGE_ID;
  }

  /** The village a building belongs to (learned at world.init), or the default. */
  private villageOfBuilding(buildingId: string): string {
    return this.buildingVillage.get(buildingId) ?? DEFAULT_VILLAGE_ID;
  }

  /** Get (or create) the running tally bucket for a village. */
  private tally(villageId: string): VillageTally {
    let bucket = this.tallies.get(villageId);
    if (!bucket) {
      bucket = {
        conversations: 0,
        movements: 0,
        active: new Set<string>(),
        quotes: [],
        prayers: [],
        completedBuilds: [],
        eventsSinceSummary: [],
      };
      this.tallies.set(villageId, bucket);
    }
    return bucket;
  }

  /** Group the latest villager snapshot by owning village. */
  private villagersByVillage(): Map<string, Villager[]> {
    const map = new Map<string, Villager[]>();
    for (const v of this.latestVillagers) {
      const id = v.villageId ?? DEFAULT_VILLAGE_ID;
      (map.get(id) ?? map.set(id, []).get(id)!).push(v);
    }
    return map;
  }

  /** Group the latest per-building stock snapshot by owning village. */
  private stocksByVillage(): Map<string, BuildingStock[]> {
    const map = new Map<string, BuildingStock[]>();
    for (const bs of this.latestStocks) {
      const id = this.villageOfBuilding(bs.id);
      (map.get(id) ?? map.set(id, []).get(id)!).push(bs);
    }
    return map;
  }

  /** How many buildings (of any kind) a village holds — used for the rival readout. */
  private buildingCountOf(villageId: string): number {
    let n = 0;
    for (const v of this.buildingVillage.values()) if (v === villageId) n += 1;
    return n;
  }

  // -------------------------------------------------------------------------
  // SENSE
  // -------------------------------------------------------------------------

  private onIntent(event: VillagerIntentEvent): void {
    switch (event.type) {
      case 'villager.move': {
        const b = this.tally(this.villageOfVillager(event.payload.villagerId));
        b.movements += 1;
        b.active.add(event.payload.villagerId);
        return;
      }
      case 'villager.speak': {
        const b = this.tally(this.villageOfVillager(event.payload.villagerId));
        b.conversations += 1;
        b.active.add(event.payload.villagerId);
        if (b.quotes.length < MAX_QUOTES) b.quotes.push(event.payload.message);
        return;
      }
      case 'villager.interact':
        this.tally(this.villageOfVillager(event.payload.villagerId)).active.add(event.payload.villagerId);
        return;
      case 'villager.pray': {
        const b = this.tally(this.villageOfVillager(event.payload.villagerId));
        b.active.add(event.payload.villagerId);
        if (b.prayers.length < MAX_PRAYERS) b.prayers.push(event.payload.message);
        return;
      }
    }
  }

  private onWorld(event: WorldEvent): void {
    switch (event.type) {
      case 'world.weather_changed':
        this.weather = event.payload.weather;
        return;
      case 'world.building_event': {
        // A finished construction is the day's clearest sign of growth — record it so
        // the god can weigh how city-like its village is becoming and name a milestone.
        const e = event.payload;
        // v3 P5 (design §10) — a RAID: a villager drew resources from a building owned by
        // ANOTHER village. The aggregator already knows both sides' villages, so it detects
        // the theft for free and alerts the VICTIM's god (throttled, so a raider emptying a
        // store doesn't wake the god on every unit).
        if (e.kind === 'take' && e.actorId) {
          const taker = this.villageOfVillager(e.actorId);
          const victim = this.villageOfBuilding(e.buildingId);
          if (taker !== victim) {
            // The competition's offensive/defensive ledger: every cross-village take
            // is a raid landed by the taker and a raid borne by the victim. These feed
            // each side's DEFENSE pillar in the village score (unthrottled — the score
            // weighs the whole campaign, even as the alert below is throttled).
            this.raidsInflicted.set(taker, (this.raidsInflicted.get(taker) ?? 0) + 1);
            this.raidsSuffered.set(victim, (this.raidsSuffered.get(victim) ?? 0) + 1);
            const last = this.lastRaidAlert.get(victim) ?? -Infinity;
            const wake = e.tick - last >= RAID_ALERT_GAP;
            if (wake) this.lastRaidAlert.set(victim, e.tick);
            const amount = e.amount ? `${e.amount} ` : '';
            this.recordEvent(
              'raid',
              wake ? 'crisis' : 'warning',
              `Raiders from ${taker} seized ${amount}${e.resource ?? 'goods'} from ${e.buildingName}.`,
              e.tick,
              victim,
            );
          }
        }
        if (e.kind === 'completed') {
          const village = this.villageOfBuilding(e.buildingId);
          const b = this.tally(village);
          if (b.completedBuilds.length < MAX_BUILDS) {
            const what = e.note ? `${e.buildingName} — ${e.note}` : e.buildingName;
            b.completedBuilds.push(what);
          }
          // A finished structure is a legible, positive happening — record it as an event
          // too (info: notable but no crisis), so the god's digest tells the story of growth.
          this.recordEvent('build_complete', 'info', `${e.buildingName} was finished.`, e.tick, village);
        }
        return;
      }
      case 'world.init':
        this.weather = event.payload.weather;
        // Remember each building's kind + owning village so the per-tick stock stream
        // (id + stock only) can be rolled up by kind AND grouped by village for the digest.
        for (const b of event.payload.buildings ?? []) {
          this.buildingKinds.set(b.id, b.kind);
          this.buildingVillage.set(b.id, b.villageId ?? DEFAULT_VILLAGE_ID);
        }
        return;
      case 'world.map_updated': {
        // Hold the latest snapshot for the v3 digest, and refresh villager->village routing.
        this.latestVillagers = event.payload.villagers;
        this.latestStocks = event.payload.buildingStocks;
        this.lastTick = event.payload.tick;
        this.villagerVillage.clear();
        for (const v of this.latestVillagers) {
          this.villagerVillage.set(v.id, v.villageId ?? DEFAULT_VILLAGE_ID);
        }
        const day = simTimeFromTick(event.payload.tick).day;
        // v3 P4 — scan the fresh snapshot per village for salient transitions (famine onset,
        // a store run dry, a surplus, a newcomer) and fire events/alerts off the rising edge.
        this.detectEvents(event.payload.tick);
        if (this.currentDay === -1) {
          this.currentDay = day; // first tick we ever see: start tallying this day
          return;
        }
        if (day > this.currentDay) {
          this.publishSummaries(this.currentDay, event.payload.tick);
          this.resetForDay(day);
        }
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Roll each village's day up into its own summary
  // -------------------------------------------------------------------------

  /** Emit one `village.daily_summary` per village present, each with its own digest + rival. */
  private publishSummaries(day: number, tick: number): void {
    const byVillage = this.villagersByVillage();
    const stocksByVillage = this.stocksByVillage();
    for (const [villageId, villagers] of byVillage) {
      const bucket = this.tally(villageId);
      const population = villagers.length;
      const idleVillagers = Math.max(0, population - bucket.active.size);
      // v3 P4 — a day where most of a village did nothing is STAGNATION: the flat,
      // repetitive state the variety engines exist to break. Surface it (a warning, not a
      // crisis — it can wait for the daily deliberation) so the god can stir things up.
      if (population >= 3 && idleVillagers >= Math.ceil(population * 0.6)) {
        this.recordEvent('stagnation', 'warning', `${idleVillagers} of ${population} villagers idled the day away.`, tick, villageId);
      }
      const stocks = stocksByVillage.get(villageId) ?? [];
      this.bus.publish(
        EXCHANGES.villageEvents,
        makeEvent('village.daily_summary', {
          villageId,
          day,
          tick,
          population,
          conversations: bucket.conversations,
          movements: bucket.movements,
          idleVillagers,
          weather: this.weather,
          ...(bucket.quotes.length > 0 ? { notableQuotes: bucket.quotes.slice() } : {}),
          ...(bucket.prayers.length > 0 ? { notablePrayers: bucket.prayers.slice() } : {}),
          ...(bucket.completedBuilds.length > 0 ? { completedBuilds: bucket.completedBuilds.slice() } : {}),
          ...(villagers.length > 0 ? { digest: this.buildDigest(villagers, stocks, villageId, byVillage) } : {}),
          ...(bucket.eventsSinceSummary.length > 0 ? { events: bucket.eventsSinceSummary.slice() } : {}),
        }),
      );
      console.log(
        `[aggregator] ${villageId} day ${day}: ${bucket.conversations} convo(s), ` +
          `${bucket.movements} move(s), ${idleVillagers}/${population} idle`,
      );
    }
    // The day-boundary scoreboard — the same head-to-head the pulse emits, settled
    // on the full day's tallies.
    this.publishScoreboard(byVillage, day, tick);
  }

  // -------------------------------------------------------------------------
  // v3 — VILLAGE COMPETITION SCORE (design §10)
  // -------------------------------------------------------------------------

  /**
   * Build and broadcast the head-to-head {@link VillageScoreboard}: every village's
   * blended 0..100 standing plus its growth/social/defense breakdown, sorted so the
   * leader is first. Built from the same per-village snapshot + tallies the digest
   * uses, so it needs nothing the aggregator does not already hold.
   */
  private publishScoreboard(byVillage: Map<string, Villager[]>, day: number, tick: number): void {
    const scores: VillageScore[] = [];
    for (const [villageId, villagers] of byVillage) {
      if (villagers.length === 0) continue;
      scores.push(this.scoreVillage(villageId, villagers));
    }
    if (scores.length === 0) return;
    scores.sort((a, b) => b.overall - a.overall);
    const scoreboard: VillageScoreboard = { day, tick, scores };
    this.bus.publish(EXCHANGES.villageEvents, makeEvent('village.score', scoreboard));
  }

  /**
   * Score ONE village on the three pillars the two settlements compete over, each
   * normalised to 0..100, then blend them into the overall standing:
   *
   *  - GROWTH  — its built footprint (structures) and population, the size a rival sees.
   *  - SOCIAL  — how engaged its people are: the share not idling + how much they talk.
   *  - DEFENSE — its raiding ledger: raids landed less raids borne, around a neutral 50.
   *
   * Survival/needs are deliberately excluded: merely staying fed is not winning. The
   * scales below are tunable constants, chosen so an early hamlet reads low and a
   * thriving, assertive town approaches the ceiling.
   */
  private scoreVillage(villageId: string, villagers: Villager[]): VillageScore {
    const population = villagers.length;
    const buildings = this.buildingCountOf(villageId);
    const bucket = this.tally(villageId);

    // GROWTH — structures weigh more than heads (a building is harder-won), both saturating.
    const growth = clamp01to100(buildings * GROWTH_PER_BUILDING + population * GROWTH_PER_VILLAGER);

    // SOCIAL — fraction of the village that stirred today, plus its chatter per head.
    const engagement = bucket.active.size / population; // 0..1
    const chatter = Math.min(1, bucket.conversations / (population * SOCIAL_TARGET_CONVOS)); // 0..1
    const social = clamp01to100(100 * (0.6 * engagement + 0.4 * chatter));

    // DEFENSE — net raid balance around an untested neutral 50.
    const net = (this.raidsInflicted.get(villageId) ?? 0) - (this.raidsSuffered.get(villageId) ?? 0);
    const defense = clamp01to100(50 + net * DEFENSE_PER_RAID);

    const overall = Math.round(WEIGHT_GROWTH * growth + WEIGHT_SOCIAL * social + WEIGHT_DEFENSE * defense);
    return { villageId, overall, pillars: { growth, social, defense } };
  }

  /**
   * Roll one village's slice of the latest world snapshot into the v3 {@link WorldDigestVitals}:
   * average + worst of each need across ITS villagers, total stock per resource across ITS
   * buildings, per-kind building counts with how many run low — plus a fog-of-war
   * {@link RivalDigest} of the largest OTHER village. The compact, AGGREGATED picture the
   * supervisor sets policy from — never raw per-villager state (design §5.1).
   */
  private buildDigest(
    villagers: Villager[],
    stocks: BuildingStock[],
    villageId: string,
    byVillage: Map<string, Villager[]>,
  ): WorldDigestVitals {
    // Needs: avg + max for each of the four needs across this village's villagers.
    const needKeys: (keyof VillagerNeeds)[] = ['hunger', 'thirst', 'fatigue', 'boredom'];
    const needs = {} as Record<keyof VillagerNeeds, NeedStat>;
    for (const key of needKeys) {
      let sum = 0;
      let max = 0;
      for (const v of villagers) {
        const n = v.needs[key];
        sum += n;
        if (n > max) max = n;
      }
      const count = villagers.length || 1;
      needs[key] = { avg: Math.round(sum / count), max: Math.round(max) };
    }

    // Stocks: total units of each resource held across this village's buildings.
    const stockTotals: Partial<Record<ResourceKind, number>> = {};
    for (const bs of stocks) {
      for (const r of RESOURCE_KINDS) {
        const amt = bs.stock[r];
        if (amt) stockTotals[r] = (stockTotals[r] ?? 0) + amt;
      }
    }

    // Buildings: count per kind + how many of that kind are running low on their stock.
    const byKind = new Map<string, { count: number; lowStock: number }>();
    for (const bs of stocks) {
      const kind = this.buildingKinds.get(bs.id) ?? 'unknown';
      const entry = byKind.get(kind) ?? { count: 0, lowStock: 0 };
      entry.count += 1;
      // Low only counts buildings that actually stock something (a converter/store), so an
      // economy-less building (temple, house) never registers as "low".
      const stockKinds = buildingStockKinds(kind as BuildingKind);
      if (stockKinds.length > 0) {
        const total = stockKinds.reduce((acc, r) => acc + (bs.stock[r] ?? 0), 0);
        if (total < DailySummaryAggregator.LOW_STOCK) entry.lowStock += 1;
      }
      byKind.set(kind, entry);
    }
    const buildings = [...byKind.entries()].map(([kind, e]) => ({ kind, count: e.count, lowStock: e.lowStock }));

    const digest: WorldDigestVitals = { needs, stocks: stockTotals, buildings };
    const rival = this.buildRival(villageId, byVillage);
    if (rival) digest.rival = rival;
    return digest;
  }

  /**
   * What this village can OBSERVE of its rival (fog-of-war, design §10): the largest other
   * village's rough size and visible footprint — never its exact stocks or needs. Returns
   * undefined when no other village exists, so a lone village's digest carries no rival.
   */
  private buildRival(villageId: string, byVillage: Map<string, Villager[]>): RivalDigest | undefined {
    let best: { id: string; villagers: Villager[] } | null = null;
    for (const [id, villagers] of byVillage) {
      if (id === villageId) continue;
      if (!best || villagers.length > best.villagers.length) best = { id, villagers };
    }
    if (!best) return undefined;
    const buildings = this.buildingCountOf(best.id);
    const pop = best.villagers.length;
    // Their rough location: the centroid of the folk we can see (fog-of-war).
    const center = pop
      ? {
          x: Math.round(best.villagers.reduce((s, v) => s + v.position.x, 0) / pop),
          y: Math.round(best.villagers.reduce((s, v) => s + v.position.y, 0) / pop),
        }
      : undefined;
    return {
      villageId: best.id,
      population: pop,
      buildings,
      ...(center ? { center } : {}),
      activity: `a rival settlement of about ${pop} souls across ${buildings} structure(s)`,
    };
  }

  // -------------------------------------------------------------------------
  // The agentic god's live LOOKUPS — answer a query from the current snapshot
  // -------------------------------------------------------------------------

  /** Answer one `supervisor.query` from the held read-model and reply with a `village.query_result`. */
  private onQuery(event: SupervisorQueryEvent): void {
    const { queryId, villageId, kind, args } = event.payload;
    const { ok, text } = this.answerQuery(villageId, kind, args);
    this.bus.publish(
      EXCHANGES.villageEvents,
      makeEvent('village.query_result', { queryId, ok, summary: text }),
    );
  }

  /**
   * Resolve one god lookup against the current per-village snapshot. Read-only — it reads the
   * same `latestVillagers` / `latestStocks` / building maps the digest is built from, scoped to
   * the asking village so a rival god sees no more of us than `scan_rival`'s fog-of-war allows.
   */
  private answerQuery(
    villageId: string,
    kind: SupervisorQueryKind,
    args?: { villagerId?: string; buildingKind?: string },
  ): { ok: boolean; text: string } {
    switch (kind) {
      case 'list_villagers': {
        const mine = this.latestVillagers.filter((v) => this.villageOfVillager(v.id) === villageId);
        if (mine.length === 0) return { ok: false, text: 'No villagers are abroad in your village right now.' };
        const lines = mine.map((v) => `- ${v.name} (${v.id}): ${this.needsLine(v.needs)} — ${v.status}${v.asleep ? ' [asleep]' : ''}`);
        return { ok: true, text: ['Your people right now:', ...lines].join('\n') };
      }
      case 'inspect_villager': {
        const id = args?.villagerId;
        const v = id ? this.latestVillagers.find((x) => x.id === id) : undefined;
        if (!v) return { ok: false, text: `No villager "${id ?? '?'}" is in sight.` };
        if (this.villageOfVillager(v.id) !== villageId) return { ok: false, text: `${v.id} is not one of your people.` };
        const pack = v.backpack.length > 0 ? v.backpack.join(', ') : 'nothing';
        return {
          ok: true,
          text:
            `${v.name} (${v.id}) at (${v.position.x}, ${v.position.y}). Needs — ${this.needsLine(v.needs)}. ` +
            `Doing: ${v.status}. Carrying: ${pack}.${v.asleep ? ' Currently asleep.' : ''}`,
        };
      }
      case 'list_buildings': {
        const wantKind = args?.buildingKind;
        const stockOf = new Map(this.latestStocks.map((s) => [s.id, s.stock]));
        const lines: string[] = [];
        for (const [id, bKind] of this.buildingKinds) {
          if (this.villageOfBuilding(id) !== villageId) continue;
          if (wantKind && bKind !== wantKind) continue;
          const stock = stockOf.get(id);
          const entries = stock ? Object.entries(stock).filter(([, n]) => typeof n === 'number') : [];
          const stockStr = entries.length > 0 ? entries.map(([r, n]) => `${r} ${n}`).join(', ') : 'no store';
          const low = entries.some(([, n]) => (n as number) > 0 && (n as number) <= DailySummaryAggregator.LOW_STOCK);
          lines.push(`- ${id} [${bKind}]: ${stockStr}${low ? ' (running low)' : ''}`);
        }
        if (lines.length === 0) {
          return { ok: false, text: wantKind ? `No "${wantKind}" structures stand in your village.` : 'Your village has no buildings yet.' };
        }
        return { ok: true, text: ['Your structures and their stores:', ...lines].join('\n') };
      }
      case 'scan_rival': {
        const rival = this.buildRival(villageId, this.villagersByVillage());
        if (!rival) return { ok: false, text: 'You have no rival across the valley — yours is the only village.' };
        const where = rival.center ? ` near (${rival.center.x}, ${rival.center.y})` : '';
        return { ok: true, text: `Across the valley: ${rival.activity}${where}.` };
      }
      default:
        return { ok: false, text: 'You gaze, but there is nothing to see that way.' };
    }
  }

  /** One compact needs line for a villager (rounded), shared by the roster + single-inspect lookups. */
  private needsLine(n: VillagerNeeds): string {
    return (
      `hunger ${Math.round(n.hunger)}, thirst ${Math.round(n.thirst)}, ` +
      `fatigue ${Math.round(n.fatigue)}, boredom ${Math.round(n.boredom ?? 0)}`
    );
  }

  private resetForDay(day: number): void {
    this.currentDay = day;
    // Fresh buckets for the new day. lastPopulation + activeConditions (hysteresis) are
    // deliberately NOT cleared — they span day boundaries.
    this.tallies = new Map<string, VillageTally>();
  }

  // -------------------------------------------------------------------------
  // v3 P4 — WORLD-EVENT DETECTION (design §9.2), now PER VILLAGE
  // -------------------------------------------------------------------------

  /**
   * Scan the freshest world snapshot, PER village, for salient transitions and fire an
   * event off each one's RISING EDGE. Hysteresis ({@link activeConditions}, keyed with a
   * village-qualified id) means a lingering condition fires once, then re-arms only after
   * it clears — so neither village's god is pelted every tick. A `crisis` also emits a
   * `village.alert` (tagged with the village) immediately, interrupting the daily cadence.
   */
  private detectEvents(tick: number): void {
    const byVillage = this.villagersByVillage();
    const stocksByVillage = this.stocksByVillage();

    for (const [villageId, villagers] of byVillage) {
      // NEEDS — a survival need turning dire across the village is a crisis (hunger → famine,
      // thirst → drought; both reported as `famine`).
      if (villagers.length > 0) {
        const avg = (key: keyof VillagerNeeds): number =>
          villagers.reduce((s, v) => s + (v.needs[key] ?? 0), 0) / villagers.length;
        this.edge(`famine:hunger:${villageId}`, avg('hunger') >= NEED_DIRE, avg('hunger') < NEED_CLEAR, () =>
          this.recordEvent('famine', 'crisis', `Hunger has turned dire (avg ${Math.round(avg('hunger'))}).`, tick, villageId),
        );
        this.edge(`famine:thirst:${villageId}`, avg('thirst') >= NEED_DIRE, avg('thirst') < NEED_CLEAR, () =>
          this.recordEvent('famine', 'crisis', `Thirst grips the village (avg ${Math.round(avg('thirst'))}).`, tick, villageId),
        );
      }

      // STOCKS — totals per resource across this village's buildings, for shortage + surplus.
      const totals = {} as Partial<Record<ResourceKind, number>>;
      for (const bs of stocksByVillage.get(villageId) ?? []) {
        for (const r of RESOURCE_KINDS) {
          const amt = bs.stock[r];
          if (amt) totals[r] = (totals[r] ?? 0) + amt;
        }
      }
      for (const r of WATCHED_RESOURCES) {
        const total = totals[r] ?? 0;
        const survival = r === 'food' || r === 'water';
        // SHORTAGE — a store run completely dry. Survival resources are a crisis; the rest a warning.
        this.edge(`shortage:${r}:${villageId}`, total <= 0, total >= SHORTAGE_CLEAR, () =>
          this.recordEvent('shortage', survival ? 'crisis' : 'warning', `The village has run out of ${r}.`, tick, villageId),
        );
        // SURPLUS — a store piled well past need; the god might spend the slack on building/leisure.
        this.edge(`surplus:${r}:${villageId}`, total >= SURPLUS_LEVEL, total < SURPLUS_CLEAR, () =>
          this.recordEvent('surplus', 'info', `${r} has piled up (${total} in store) — plenty to spend.`, tick, villageId),
        );
      }

      // NEWCOMER — this village's population rose since last snapshot (a spawn or a wanderer).
      const last = this.lastPopulation.get(villageId);
      if (last !== undefined && villagers.length > last) {
        this.recordEvent('newcomer', 'info', `A newcomer has joined the village (now ${villagers.length}).`, tick, villageId);
      }
      this.lastPopulation.set(villageId, villagers.length);
    }
  }

  /**
   * Edge-trigger one condition: run `fire` once when it first becomes true, and re-arm
   * (so it can fire again) only once `cleared` is true. Holds the firing state in
   * {@link activeConditions} keyed by `id`, giving each condition its own hysteresis band.
   */
  private edge(id: string, on: boolean, cleared: boolean, fire: () => void): void {
    if (on && !this.activeConditions.has(id)) {
      this.activeConditions.add(id);
      fire();
    } else if (cleared) {
      this.activeConditions.delete(id);
    }
  }

  /**
   * Record one detected event for a village: append it to that village's day list (bounded),
   * and — if it is a CRISIS — publish a `village.alert` (tagged with the village) so only that
   * village's supervisor deliberates out-of-cadence (design §8). Lower-salience events ride
   * the next daily summary only.
   */
  private recordEvent(
    kind: DigestEventKind,
    salience: DigestEventSalience,
    text: string,
    tick: number,
    villageId: string,
  ): void {
    const event: DigestEvent = { kind, salience, text, day: simTimeFromTick(tick).day, tick, villageId };
    const bucket = this.tally(villageId);
    bucket.eventsSinceSummary.push(event);
    if (bucket.eventsSinceSummary.length > MAX_EVENTS) bucket.eventsSinceSummary.shift();
    console.log(`[aggregator] ${villageId} event (${salience}): ${text}`);
    if (salience === 'crisis') {
      this.bus.publish(EXCHANGES.villageEvents, makeEvent('village.alert', event));
    }
  }
}

/** A need average at/above this is "dire" (fires the event); it re-arms below {@link NEED_CLEAR}. */
const NEED_DIRE = 75;
const NEED_CLEAR = 60;
/** The resources whose shortage/surplus the engine watches. */
const WATCHED_RESOURCES: readonly ResourceKind[] = ['food', 'water', 'wood', 'goods'];
/** A shortage re-arms (so it can fire again) only once the store climbs back to this. */
const SHORTAGE_CLEAR = 3;
/** A resource total at/above this is a SURPLUS; it re-arms below {@link SURPLUS_CLEAR}. */
const SURPLUS_LEVEL = 40;
const SURPLUS_CLEAR = 25;
/** Min ticks between raid alerts on the same victim village, so a raid doesn't spam the god. */
const RAID_ALERT_GAP = 20;

// --- Village-score tuning (design §10). All 0..100 saturating; weights sum to 1. ---
/** GROWTH points per standing structure (a built-up village reads high). */
const GROWTH_PER_BUILDING = 8;
/** GROWTH points per villager (population is the softer half of footprint). */
const GROWTH_PER_VILLAGER = 5;
/** Conversations-per-villager that count as a fully sociable day for the SOCIAL pillar. */
const SOCIAL_TARGET_CONVOS = 2;
/** DEFENSE points each net raid (landed minus borne) moves the score off neutral 50. */
const DEFENSE_PER_RAID = 10;
/** Blend weights for the overall standing (growth-led; social + defense equal behind it). */
const WEIGHT_GROWTH = 0.4;
const WEIGHT_SOCIAL = 0.3;
const WEIGHT_DEFENSE = 0.3;

/** Round and clamp a raw score into the wire's 0..100 band. */
function clamp01to100(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw)));
}
