/**
 * server/src/persistence/DailyReportStore.ts
 * ---------------------------------------------------------------------------
 * The seam for persisting the God Agent's nightly CHRONICLES, so the summary
 * window's history survives a reboot. Append-only, like the action log:
 *
 *   - `record` -> store one day's chronicle as it is authored.
 *   - `list`   -> read the most recent chronicles, newest first, for the
 *                 browser's history-on-load.
 *
 * Datastore-agnostic: the concrete Mongo implementation lives beside it.
 * ---------------------------------------------------------------------------
 */

import type { SupervisorDailyReportPayload } from '../../../shared/events';

export interface DailyReportStore {
  /** Open the underlying connection. */
  connect(): Promise<void>;

  /** Persist one day's chronicle. */
  record(report: SupervisorDailyReportPayload): Promise<void>;

  /** Read the most recent chronicles, newest day first. */
  list(limit?: number): Promise<SupervisorDailyReportPayload[]>;

  /** Close the underlying connection. */
  close(): Promise<void>;
}
