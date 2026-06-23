/**
 * server/src/BuildingLog.ts
 * ---------------------------------------------------------------------------
 * The buildings' ACTIVITY LOG — a rolling, in-memory record of what has recently
 * happened at each building (takes, gives, work sessions, refused work, a store
 * running dry or filling up).
 *
 * It subscribes to `world.building_event` on the world exchange and keeps, per
 * building, the events from roughly the last few simulated hours
 * ({@link BUILDING_LOG_WINDOW_TICKS} clock ticks). Older events fall out of the
 * window as in-world time advances, so the log never grows without bound.
 *
 * Two consumers read from it, both in this same process:
 *   - the GATEWAY serves `GET /buildings/:id/log` to seed the browser's inspector
 *     panel (live updates arrive separately over the WebSocket);
 *   - it is purely in-memory — there is no durable store — because the window is
 *     short by design and a fresh window rebuilds itself within a few sim-hours.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { EXCHANGES, type WorldEvent } from '../../shared/events';
import type { BuildingEvent } from '../../shared/types';
import { BUILDING_LOG_WINDOW_TICKS } from '../../shared/buildings';

export class BuildingLog {
  /** buildingId -> its events, oldest first. Pruned to the rolling window. */
  private readonly byBuilding = new Map<string, BuildingEvent[]>();
  /** The latest event tick seen, used as the moving edge of the prune window. */
  private latestTick = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly windowTicks = BUILDING_LOG_WINDOW_TICKS,
  ) {}

  async start(): Promise<void> {
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.building_event', (event) => {
      if (event.type === 'world.building_event') this.ingest(event.payload);
    });
    console.log('[buildinglog] recording building activity (rolling window)');
  }

  /** The recent events for one building, oldest first (already within the window). */
  recent(buildingId: string): BuildingEvent[] {
    return this.byBuilding.get(buildingId) ?? [];
  }

  private ingest(event: BuildingEvent): void {
    this.latestTick = Math.max(this.latestTick, event.tick);
    const list = this.byBuilding.get(event.buildingId) ?? [];
    list.push(event);
    this.prune(list);
    this.byBuilding.set(event.buildingId, list);
  }

  /** Drop events older than the rolling window (by clock tick), in place. */
  private prune(list: BuildingEvent[]): void {
    const cutoff = this.latestTick - this.windowTicks;
    let drop = 0;
    while (drop < list.length && list[drop].tick < cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
  }
}
