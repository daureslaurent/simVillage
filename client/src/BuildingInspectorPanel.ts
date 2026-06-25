/**
 * client/src/BuildingInspectorPanel.ts
 * ---------------------------------------------------------------------------
 * The BUILDING INSPECTOR.
 *
 * A right-docked side panel that opens when you click a building on the map. It is
 * SECTIONED, adapting to whatever kind of building you clicked:
 *
 *   • GUIDE       — what the place is and how a villager uses it (the same prose
 *                   the villagers' `building_guide` tool reads, from shared/buildings).
 *   • RESOURCES   — for a finished economy building: live stock bars (water, food…).
 *     · BUILD     — for a construction site instead: gathered-vs-required progress,
 *                   so a half-built shell shows exactly what it still needs (this is
 *                   what was previously a blank "no resources stored here").
 *   • ACTIVITY    — the rolling log of what has recently happened here.
 *   • FLEET       — for the technical DEPOT only: every robot-cart in the village
 *                   with its cargo, order and live state (idle / hauling / waiting,
 *                   and why). Click a cart to locate it on the map.
 *
 * The log is seeded from the server's rolling window over HTTP, then kept live: each
 * `building.event` push for this building is appended. The live readouts (stock,
 * build progress, fleet) refresh on a light interval while open, since they drift
 * every tick without always emitting an event.
 *
 * The panel owns its DOM and stays oblivious to the network — `main.ts` injects the
 * log fetcher, the building/cart lookups and a "locate cart" callback, and feeds it
 * live events.
 * ---------------------------------------------------------------------------
 */

import type { Building, BuildingEvent, Cart, ResourceKind } from '../../shared/types';
import type { ManagedWindow } from './WindowManager';
import { buildingGuideLines, buildingStockKinds, isConstructionSite, isDepot } from '../../shared/buildings';
import { formatSimClock } from '../../shared/simClock';
import { escapeHtml } from './modal';

export interface BuildingInspectorOptions {
  /** Load a building's recent activity log (oldest first). */
  onFetch: (buildingId: string) => Promise<BuildingEvent[]>;
  /** Look up a building's current state (name, stock, capacity, construction) by id. */
  getBuilding: (buildingId: string) => Building | null;
  /** The village's current robot-carts (for the depot's fleet section). */
  getCarts: () => Cart[];
  /** Locate a cart on the map (centre the camera + highlight it). */
  onFocusCart: (cartId: string) => void;
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

/** A glyph per cart phase, for the fleet readout. */
const CART_PHASE_ICON: Record<Cart['phase'], string> = {
  idle: '💤',
  toSource: '🚚',
  toDest: '🚚',
  waiting: '⏸️',
};

export class BuildingInspectorPanel {
  private readonly titleEl: HTMLElement;
  private readonly guideEl: HTMLElement;
  private readonly resourcesEl: HTMLElement;
  private readonly fleetEl: HTMLElement;
  private readonly logEl: HTMLElement;

  /** The host window — open/close delegate to it (wired by main via setWindow). */
  private win: ManagedWindow | null = null;
  /** The building currently inspected, or null when the panel is closed. */
  private selectedId: string | null = null;
  /** The log entries shown, newest last; rendered newest-first. */
  private events: BuildingEvent[] = [];
  /** Periodic live refresh (stock / build progress / fleet) while open. */
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
      <div class="binspect__guide"></div>
      <div class="binspect__resources"></div>
      <div class="binspect__fleet"></div>
      <div class="binspect__loghead">Activity (last few hours)</div>
      <div class="binspect__log"></div>`;

    this.titleEl = root.querySelector('.binspect__title')!;
    this.guideEl = root.querySelector('.binspect__guide')!;
    this.resourcesEl = root.querySelector('.binspect__resources')!;
    this.fleetEl = root.querySelector('.binspect__fleet')!;
    this.logEl = root.querySelector('.binspect__log')!;

    // The fleet list locates a cart on the map when clicked (delegated, since the
    // rows are re-rendered every refresh).
    this.fleetEl.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.binspect__cart');
      const id = row?.dataset.cartId;
      if (id) this.options.onFocusCart(id);
    });
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
    this.renderLive();
    this.logEl.innerHTML = `<div class="binspect__empty">loading…</div>`;

    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.renderLive(), 1000);
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
    this.renderLive();
  }

  // -------------------------------------------------------------------------

  /** Re-render every live section (guide, resources/build, fleet) from current state. */
  private renderLive(): void {
    if (!this.selectedId) return;
    const b = this.options.getBuilding(this.selectedId);
    if (!b) {
      this.titleEl.textContent = this.selectedId;
      this.guideEl.innerHTML = '';
      this.resourcesEl.innerHTML = '';
      this.fleetEl.innerHTML = '';
      return;
    }
    this.titleEl.textContent = b.name;
    this.renderGuide(b);
    this.renderResources(b);
    this.renderFleet(b);
  }

  /** GUIDE: what the place is and how it is used — shared prose, the building_guide voice. */
  private renderGuide(b: Building): void {
    const lines = buildingGuideLines(b.kind);
    // The first line restates the per-kind purpose; for invented landmarks the
    // building carries its OWN function, so prefer that headline.
    const headline = b.function && b.kind === 'landmark' ? b.function : lines[0];
    const rest = lines.slice(1);
    this.guideEl.innerHTML =
      `<div class="binspect__sechead">Guide</div>` +
      `<div class="binspect__guideline">${escapeHtml(headline)}</div>` +
      rest.map((l) => `<div class="binspect__guideline binspect__guideline--how">${escapeHtml(l)}</div>`).join('');
  }

  /** RESOURCES, or BUILD PROGRESS when the building is still a construction site. */
  private renderResources(b: Building): void {
    if (isConstructionSite(b.kind) && b.construction) {
      const req = b.construction.required;
      const kinds = Object.keys(req) as ResourceKind[];
      const remaining = kinds.reduce((sum, r) => sum + Math.max(0, (req[r] ?? 0) - (b.stock[r] ?? 0)), 0);
      const bars = kinds
        .map((r) => this.progressBar(r, Math.round(b.stock[r] ?? 0), req[r] ?? 0))
        .join('');
      const status =
        remaining > 0
          ? `<div class="binspect__buildnote">Haul the missing materials here and give them to the site to raise it.</div>`
          : `<div class="binspect__buildnote binspect__buildnote--done">All materials gathered — finishing.</div>`;
      this.resourcesEl.innerHTML =
        `<div class="binspect__sechead">Build progress</div>${bars}${status}`;
      return;
    }

    const kinds = buildingStockKinds(b.kind);
    if (kinds.length === 0) {
      this.resourcesEl.innerHTML =
        `<div class="binspect__sechead">Resources</div>` +
        `<div class="binspect__nores">no resources stored here</div>`;
      return;
    }
    const bars = kinds.map((r) => this.resourceBar(r, Math.round(b.stock[r] ?? 0), b.capacity)).join('');
    this.resourcesEl.innerHTML = `<div class="binspect__sechead">Resources</div>${bars}`;
  }

  /** FLEET: every robot-cart in the village, shown only for the technical depot. */
  private renderFleet(b: Building): void {
    if (!isDepot(b.kind)) {
      this.fleetEl.innerHTML = '';
      return;
    }
    const carts = this.options.getCarts();
    if (carts.length === 0) {
      this.fleetEl.innerHTML =
        `<div class="binspect__sechead">Fleet</div>` +
        `<div class="binspect__nores">no robot-carts yet — build a handcart or freight cart</div>`;
      return;
    }
    const rows = carts.map((c) => this.cartRow(c)).join('');
    this.fleetEl.innerHTML =
      `<div class="binspect__sechead">Fleet (${carts.length}) — click to locate</div>${rows}`;
  }

  private cartRow(c: Cart): string {
    const icon = CART_PHASE_ICON[c.phase] ?? '•';
    const cargoKind = c.cargo[0];
    const cargo = cargoKind ? `${c.cargo.length}/${c.capacity} ${cargoKind}` : 'empty';
    const order = c.order
      ? `${c.order.resource}: ${this.buildingName(c.order.fromBuildingId)} → ${this.buildingName(c.order.toBuildingId)}`
      : 'no order';
    const state =
      c.phase === 'waiting'
        ? `waiting${c.waitReason ? ` — ${c.waitReason}` : ''}`
        : c.phase === 'idle' && !c.order
          ? 'idle'
          : c.phase === 'toSource'
            ? 'driving to load'
            : c.phase === 'toDest'
              ? 'driving to unload'
              : c.phase;
    return `
      <div class="binspect__cart${c.phase === 'waiting' ? ' binspect__cart--wait' : ''}" data-cart-id="${escapeHtml(c.id)}">
        <div class="binspect__cartname">${icon} ${escapeHtml(c.name)}</div>
        <div class="binspect__cartmeta">${escapeHtml(cargo)} · ${escapeHtml(order)}</div>
        <div class="binspect__cartstate">${escapeHtml(state)}</div>
      </div>`;
  }

  /** Resolve a building id to its name for an order line (falls back to the raw id). */
  private buildingName(id: string): string {
    return this.options.getBuilding(id)?.name ?? id;
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

  /** A build-progress bar: gathered out of required for one material (green when met). */
  private progressBar(resource: ResourceKind, value: number, required: number): string {
    const pct = required > 0 ? Math.max(0, Math.min(100, (value / required) * 100)) : 100;
    const done = value >= required;
    return `
      <div class="binspect__res">
        <span class="binspect__reslabel">${resource}</span>
        <span class="binspect__bar"><span class="binspect__fill${done ? ' binspect__fill--done' : ''}"
          style="width:${pct}%"></span></span>
        <span class="binspect__resval">${value}/${required}</span>
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
