/**
 * client/src/WindowManager.ts
 * ---------------------------------------------------------------------------
 * A lightweight FLOATING-WINDOW system for the whole HUD.
 *
 * Every panel (roster, debug, conversations, the inspectors, …) lives inside a
 * window the user can DRAG by its titlebar, RESIZE from its bottom-right grip,
 * MINIMIZE to the bottom DOCK, and raise to the front by clicking it. Each
 * window's geometry + minimized/closed state is persisted to localStorage, so a
 * carefully arranged desktop survives a reload.
 *
 * The manager is deliberately transport- and panel-agnostic: callers build a
 * panel into a host element, then hand that host to {@link WindowManager.add}.
 * The window either ADOPTS the panel's own `<header>` as its titlebar (so the
 * panel's title and toolbar buttons double as the drag handle) or SYNTHESISES a
 * titlebar when the panel has none.
 * ---------------------------------------------------------------------------
 */

const STORE_KEY = 'simvillage.windows.v2';

/** Persisted per-window geometry + visibility. */
interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
  hidden: boolean;
  z: number;
}

type Store = Record<string, Partial<Geom>>;

export interface WindowSpec {
  /** Stable id; the localStorage key and the dock-chip identity. */
  id: string;
  /** Dock-chip label (and synthesised-titlebar text). */
  title: string;
  /** A leading glyph for the dock chip / synthesised titlebar. */
  icon: string;
  /** Default geometry, used the first time (before anything is persisted). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Minimum size while resizing. */
  minW?: number;
  minH?: number;
  /** Show a ✕ that hides the window and fires {@link WindowSpec.onClose}. */
  closable?: boolean;
  /** Allow the bottom-right resize grip (default true). */
  resizable?: boolean;
  /** Start hidden — for on-demand windows like the inspectors. */
  startHidden?: boolean;
  /** Build a titlebar instead of adopting the panel's first `<header>`. */
  synthBar?: boolean;
  /** Fired when the user closes the window via its ✕ or dock chip. */
  onClose?: () => void;
}

export interface ManagedWindow {
  readonly id: string;
  /** The element the panel was built into (its content host). */
  readonly body: HTMLElement;
  /** Update the synthesised titlebar text + the dock chip label. */
  setTitle(title: string): void;
  /** Show (if hidden), restore (if minimized) and bring to the front. */
  open(): void;
  /** Hide the window (dock chip dims). Fires onClose. */
  close(): void;
  /** Raise above the other windows. */
  focus(): void;
  /** True when the window is shown and not minimized. */
  isOpen(): boolean;
}

function loadStore(): Store {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Store;
  } catch {
    return {};
  }
}

export class WindowManager {
  private readonly desktop: HTMLElement;
  private readonly dock: HTMLElement;
  private readonly wins = new Map<string, WinImpl>();
  private store: Store = loadStore();
  private z = 10;

  constructor() {
    this.desktop = document.createElement('div');
    this.desktop.className = 'desktop';
    this.dock = document.createElement('div');
    this.dock.className = 'dock';
    document.body.append(this.desktop, this.dock);

    // Keep windows on-screen when the browser viewport shrinks.
    window.addEventListener('resize', () => {
      for (const w of this.wins.values()) w.clampIntoView();
    });
  }

  /** Wrap a panel host in a window and register its dock chip. */
  add(host: HTMLElement, spec: WindowSpec): ManagedWindow {
    const win = new WinImpl(this, host, spec, this.store[spec.id]);
    this.wins.set(spec.id, win);
    this.desktop.appendChild(win.el);
    this.dock.appendChild(win.chip);
    return win;
  }

  /** A "tidy" command: reset every window to its default geometry. */
  resetLayout(): void {
    localStorage.removeItem(STORE_KEY);
    this.store = {};
    for (const w of this.wins.values()) w.resetToDefault();
  }

  // — internals used by WinImpl —

  /** Allocate the next top z-index (called on focus). */
  raise(): number {
    return ++this.z;
  }

  persist(id: string, geom: Partial<Geom>): void {
    this.store[id] = { ...this.store[id], ...geom };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.store));
    } catch {
      /* storage full / unavailable — geometry just won't persist */
    }
  }
}

/** Selectors whose clicks should never start a window drag. */
const NO_DRAG = 'button, a, input, textarea, select, summary, .win__controls';

class WinImpl implements ManagedWindow {
  readonly id: string;
  readonly el: HTMLElement;
  readonly chip: HTMLButtonElement;
  readonly body: HTMLElement;

  private readonly bar: HTMLElement;
  private readonly titleEl: HTMLElement | null;
  private readonly spec: WindowSpec;
  private readonly mgr: WindowManager;
  private minimized = false;
  private hidden = false;

  constructor(mgr: WindowManager, host: HTMLElement, spec: WindowSpec, saved?: Partial<Geom>) {
    this.mgr = mgr;
    this.spec = spec;
    this.id = spec.id;
    this.body = host;
    host.classList.add('win__body');

    this.el = document.createElement('div');
    this.el.className = 'win';
    this.el.dataset.win = spec.id;

    // Titlebar: adopt the panel's own header, or synthesise one.
    if (spec.synthBar) {
      const bar = document.createElement('header');
      bar.className = 'win__bar win__bar--synth';
      bar.innerHTML =
        `<span class="win__icon">${spec.icon}</span>` +
        `<span class="win__title">${spec.title}</span>`;
      this.el.append(bar, host);
      this.bar = bar;
      this.titleEl = bar.querySelector('.win__title');
    } else {
      this.el.append(host);
      const found = host.querySelector(':scope > header');
      // Fall back to a synthesised bar if the panel has no header.
      if (found) {
        this.bar = found as HTMLElement;
        this.bar.classList.add('win__bar');
        this.titleEl = this.bar.querySelector('.win__title');
      } else {
        const bar = document.createElement('header');
        bar.className = 'win__bar win__bar--synth';
        bar.innerHTML = `<span class="win__icon">${spec.icon}</span><span class="win__title">${spec.title}</span>`;
        host.prepend(bar);
        this.bar = bar;
        this.titleEl = bar.querySelector('.win__title');
      }
    }

    // Window controls (minimize + optional close), pinned to the bar's right.
    const controls = document.createElement('div');
    controls.className = 'win__controls';
    const minBtn = document.createElement('button');
    minBtn.className = 'win__ctl win__ctl--min';
    minBtn.title = 'Minimize';
    minBtn.setAttribute('aria-label', 'Minimize');
    minBtn.textContent = '–';
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.minimize();
    });
    controls.appendChild(minBtn);
    if (spec.closable) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'win__ctl win__ctl--close';
      closeBtn.title = 'Close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
      controls.appendChild(closeBtn);
    }
    this.bar.appendChild(controls);

    // Resize grip.
    if (spec.resizable !== false) {
      const grip = document.createElement('div');
      grip.className = 'win__grip';
      grip.addEventListener('pointerdown', (e) => this.beginResize(e));
      this.el.appendChild(grip);
    }

    // Dock chip — click to toggle / focus.
    this.chip = document.createElement('button');
    this.chip.className = 'dock__chip';
    this.chip.innerHTML = `<span class="dock__icon">${spec.icon}</span><span class="dock__label">${spec.title}</span>`;
    this.chip.addEventListener('click', () => this.onChipClick());

    // Wire drag + focus.
    this.bar.addEventListener('pointerdown', (e) => this.beginDrag(e));
    this.el.addEventListener('pointerdown', () => this.focus(), true);

    // Apply geometry: persisted state wins over defaults.
    this.applyGeom({
      x: saved?.x ?? spec.x,
      y: saved?.y ?? spec.y,
      w: saved?.w ?? spec.w,
      h: saved?.h ?? spec.h,
    });
    this.minimized = saved?.min ?? false;
    this.hidden = saved?.hidden ?? spec.startHidden ?? false;
    if (saved?.z) this.el.style.zIndex = String(saved.z);
    this.reflectVisibility();
  }

  // — geometry —

  private applyGeom(g: { x: number; y: number; w: number; h: number }): void {
    this.el.style.left = `${Math.round(g.x)}px`;
    this.el.style.top = `${Math.round(g.y)}px`;
    this.el.style.width = `${Math.round(g.w)}px`;
    this.el.style.height = `${Math.round(g.h)}px`;
  }

  private save(): void {
    const r = this.el.getBoundingClientRect();
    this.mgr.persist(this.spec.id, {
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      min: this.minimized,
      hidden: this.hidden,
      z: Number(this.el.style.zIndex) || undefined,
    });
  }

  resetToDefault(): void {
    this.applyGeom(this.spec);
    this.minimized = false;
    this.hidden = this.spec.startHidden ?? false;
    this.reflectVisibility();
  }

  clampIntoView(): void {
    const r = this.el.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - 80);
    const maxY = Math.max(0, window.innerHeight - 80);
    const x = Math.min(r.left, maxX);
    const y = Math.min(Math.max(r.top, 48), maxY);
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }

  // — drag / resize —

  private beginDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(NO_DRAG)) return; // let buttons/tabs work
    e.preventDefault();
    this.focus();
    const start = this.el.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    this.el.classList.add('win--dragging');

    const move = (ev: PointerEvent): void => {
      const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 60);
      const y = Math.min(Math.max(44, ev.clientY - dy), window.innerHeight - 40);
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.el.classList.remove('win--dragging');
      this.save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private beginResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.focus();
    const start = this.el.getBoundingClientRect();
    const minW = this.spec.minW ?? 220;
    const minH = this.spec.minH ?? 120;
    this.el.classList.add('win--resizing');

    const move = (ev: PointerEvent): void => {
      const w = Math.max(minW, ev.clientX - start.left);
      const h = Math.max(minH, ev.clientY - start.top);
      this.el.style.width = `${w}px`;
      this.el.style.height = `${h}px`;
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.el.classList.remove('win--resizing');
      this.save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // — visibility / focus —

  focus(): void {
    const z = this.mgr.raise();
    this.el.style.zIndex = String(z);
    for (const c of document.querySelectorAll('.win--active')) c.classList.remove('win--active');
    this.el.classList.add('win--active');
    this.save();
  }

  open(): void {
    this.hidden = false;
    this.minimized = false;
    this.reflectVisibility();
    this.focus();
  }

  close(): void {
    this.hidden = true;
    this.reflectVisibility();
    this.save();
    this.spec.onClose?.();
  }

  minimize(): void {
    this.minimized = true;
    this.reflectVisibility();
    this.save();
  }

  isOpen(): boolean {
    return !this.hidden && !this.minimized;
  }

  private onChipClick(): void {
    if (this.hidden || this.minimized) {
      this.open();
    } else if (this.el.classList.contains('win--active')) {
      // Clicking the active window's chip tucks it away.
      this.minimize();
    } else {
      this.focus();
    }
  }

  private reflectVisibility(): void {
    this.el.classList.toggle('win--hidden', this.hidden);
    this.el.classList.toggle('win--min', this.minimized);
    const tucked = this.hidden || this.minimized;
    this.chip.classList.toggle('dock__chip--off', tucked);
    this.chip.classList.toggle('dock__chip--on', !tucked);
  }

  setTitle(title: string): void {
    if (this.titleEl) this.titleEl.textContent = title;
    const label = this.chip.querySelector('.dock__label');
    if (label) label.textContent = title;
  }
}
