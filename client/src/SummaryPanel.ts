/**
 * client/src/SummaryPanel.ts
 * ---------------------------------------------------------------------------
 * The "Chronicle" window — the god's end-of-day summary, seen by the human.
 *
 * Each day the Supervisor (the temple god) authors a short, mythic chronicle of
 * the day and publishes it (`net.onDailyReport`). This window renders it in two
 * columns: the god's NARRATIVE on the left, and the day's LEDGER on the right —
 * the hard metrics, notable quotes, prayers offered, and the divine acts the god
 * took. A day selector keeps the whole history revisitable; the window pops to
 * the front each time a fresh day arrives.
 *
 * Like the other feeds it holds no world state of its own beyond the reports it
 * has been handed (seeded from `GET /daily-reports`, appended live over WS).
 * ---------------------------------------------------------------------------
 */

import type { SupervisorDailyReportPayload } from '../../shared/types';
import { escapeHtml } from './modal';

/** A glyph for each weather state, so the ledger reads at a glance. */
const WEATHER_ICON: Record<string, string> = {
  clear: '☀️',
  rain: '🌧️',
  storm: '⛈️',
  fog: '🌫️',
  heatwave: '🔥',
};

/** A glyph for each kind of divine act, for the ledger's "Divine Acts" list. */
const ACT_ICON: Record<string, string> = {
  spawn_entity: '✦',
  change_weather: '🌤️',
  plant_idea: '💭',
};

export class SummaryPanel {
  /** Every chronicle we hold, newest day first. */
  private reports: SupervisorDailyReportPayload[] = [];
  /** The day currently being shown (null until the first report arrives). */
  private shownDay: number | null = null;

  private readonly daysSel: HTMLSelectElement;
  private readonly chronicleEl: HTMLElement;
  private readonly ledgerEl: HTMLElement;

  constructor(root: HTMLElement) {
    root.classList.add('summary');
    root.innerHTML = `
      <header class="summary__head">
        <span class="win__title summary__title">📜 Chronicle</span>
        <select class="summary__days" title="Revisit an earlier day"></select>
      </header>
      <div class="summary__body">
        <section class="summary__chronicle">
          <div class="summary__empty">No chronicle yet — the first day is still unfolding.</div>
        </section>
        <section class="summary__ledger"></section>
      </div>`;
    this.daysSel = root.querySelector('.summary__days')!;
    this.chronicleEl = root.querySelector('.summary__chronicle')!;
    this.ledgerEl = root.querySelector('.summary__ledger')!;
    this.daysSel.addEventListener('change', () => {
      const day = Number(this.daysSel.value);
      if (Number.isFinite(day)) this.show(day);
    });
  }

  /** Seed the history from the server (newest day first), and show the latest. */
  loadHistory(reports: SupervisorDailyReportPayload[]): void {
    this.reports = [...reports].sort((a, b) => b.day - a.day);
    this.refreshDays();
    const latest = this.reports[0];
    if (latest) this.show(latest.day);
  }

  /**
   * A fresh chronicle arrived: store it (replacing any same-day report), refresh
   * the selector, and show it. Returns true when it is a NEW latest day, so the
   * caller can pop the window to the front.
   */
  ingest(report: SupervisorDailyReportPayload): boolean {
    const prevLatest = this.reports[0]?.day ?? -Infinity;
    this.reports = this.reports.filter((r) => r.day !== report.day);
    this.reports.push(report);
    this.reports.sort((a, b) => b.day - a.day);
    this.refreshDays();
    this.show(report.day);
    return report.day > prevLatest;
  }

  // -------------------------------------------------------------------------

  /** Repopulate the day <select>, preserving the currently-shown day if present. */
  private refreshDays(): void {
    this.daysSel.innerHTML = this.reports
      .map((r) => `<option value="${r.day}">Day ${r.day} · ${escapeHtml(r.dateLabel)}</option>`)
      .join('');
    if (this.shownDay !== null && this.reports.some((r) => r.day === this.shownDay)) {
      this.daysSel.value = String(this.shownDay);
    }
  }

  /** Render the chronicle + ledger for one day. */
  private show(day: number): void {
    const report = this.reports.find((r) => r.day === day);
    if (!report) return;
    this.shownDay = day;
    this.daysSel.value = String(day);

    const narrative = report.narrative.trim();
    this.chronicleEl.innerHTML =
      `<div class="summary__daytitle">⛪ Day ${report.day}</div>` +
      `<div class="summary__datelabel">${escapeHtml(report.dateLabel)}</div>` +
      (narrative
        ? `<p class="summary__narrative">${escapeHtml(narrative)}</p>`
        : `<p class="summary__narrative summary__narrative--quiet">The god kept silent counsel this day.</p>`);

    this.ledgerEl.innerHTML = [
      this.renderMetrics(report),
      this.renderList('Voices', report.quotes, (q) => `“${escapeHtml(q)}”`),
      this.renderList('Prayers', report.prayers, (p) => `🙏 ${escapeHtml(p)}`),
      this.renderList(
        'Divine Acts',
        report.divineActs.map((a) => `${ACT_ICON[a.action] ?? '✦'} ${a.summary}`),
        (a) => escapeHtml(a),
      ),
    ].join('');
  }

  /** The metric chip strip: population, talks, moves, idle, weather. */
  private renderMetrics(report: SupervisorDailyReportPayload): string {
    const m = report.metrics;
    const chip = (value: string, label: string): string =>
      `<div class="summary__chip"><span class="summary__chipv">${escapeHtml(value)}</span>` +
      `<span class="summary__chipl">${escapeHtml(label)}</span></div>`;
    return (
      `<div class="summary__metrics">` +
      chip(String(m.population), 'souls') +
      chip(String(m.conversations), 'talks') +
      chip(String(m.movements), 'moves') +
      chip(String(m.idleVillagers), 'idle') +
      chip(`${WEATHER_ICON[m.weather] ?? ''} ${m.weather}`, 'sky') +
      `</div>`
    );
  }

  /** A titled ledger section; renders nothing when the list is empty. */
  private renderList(title: string, items: string[], fmt: (s: string) => string): string {
    if (items.length === 0) return '';
    const rows = items.map((it) => `<li class="summary__row">${fmt(it)}</li>`).join('');
    return (
      `<div class="summary__section">${escapeHtml(title)}</div>` +
      `<ul class="summary__rows">${rows}</ul>`
    );
  }
}
