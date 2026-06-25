/**
 * server/src/DailyReportRecorder.ts
 * ---------------------------------------------------------------------------
 * The nightly chronicle's WRITE side.
 *
 * Each day the Supervisor publishes a `village.daily_report` (its mythic
 * chronicle of the day). This recorder eavesdrops on that stream and persists
 * each one into the {@link DailyReportStore}, so the summary window's history
 * survives a reboot. It keeps the Supervisor a pure bus citizen — the god
 * authors and broadcasts; the server persists.
 *
 * Writes are fire-and-forget: a slow disk must never stall the bus.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { EXCHANGES, type SupervisorDailyReportEvent } from '../../shared/events';
import type { DailyReportStore } from './persistence/DailyReportStore';

export class DailyReportRecorder {
  constructor(
    private readonly bus: EventBus,
    private readonly store: DailyReportStore,
  ) {}

  async start(): Promise<void> {
    // Durable, named queue: a chronicle is authored once a day and must not be
    // missed across a restart, like the supervisor's own summary subscription.
    await this.bus.subscribe<SupervisorDailyReportEvent>(
      EXCHANGES.villageEvents,
      'village.daily_report',
      (event) => this.onReport(event),
      { queue: 'recorder.daily.reports', durable: true },
    );
    console.log('[recorder] persisting daily chronicles to the report log');
  }

  private onReport(event: SupervisorDailyReportEvent): void {
    void this.store.record(event.payload).catch((err) => {
      console.warn('[recorder] failed to persist daily report:', err);
    });
  }
}
