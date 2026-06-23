/**
 * client/src/LlmEnginePanel.ts
 * ---------------------------------------------------------------------------
 * A bottom-right DEBUG WINDOW onto the shared LLM engine. It answers the four
 * questions you ask when villagers go quiet:
 *
 *   - What is running RIGHT NOW? — the in-flight calls, each with a live elapsed
 *     timer (so a call creeping toward the timeout is obvious at a glance).
 *   - What did the last calls return? — a newest-first log of finished calls
 *     with latency, ok/error status, and click-to-expand request + response.
 *   - Is the engine healthy? — a header tally of in-flight / ok / error counts
 *     and the overall average latency.
 *   - What KIND of call is this? — every row is tagged and colour-coded by
 *     `purpose` (decide / supervisor / reflect / plan / embed — finer-grained
 *     than the HTTP endpoint, since a villager's turn and the God Agent's turn
 *     both hit `/decide`), and a filter bar lets you isolate one or more
 *     purposes and see each one's call count + average duration at a glance.
 *
 * It is fed purely off the WebSocket `engine.llm.started` / `engine.llm.finished`
 * stream the backend mirrors from every round-trip; no polling.
 * ---------------------------------------------------------------------------
 */

import type { LlmCallPurpose, LlmCallStartedMessage, LlmCallFinishedMessage } from '../../shared/types';
import { escapeHtml } from './modal';

/** How many finished calls to keep in the log before trimming. Generous so a
 *  filtered view (e.g. "embed" only) still has something to show. */
const MAX_RECENT = 40;
/** Elapsed beyond this (ms) paints a running call amber, then red — the timeout tell. */
const SLOW_MS = 15_000;
const VERY_SLOW_MS = 60_000;

/** Every call purpose the engine can report, in display order, with the
 *  colour token each is drawn in (shared with the row label + filter chip). */
const PURPOSES: ReadonlyArray<{ key: LlmCallPurpose; label: string; cssVar: string }> = [
  { key: 'decide', label: 'Decide', cssVar: '--accent' },
  { key: 'supervisor', label: 'Supervisor', cssVar: '--violet' },
  { key: 'reflect', label: 'Reflect', cssVar: '--teal' },
  { key: 'plan', label: 'Plan', cssVar: '--gold' },
  { key: 'embed', label: 'Embed', cssVar: '--text-muted' },
];

/** Running totals for one purpose, used to render its filter chip's average. */
interface PurposeStat {
  count: number;
  totalMs: number;
  err: number;
}

/** A finished call plus the agent + request preview we captured when it started. */
interface FinishedCall extends LlmCallFinishedMessage {
  agent: string;
  request: string;
}

export class LlmEnginePanel {
  private readonly tallyEl: HTMLElement;
  private readonly filtersEl: HTMLElement;
  private readonly runningEl: HTMLElement;
  private readonly recentEl: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;

  /** In-flight calls, keyed by id, in arrival order. */
  private readonly running = new Map<number, LlmCallStartedMessage>();
  /** Finished calls, newest first. */
  private readonly recent: FinishedCall[] = [];
  /** Purposes currently shown in the running/recent lists. Empty would mean
   *  "show nothing", so toggling the last active chip off resets to "all". */
  private readonly activeFilters = new Set<LlmCallPurpose>(PURPOSES.map((p) => p.key));
  /** Per-purpose call count + total/avg duration, for the filter chips. */
  private readonly stats = new Map<LlmCallPurpose, PurposeStat>();
  private okCount = 0;
  private errCount = 0;
  private totalMs = 0;
  private finishedCount = 0;
  private paused = false;

  constructor(root: HTMLElement) {
    root.classList.add('llm');
    root.innerHTML = `
      <header class="llm__head">
        <span class="llm__title">LLM engine</span>
        <span class="llm__tally"></span>
        <button class="llm__pause" title="Pause / resume the log">⏸</button>
      </header>
      <div class="llm__filters"></div>
      <div class="llm__running"></div>
      <div class="llm__recent"></div>`;
    this.tallyEl = root.querySelector('.llm__tally')!;
    this.filtersEl = root.querySelector('.llm__filters')!;
    this.runningEl = root.querySelector('.llm__running')!;
    this.recentEl = root.querySelector('.llm__recent')!;
    this.pauseBtn = root.querySelector('.llm__pause')!;
    this.pauseBtn.addEventListener('click', () => this.togglePause());
    this.filtersEl.addEventListener('click', (e) => this.onFilterClick(e));

    // Live-refresh the running rows' elapsed timers without touching the log.
    setInterval(() => this.renderRunning(), 250);
    this.renderFilters();
    this.renderTally();
  }

  /** An engine round-trip has started. */
  ingestStart(call: LlmCallStartedMessage): void {
    this.running.set(call.id, call);
    this.renderRunning();
    this.renderTally();
  }

  /** The matching round-trip has finished (success or error). */
  ingestFinish(call: LlmCallFinishedMessage): void {
    const started = this.running.get(call.id);
    this.running.delete(call.id);
    // Prefer the start event's purpose/label — it's exact (the finish event has
    // no request body to derive it from; see LlmEngineMonitor.onFinish).
    const purpose = started?.purpose ?? call.purpose;

    if (call.ok) this.okCount++;
    else this.errCount++;
    this.totalMs += call.durationMs;
    this.finishedCount++;

    const stat = this.stats.get(purpose) ?? { count: 0, totalMs: 0, err: 0 };
    stat.count++;
    stat.totalMs += call.durationMs;
    if (!call.ok) stat.err++;
    this.stats.set(purpose, stat);

    if (!this.paused) {
      // Prefer the start event's label/request — it carries the batch size
      // (e.g. "embed ×3") and the request preview the finish event omits.
      this.recent.unshift({
        ...call,
        purpose,
        label: started?.label ?? call.label,
        agent: started?.agent ?? 'unknown',
        request: started?.request ?? '',
      });
      if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
      this.renderRecent();
    }
    this.renderFilters(); // counts/averages changed
    this.renderRunning();
    this.renderTally();
  }

  // -------------------------------------------------------------------------

  private onFilterClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.llm__chip');
    const key = btn?.dataset.purpose as LlmCallPurpose | undefined;
    if (!key) return;
    if (this.activeFilters.has(key)) this.activeFilters.delete(key);
    else this.activeFilters.add(key);
    // Clearing the last active chip would hide everything with no way back
    // except re-clicking each one — reset to "show all" instead.
    if (this.activeFilters.size === 0) {
      for (const p of PURPOSES) this.activeFilters.add(p.key);
    }
    this.renderFilters();
    this.renderRunning();
    this.renderRecent();
  }

  private renderFilters(): void {
    this.filtersEl.innerHTML = PURPOSES.map((p) => {
      const stat = this.stats.get(p.key);
      const count = stat?.count ?? 0;
      const avg = stat && stat.count > 0 ? fmtMs(Math.round(stat.totalMs / stat.count)) : '–';
      const on = this.activeFilters.has(p.key);
      const errBit = stat && stat.err > 0 ? ` · ${stat.err} err` : '';
      return `
        <button class="llm__chip${on ? ' llm__chip--on' : ''}" data-purpose="${p.key}"
          style="--chip-color: var(${p.cssVar})"
          title="${p.label} — ${count} call(s), avg ${avg}${errBit}">
          <span class="llm__chip-dot"></span>
          <span class="llm__chip-label">${p.label}</span>
          <span class="llm__chip-count">${count}</span>
          <span class="llm__chip-avg">${avg}</span>
        </button>`;
    }).join('');
  }

  private renderTally(): void {
    const live = this.running.size;
    const avg = this.finishedCount > 0 ? fmtMs(Math.round(this.totalMs / this.finishedCount)) : '–';
    this.tallyEl.innerHTML =
      `<b class="llm__live${live ? ' llm__live--on' : ''}">${live} running</b>` +
      `  ·  <span class="llm__ok">${this.okCount} ok</span>` +
      `  ·  <span class="llm__err">${this.errCount} err</span>` +
      `  ·  <span class="llm__avg" title="Average duration across all finished calls">avg ${avg}</span>`;
  }

  private renderRunning(): void {
    const now = Date.now();
    // Oldest first: the one actually executing on the serialized engine is on top.
    const calls = [...this.running.values()]
      .filter((c) => this.activeFilters.has(c.purpose))
      .sort((a, b) => a.startedAt - b.startedAt);
    if (calls.length === 0) {
      this.runningEl.innerHTML =
        this.running.size === 0
          ? '<div class="llm__idle">idle — no calls in flight</div>'
          : '<div class="llm__idle">no running calls match the filter</div>';
      return;
    }
    this.runningEl.innerHTML = calls
      .map((c) => {
        const ms = now - c.startedAt;
        const sev = ms >= VERY_SLOW_MS ? ' llm__row--vslow' : ms >= SLOW_MS ? ' llm__row--slow' : '';
        return `
          <div class="llm__row llm__row--run${sev}">
            <span class="llm__spin">●</span>
            <span class="llm__agent" title="${escapeHtml(c.agent)}">${escapeHtml(c.agent)}</span>
            <span class="llm__label llm__label--${c.purpose}" title="${escapeHtml(c.purpose)}">${escapeHtml(c.label)}</span>
            <span class="llm__elapsed">${fmtMs(ms)}</span>
            <span class="llm__preview" title="${escapeHtml(c.request)}">${escapeHtml(c.request)}</span>
          </div>`;
      })
      .join('');
  }

  private renderRecent(): void {
    const calls = this.recent.filter((c) => this.activeFilters.has(c.purpose));
    if (calls.length === 0) {
      this.recentEl.innerHTML =
        this.recent.length === 0
          ? '<div class="llm__empty">no calls yet</div>'
          : '<div class="llm__empty">no recent calls match the filter</div>';
      return;
    }
    this.recentEl.innerHTML = calls
      .map((c) => {
        const dur = c.durationMs;
        const sev = dur >= VERY_SLOW_MS ? ' llm__dur--vslow' : dur >= SLOW_MS ? ' llm__dur--slow' : '';
        const statusBit = c.status !== undefined ? ` ${c.status}` : '';
        const body = c.ok
          ? `<div class="llm__sub"><b>→</b> ${escapeHtml(c.response || '(empty)')}</div>`
          : `<div class="llm__sub llm__sub--err"><b>✕${escapeHtml(statusBit)}</b> ${escapeHtml(c.error || 'failed')}</div>`;
        const req = c.request
          ? `<div class="llm__sub llm__sub--req"><b>←</b> ${escapeHtml(c.request)}</div>`
          : '';
        return `
          <details class="llm__item${c.ok ? '' : ' llm__item--err'}">
            <summary>
              <span class="llm__dot${c.ok ? '' : ' llm__dot--err'}"></span>
              <span class="llm__agent" title="${escapeHtml(c.agent)}">${escapeHtml(c.agent)}</span>
              <span class="llm__label llm__label--${c.purpose}" title="${escapeHtml(c.purpose)}">${escapeHtml(c.label)}</span>
              <span class="llm__dur${sev}">${fmtMs(dur)}</span>
            </summary>
            ${req}
            ${body}
          </details>`;
      })
      .join('');
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseBtn.textContent = this.paused ? '▶' : '⏸';
    this.pauseBtn.classList.toggle('llm__pause--on', this.paused);
  }
}

/** Compact ms -> "820ms" / "12.4s" for the timers. */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
