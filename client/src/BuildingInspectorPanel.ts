/**
 * client/src/BuildingInspectorPanel.ts
 * ---------------------------------------------------------------------------
 * The BUILDING INSPECTOR.
 *
 * A right-docked side panel that opens when you click a building on the map. It
 * shows the place's current resources (live, read from the cached world view) and
 * a scrollable ACTIVITY LOG of what has recently happened there — takes, gives,
 * work sessions, refused work, a store running dry or filling up.
 *
 * The log is seeded from the server's rolling 5-sim-hour window over HTTP, then
 * kept live: each `building.event` push for this building is appended (newest at
 * the top). The resource readout refreshes on a light interval while open, since
 * stock drifts every tick without always emitting an event.
 *
 * The panel owns its DOM and stays oblivious to the network — `main.ts` injects the
 * fetcher + a building lookup and feeds it live events.
 * ---------------------------------------------------------------------------
 */

import type { Building, BuildingEvent, ResourceKind } from '../../shared/types';
import type { ManagedWindow } from './WindowManager';
import { buildingStockKinds } from '../../shared/buildings';
import { formatSimClock } from '../../shared/simClock';
import { escapeHtml } from './modal';

export interface BuildingInspectorOptions {
  /** Load a building's recent activity log (oldest first). */
  onFetch: (buildingId: string) => Promise<BuildingEvent[]>;
  /** Look up a building's current state (name, stock, capacity) by id. */
  getBuilding: (buildingId: string) => Building | null;
}

/** A glyph per event kind, for a scannable log. */
const EVENT_ICON: Record<BuildingEvent['kind'], string> = {
  take: '⬆️',
  give: '⬇️',
  work_started: '🛠️',
  work_finished: '✅',
  work_refused: '⛔',
  depleted: '🟥',
  filled: '🟩',
  site_opened: '🏗️',
  completed: '🏛️',
};

export class BuildingInspectorPanel {
  private readonly titleEl: HTMLElement;
  private readonly resourcesEl: HTMLElement;
  private readonly logEl: HTMLElement;

  /** The host window — open/close delegate to it (wired by main via setWindow). */
  private win: ManagedWindow | null = null;
  /** The building currently inspected, or null when the panel is closed. */
  private selectedId: string | null = null;
  /** The log entries shown, newest last; rendered newest-first. */
  private events: BuildingEvent[] = [];
  /** Periodic resource refresh while open. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    root: HTMLElement,
    private readonly options: BuildingInspectorOptions,
  ) {
    root.classList.add('binspect');
    root.innerHTML = `
      <header class="binspect__head">
        <span class="win__title binspect__title">No building selected</span>
      </header>
      <div class="binspect__resources"></div>
      <div class="binspect__loghead">Activity (last few hours)</div>
      <div class="binspect__log"></div>`;

    this.titleEl = root.querySelector('.binspect__title')!;
    this.resourcesEl = root.querySelector('.binspect__resources')!;
    this.logEl = root.querySelector('.binspect__log')!;
  }

  /** Bind the host window so open/close drive its visibility. */
  setWindow(win: ManagedWindow): void {
    this.win = win;
  }

  /** Open (or switch) the panel onto a building, seeding its log over HTTP. */
  async open(buildingId: string): Promise<void> {
    this.selectedId = buildingId;
    this.events = [];
    this.win?.open();
    this.renderResources();
    this.logEl.innerHTML = `<div class="binspect__empty">loading…</div>`;

    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.renderResources(), 1000);
    }

    try {
      const log = await this.options.onFetch(buildingId);
      if (this.selectedId !== buildingId) return; // switched away while loading
      this.events = log;
      this.renderLog();
    } catch {
      if (this.selectedId === buildingId) {
        this.logEl.innerHTML = `<div class="binspect__empty">log unavailable</div>`;
      }
    }
  }

  /** Hide the window (e.g. when a villager is selected instead). */
  close(): void {
    this.win?.close();
  }

  /** Clear selection + stop the refresh timer — called when the window is closed. */
  markClosed(): void {
    this.selectedId = null;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** The building currently inspected, so callers can sync other UI (e.g. the map). */
  get selected(): string | null {
    return this.selectedId;
  }

  /** Feed one live building event. Ignored unless it belongs to the open building. */
  ingest(event: BuildingEvent): void {
    if (event.buildingId !== this.selectedId) return;
    this.events.push(event);
    this.renderLog();
    this.renderResources();
  }

  // -------------------------------------------------------------------------

  private renderResources(): void {
    if (!this.selectedId) return;
    const b = this.options.getBuilding(this.selectedId);
    if (!b) {
      this.titleEl.textContent = this.selectedId;
      this.resourcesEl.innerHTML = '';
      return;
    }
    this.titleEl.textContent = b.name;
    const kinds = buildingStockKinds(b.kind);
    if (kinds.length === 0) {
      this.resourcesEl.innerHTML =
        `<div class="binspect__meta">${escapeHtml(b.function ?? b.kind)}</div>` +
        `<div class="binspect__nores">no resources stored here</div>`;
      return;
    }
    const bars = kinds.map((r) => this.resourceBar(r, Math.round(b.stock[r] ?? 0), b.capacity)).join('');
    this.resourcesEl.innerHTML =
      `<div class="binspect__meta">${escapeHtml(b.function ?? b.kind)}</div>${bars}`;
  }

  private resourceBar(resource: ResourceKind, value: number, capacity: number): string {
    const pct = capacity > 0 ? Math.max(0, Math.min(100, (value / capacity) * 100)) : 0;
    const low = value <= 0;
    return `
      <div class="binspect__res">
        <span class="binspect__reslabel">${resource}</span>
        <span class="binspect__bar"><span class="binspect__fill${low ? ' binspect__fill--empty' : ''}"
          style="width:${pct}%"></span></span>
        <span class="binspect__resval">${value}/${capacity}</span>
      </div>`;
  }

  private renderLog(): void {
    if (this.events.length === 0) {
      this.logEl.innerHTML = `<div class="binspect__empty">no activity yet…</div>`;
      return;
    }
    // Newest first.
    const rows = this.events
      .slice()
      .reverse()
      .map((e) => {
        const icon = EVENT_ICON[e.kind] ?? '•';
        return `<div class="binspect__line">
          <span class="binspect__time">${escapeHtml(formatSimClock(e.tick))}</span>
          <span class="binspect__evt">${icon} ${escapeHtml(describeEvent(e))}</span>
        </div>`;
      })
      .join('');
    this.logEl.innerHTML = rows;
  }
}

/** A short human line for one building event. */
function describeEvent(e: BuildingEvent): string {
  const who = e.actorName ? e.actorName.split(/\s+/)[0] : 'someone';
  switch (e.kind) {
    case 'take':
      return `${who} took ${e.amount} ${e.resource}`;
    case 'give':
      return `${who} brought ${e.amount} ${e.resource}`;
    case 'work_started':
      return `${who} started working`;
    case 'work_finished':
      return `${who} ${e.note ?? 'finished working'}`;
    case 'work_refused':
      return `${who} could not work — ${e.note ?? 'nothing to do'}`;
    case 'depleted':
      return `ran out of ${e.resource}`;
    case 'filled':
      return `${e.resource} store is full`;
    case 'site_opened':
      return `${who} began a building project${e.note ? ` — ${e.note}` : ''}`;
    case 'completed':
      return `${who} finished it${e.note ? ` — ${e.note}` : ''}`;
  }
}
