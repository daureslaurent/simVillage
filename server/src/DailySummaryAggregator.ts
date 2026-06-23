/**
 * server/src/DailySummaryAggregator.ts
 * ---------------------------------------------------------------------------
 * Final Phase — the feed for the "God Agent".
 *
 * The Supervisor reasons one village-day at a time, but the bus only carries
 * fine-grained per-tick world state and per-action intents. This small service
 * bridges that gap: it tallies the day's activity off the existing streams and,
 * at each day boundary, rolls the tallies up into ONE `village.daily_summary`
 * on `village.events` — then resets and starts the next day.
 *
 * It is a pure bus citizen and holds no authoritative state (the engine remains
 * the source of truth). It lives beside the engine only because that is where
 * the tick clock originates; it deliberately does NOT import the engine, so it
 * could equally run as its own process. "A day" is `VILLAGER_TICKS_PER_DAY` ticks —
 * the same constant the villagers' reflection loop uses — so the god's notion of
 * a day matches theirs.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES } from '../../shared/events';
import type { VillagerIntentEvent, WorldEvent } from '../../shared/events';
import type { WeatherKind } from '../../shared/types';
import { simTimeFromTick } from '../../shared/simClock';

/** How many recent utterances to carry into the summary as colour. */
const MAX_QUOTES = 5;

/** How many of the day's prayers to carry into the summary for the god to weigh. */
const MAX_PRAYERS = 5;

export class DailySummaryAggregator {
  /** The day currently being tallied; -1 until the first tick arrives. */
  private currentDay = -1;
  private population = 0;
  private weather: WeatherKind = 'clear';

  // Per-day tallies, reset at every day boundary.
  private conversations = 0;
  private movements = 0;
  private readonly activeVillagers = new Set<string>();
  private quotes: string[] = [];
  private prayers: string[] = [];

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

    console.log('[aggregator] online; village days follow the shared sim clock (10s/tick)');
  }

  private onIntent(event: VillagerIntentEvent): void {
    switch (event.type) {
      case 'villager.move':
        this.movements += 1;
        this.activeVillagers.add(event.payload.villagerId);
        return;
      case 'villager.speak':
        this.conversations += 1;
        this.activeVillagers.add(event.payload.villagerId);
        if (this.quotes.length < MAX_QUOTES) this.quotes.push(event.payload.message);
        return;
      case 'villager.interact':
        this.activeVillagers.add(event.payload.villagerId);
        return;
      case 'villager.pray':
        this.activeVillagers.add(event.payload.villagerId);
        if (this.prayers.length < MAX_PRAYERS) this.prayers.push(event.payload.message);
        return;
    }
  }

  private onWorld(event: WorldEvent): void {
    switch (event.type) {
      case 'world.weather_changed':
        this.weather = event.payload.weather;
        return;
      case 'world.init':
        this.weather = event.payload.weather;
        return;
      case 'world.map_updated': {
        this.population = event.payload.villagers.length;
        const day = simTimeFromTick(event.payload.tick).day;
        if (this.currentDay === -1) {
          this.currentDay = day; // first tick we ever see: start tallying this day
          return;
        }
        if (day > this.currentDay) {
          this.publishSummary(this.currentDay, event.payload.tick);
          this.resetForDay(day);
        }
        return;
      }
    }
  }

  /** Roll the finished day up into one summary and emit it for the Supervisor. */
  private publishSummary(day: number, tick: number): void {
    const idleVillagers = Math.max(0, this.population - this.activeVillagers.size);
    this.bus.publish(
      EXCHANGES.villageEvents,
      makeEvent('village.daily_summary', {
        day,
        tick,
        population: this.population,
        conversations: this.conversations,
        movements: this.movements,
        idleVillagers,
        weather: this.weather,
        ...(this.quotes.length > 0 ? { notableQuotes: this.quotes.slice() } : {}),
        ...(this.prayers.length > 0 ? { notablePrayers: this.prayers.slice() } : {}),
      }),
    );
    console.log(
      `[aggregator] day ${day}: ${this.conversations} convo(s), ${this.movements} move(s), ` +
        `${idleVillagers}/${this.population} idle`,
    );
  }

  private resetForDay(day: number): void {
    this.currentDay = day;
    this.conversations = 0;
    this.movements = 0;
    this.activeVillagers.clear();
    this.quotes = [];
    this.prayers = [];
  }
}
