/**
 * client/src/Renderer.ts
 * ---------------------------------------------------------------------------
 * The Viewport. Draws the world view onto a full-screen HTML5 Canvas every
 * animation frame and translates clicks back into God-Hand `force_move`
 * commands.
 *
 * Coordinate spaces:
 *   - World cells   (0..width)      — what the server speaks.
 *   - CSS pixels    (the viewport)  — what the mouse speaks.
 *   - Device pixels (canvas buffer) — CSS px * devicePixelRatio, for crispness.
 *
 * A camera bridges world <-> screen: a `scale` (pixels per cell, = baseScale *
 * zoom) plus a `panX/panY` translation in CSS pixels:
 *
 *     screenX = worldX * scale + panX
 *     worldX  = (screenX - panX) / scale
 *
 * The mouse wheel zooms toward the cursor; dragging pans; a click that didn't
 * drag is the God Hand.
 * ---------------------------------------------------------------------------
 */

import type { AgentDecision, Building, LlmCallStartedMessage, LlmCallFinishedMessage, ResourceKind, Villager, VillagerNeeds, VillagerThoughtMessage, Tree, WeatherKind } from '../../shared/types';
import { BACKPACK_CAPACITY } from '../../shared/types';
import { buildingStockKinds, isDepleted, SERVICE_REACH } from '../../shared/buildings';
import { daylightFromTick } from '../../shared/simClock';
import { sightRadius, hearingRadius } from '../../shared/perception';
import type { NetworkClient, WorldView } from './NetworkClient';

/** A short glyph per resource kind, for the compact building stock readout. */
const RESOURCE_ICON: Record<ResourceKind, string> = {
  water: '💧',
  food: '🍞',
  wood: '🪵',
  goods: '📦',
  stone: '🪨',
};

/** The villager the God Hand commands by default (per the Phase 1 spec). */
const GOD_HAND_TARGET = 'villager_1';

/** How long an action bubble lingers above a villager (ms). Speech lasts longer. */
const BUBBLE_TTL_MS = 4500;
const SPEECH_TTL_MS = 8000;
/** A status/action popup lingers a touch longer than a plain action bubble. */
const STATUS_TTL_MS = 5000;
/** The bubble fades out over its final stretch (ms). */
const BUBBLE_FADE_MS = 700;

/** A transient "what I'm doing" bubble shown above a villager. */
interface Bubble {
  text: string;
  /** Epoch ms after which the bubble is gone. */
  until: number;
  /** A status/action popup is rendered in italics with a distinct tint; speech is upright. */
  status?: boolean;
}

/** A translucent full-screen wash per weather, layered over the map. null = clear. */
const WEATHER_TINT: Record<WeatherKind, string | null> = {
  clear: null,
  rain: 'rgba(64, 110, 170, 0.22)',
  storm: 'rgba(30, 40, 70, 0.42)',
  fog: 'rgba(200, 205, 215, 0.28)',
  heatwave: 'rgba(220, 130, 40, 0.20)',
};

/** Zoom clamp, as a multiple of the fit-to-screen base scale. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 40;

/** A pointer that moved more than this (CSS px) between down and up is a drag, not a click. */
const CLICK_SLOP = 5;

/**
 * Always-on villager stat card geometry, in screen pixels (it never scales with
 * zoom, so it stays readable). Height is fixed so speech bubbles can reliably
 * stack above it. Layout: name (13) + status (12) + need bars (9) + backpack (11),
 * each separated by a 3px gap, inside a 6px pad — which sums to CARD_HEIGHT.
 */
const CARD_W = 118;
const CARD_PAD = 6;
const CARD_ROW_GAP = 3;
const CARD_NAME_H = 13;
const CARD_STATUS_H = 12;
const CARD_BARS_H = 9;
const CARD_PACK_H = 11;
const CARD_HEIGHT =
  CARD_PAD +
  CARD_NAME_H + CARD_ROW_GAP +
  CARD_STATUS_H + CARD_ROW_GAP +
  CARD_BARS_H + CARD_ROW_GAP +
  CARD_PACK_H +
  CARD_PAD;
/** Gap between a villager's body and the bottom of its stat card. */
const CARD_GAP = 8;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  /** Camera: pixels-per-cell = baseScale * zoom, translated by pan (CSS px). */
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** Fit-to-viewport pixels-per-cell, recomputed on resize / world (re)init. */
  private baseScale = 1;
  /** Has the camera been framed for the current world dimensions yet? */
  private framedFor = -1;

  /** Drag bookkeeping. */
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private downAt = { x: 0, y: 0 };
  private moved = 0;

  /** Lookup of occupied tree tiles ("x,y") so clicks on trees are ignored client-side. */
  private treeTiles = new Set<string>();

  /** Live "what I'm doing" bubbles, keyed by villager id; pruned as they expire. */
  private readonly bubbles = new Map<string, Bubble>();

  /** Display names learned from the thought stream, keyed by villager id. */
  private readonly names = new Map<string, string>();

  /** Last status seen per villager, so a CHANGE can pop an action popup. */
  private readonly lastStatus = new Map<string, string>();

  /**
   * The villager-think LLM calls in flight right now, keyed by engine-call id, each
   * carrying the agent label (villager name) and when it started. Fed by the engine
   * telemetry stream (`engine.llm.started`/`finished`); used to PULSE the sense disc
   * of any villager currently running its mind. Pruned on finish, with a stale-age
   * guard so a dropped `finished` can't leave a disc blinking forever.
   */
  private readonly thinkingCalls = new Map<number, { agent: string; startedAt: number }>();
  /** How long (ms) a think call may stay "in flight" before we treat it as stale. */
  private static readonly THINK_STALE_MS = 150_000;

  /** Until when (epoch ms) a storm lightning flash is still fading. */
  private stormFlashUntil = 0;

  /** The currently-selected villager (highlighted + inspected), or null. */
  private selectedId: string | null = null;
  /** Hook fired when a click selects a villager — the UI opens its inspector. */
  onSelectVillager: ((villagerId: string) => void) | null = null;
  /** The currently-selected building (highlighted + inspected), or null. */
  private selectedBuildingId: string | null = null;
  /** Hook fired when a click selects a building — the UI opens its inspector. */
  onSelectBuilding: ((buildingId: string) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly net: NetworkClient,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    this.canvas.addEventListener('pointerup', () => this.handlePointerUp());
    this.canvas.addEventListener('pointercancel', () => this.endDrag());
  }

  /** Kick off the render loop. */
  start(): void {
    const frame = (): void => {
      this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------

  /** Size the canvas buffer to the window (in device pixels) for crisp output. */
  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.framedFor = -1; // re-frame the world for the new aspect ratio
  }

  /** Viewport size in CSS pixels. */
  private get cssWidth(): number {
    return this.canvas.clientWidth;
  }
  private get cssHeight(): number {
    return this.canvas.clientHeight;
  }

  /** Center the world and pick a base scale that fits it, with a little margin. */
  private frameWorld(width: number, height: number): void {
    this.baseScale = Math.min(this.cssWidth / width, this.cssHeight / height) * 0.92;
    this.zoom = 1;
    const s = this.baseScale;
    this.panX = (this.cssWidth - width * s) / 2;
    this.panY = (this.cssHeight - height * s) / 2;
    this.framedFor = width * 100000 + height;
  }

  /** Effective pixels-per-cell. */
  private get scale(): number {
    return this.baseScale * this.zoom;
  }

  private draw(): void {
    const view = this.net.getState();
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;

    // Watch for villagers starting a new action, popping a status popup each time.
    this.trackStatusChanges(view.villagers);

    // Reset transform, then map CSS px -> device px so all drawing below is in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear.
    ctx.fillStyle = '#161b22';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    if (view.width === 0 || view.height === 0) return; // not initialized yet

    if (this.framedFor !== view.width * 100000 + view.height) {
      this.frameWorld(view.width, view.height);
    }

    const scale = this.scale;

    this.drawGrid(view.width, view.height, scale);

    // Buildings: filled rectangular footprints with a label when zoomed in enough.
    this.drawBuildings(view.buildings, scale);

    // Trees: static green squares.
    ctx.fillStyle = '#2ea043';
    const treeSize = Math.max(2, scale);
    for (const tree of view.trees) {
      ctx.fillRect(
        tree.position.x * scale + this.panX,
        tree.position.y * scale + this.panY,
        treeSize,
        treeSize,
      );
    }

    // Perception range: a faint disc around each villager showing how far it can
    // see and hear (vision and hearing share one radius). Drawn under the bodies.
    this.drawSenseRanges(view, scale);

    // Gatherings: a soft hull + label around each cluster of 2+ villagers.
    this.drawGatherings(view, scale);

    // Villagers: colored circles, with a faint line to their current target.
    const villagerRadius = Math.max(3, scale * 1.5);
    for (const villager of view.villagers) {
      const ax = villager.position.x * scale + this.panX;
      const ay = villager.position.y * scale + this.panY;

      if (villager.target) {
        ctx.strokeStyle = 'rgba(201, 209, 217, 0.35)';
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(villager.target.x * scale + this.panX, villager.target.y * scale + this.panY);
        ctx.stroke();
      }

      // Body: a filled disc with a dark outline, plus a small lighter "head"
      // notch so a villager reads as a little figure rather than a flat dot.
      ctx.fillStyle = villager.color;
      ctx.beginPath();
      ctx.arc(ax, ay, villagerRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(13, 17, 23, 0.8)';
      ctx.lineWidth = Math.max(1, villagerRadius * 0.18);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.beginPath();
      ctx.arc(ax, ay - villagerRadius * 0.32, villagerRadius * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;

      // Asleep: a little floating "💤" that gently bobs above the body, so a
      // sleeping villager (whose mind is dark) reads at a glance on the map.
      if (villager.asleep) {
        ctx.save();
        const bob = Math.sin(Date.now() / 400 + ax) * 2;
        ctx.font = `${Math.max(12, villagerRadius * 1.2)}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('💤', ax + villagerRadius * 0.9, ay - villagerRadius - 2 + bob);
        ctx.restore();
      }

      // Selected villager: a bright ring so you can see whose mind you're reading.
      if (villager.id === this.selectedId) {
        ctx.strokeStyle = '#f0f6fc';
        ctx.lineWidth = Math.max(1.5, villagerRadius * 0.35);
        ctx.beginPath();
        ctx.arc(ax, ay, villagerRadius + ctx.lineWidth, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Robot-carts: little wagons that drive their hauling loop on their own.
    this.drawCarts(view, scale);

    // The sky: a day/night wash driven by the in-world clock (dark at night, a warm
    // band at dawn/dusk), then the weather over it (rain/storm streaks, fog haze).
    this.drawDayNight(view);
    this.drawWeather(view);

    // Always-on stat cards (status + needs + backpack), then speech bubbles above
    // them — both over the weather wash so they stay legible.
    this.drawVillagerCards(view, scale, villagerRadius);
    this.drawBubbles(view, scale, villagerRadius);
    void canvas;
  }

  /**
   * Draw each villager's perception as TWO concentric discs — what it can HEAR
   * (the wider, cooler ring) and what it can SEE (the inner, brighter disc).
   * Both shrink and grow live with the time of day and the weather: sight pulls
   * in at dusk and in fog, hearing pulls in under a storm. The radii are DERIVED
   * locally from the current tick + weather (no longer streamed), the same pure
   * helpers the engine and minds use, so the rings match what villagers sense.
   *
   * A villager whose mind is RUNNING right now (a `/decide` LLM call in flight)
   * gets a warm amber sight disc that PULSES, so you can see who is "thinking".
   */
  private drawSenseRanges(view: WorldView, scale: number): void {
    if (view.villagers.length === 0) return;
    const sight = sightRadius(view.tick, view.weather) * scale;
    const hearing = hearingRadius(view.tick, view.weather) * scale;
    if (sight <= 0 && hearing <= 0) return;
    const { ctx } = this;
    const active = this.activeThinkers();
    // A smooth 0..1 pulse (~1s period), driven by wall-clock so it animates every
    // frame regardless of sim cadence.
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 160);
    ctx.save();
    for (const villager of view.villagers) {
      const ax = villager.position.x * scale + this.panX;
      const ay = villager.position.y * scale + this.panY;
      const thinking = active.has(villager.name) || active.has(villager.id);

      // HEARING — the outer reach. A faint, cool wash with a hairline ring, drawn
      // first so the sight disc sits brightly on top. Only when it extends past
      // sight (otherwise it would just smear the sight ring).
      if (hearing > sight) {
        ctx.beginPath();
        ctx.arc(ax, ay, hearing, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 180, 255, 0.04)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(120, 180, 255, 0.16)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // SIGHT — the inner disc, brighter, the same look the single ring used to have.
      ctx.beginPath();
      ctx.arc(ax, ay, sight, 0, Math.PI * 2);
      if (thinking) {
        // Warm amber, breathing in and out, so a thinking mind stands out from the
        // quiet blue of an idle one.
        ctx.fillStyle = `rgba(240, 200, 90, ${0.08 + 0.20 * pulse})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(245, 205, 95, ${0.4 + 0.45 * pulse})`;
        ctx.lineWidth = 1.5 + pulse;
      } else {
        ctx.fillStyle = 'rgba(88, 166, 255, 0.06)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(88, 166, 255, 0.22)';
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The DAY/NIGHT wash. A smooth daylight level from the in-world clock dims the
   * whole viewport toward a deep blue at night and lifts it to nothing at midday,
   * with a warm orange band passing through at dawn and dusk — so the village
   * visibly lives a day, not a flat permanent noon.
   */
  private drawDayNight(view: WorldView): void {
    const { ctx } = this;
    const daylight = daylightFromTick(view.tick); // 0 deep night … 1 midday
    const night = 1 - daylight;
    if (night > 0.03) {
      ctx.fillStyle = `rgba(9, 14, 34, ${(night * 0.6).toFixed(3)})`;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }
    // A warm band peaks where daylight is mid (the golden hours of dawn & dusk).
    const warm = Math.max(0, 1 - Math.abs(daylight - 0.32) / 0.32);
    if (warm > 0.02) {
      ctx.fillStyle = `rgba(255, 138, 48, ${(warm * 0.11).toFixed(3)})`;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }
  }

  /**
   * The WEATHER over the day/night wash: a translucent colour tint per kind, plus
   * falling rain streaks (denser in a storm) and the odd lightning flash. Fog is
   * just its pale haze. Drawn in screen space so it never scales with zoom.
   */
  private drawWeather(view: WorldView): void {
    const { ctx } = this;
    const tint = WEATHER_TINT[view.weather];
    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }
    if (view.weather === 'rain' || view.weather === 'storm') {
      this.drawRain(view.weather === 'storm');
    }
    if (view.weather === 'storm') this.drawLightning();
  }

  /** Falling rain: procedural diagonal streaks animated off the wall clock. */
  private drawRain(heavy: boolean): void {
    const { ctx } = this;
    const W = this.cssWidth;
    const H = this.cssHeight;
    const t = Date.now();
    const count = heavy ? 260 : 130;
    const len = heavy ? 18 : 13;
    const slant = heavy ? 6 : 4;
    const speed = heavy ? 1.3 : 0.85;
    const wrap = H + 40;

    ctx.save();
    ctx.strokeStyle = heavy ? 'rgba(178, 196, 235, 0.34)' : 'rgba(156, 180, 224, 0.26)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = rnd(i + 0.5) * W;
      const y = (rnd(i) * wrap + t * speed * 0.06) % wrap;
      ctx.moveTo(x, y);
      ctx.lineTo(x - slant, y + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** An occasional brief white flash, so a storm crackles rather than just rains. */
  private drawLightning(): void {
    const now = Date.now();
    if (now > this.stormFlashUntil && Math.random() < 0.006) {
      this.stormFlashUntil = now + 150;
    }
    if (now < this.stormFlashUntil) {
      const a = ((this.stormFlashUntil - now) / 150) * 0.22;
      this.ctx.fillStyle = `rgba(225, 232, 255, ${a.toFixed(3)})`;
      this.ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }
  }

  /**
   * Draw each gathering as a soft, dashed purple hull enclosing its members with
   * a label naming the place and headcount — so social clusters read at a glance.
   */
  /**
   * Draw each robot-cart as a little wagon: a rounded body in its tier colour, a
   * route line to where it is currently headed, a cargo-fill bar, and (when zoomed
   * in enough) a name + status label. Distinct from the round villager bodies so a
   * cart reads instantly as a vehicle, and its status ("→ Workshop", "waiting: full")
   * shows what its standing order is doing without opening anything.
   */
  private drawCarts(view: WorldView, scale: number): void {
    const carts = view.carts;
    if (!carts || carts.length === 0) return;
    const { ctx } = this;
    // Wagon half-extent in pixels: scales with zoom but never vanishes.
    const half = Math.max(4, scale * 1.1);

    ctx.save();
    for (const cart of carts) {
      const cx = cart.position.x * scale + this.panX;
      const cy = cart.position.y * scale + this.panY;

      // Route line to the current heading (faint), like a villager's target line.
      if (cart.target) {
        ctx.strokeStyle = 'rgba(245, 222, 179, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cart.target.x * scale + this.panX, cart.target.y * scale + this.panY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Body: a rounded rectangle in the tier colour, dark outline; a red ring when
      // it is waiting (blocked) so a stalled cart stands out.
      const w = half * 2;
      const h = half * 1.5;
      ctx.beginPath();
      ctx.roundRect(cx - half, cy - h / 2, w, h, Math.max(2, half * 0.35));
      ctx.fillStyle = cart.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1, half * 0.18);
      ctx.strokeStyle =
        cart.phase === 'waiting' ? 'rgba(248, 81, 73, 0.95)' : 'rgba(13, 17, 23, 0.85)';
      ctx.stroke();

      // Two little wheels, so it reads as a cart at a glance.
      ctx.fillStyle = 'rgba(13, 17, 23, 0.8)';
      const wheelR = Math.max(1, half * 0.28);
      for (const wx of [cx - half * 0.5, cx + half * 0.5]) {
        ctx.beginPath();
        ctx.arc(wx, cy + h / 2, wheelR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Cargo-fill bar above the body: how full it is right now.
      if (cart.capacity > 0) {
        const frac = Math.max(0, Math.min(1, cart.cargo.length / cart.capacity));
        const barW = w;
        const barH = Math.max(2, half * 0.3);
        const barY = cy - h / 2 - barH - 3;
        ctx.fillStyle = 'rgba(13, 17, 23, 0.6)';
        ctx.fillRect(cx - half, barY, barW, barH);
        if (frac > 0) {
          ctx.fillStyle = '#46d39a';
          ctx.fillRect(cx - half, barY, barW * frac, barH);
        }
      }

      // Name + status label, only when zoomed in enough to be legible.
      if (scale >= 6) {
        const status =
          cart.phase === 'waiting' && cart.waitReason
            ? `waiting: ${cart.waitReason}`
            : cart.order
              ? `${cart.order.resource} → ${this.buildingNameById(view, cart.order.toBuildingId)}`
              : 'idle — no order';
        const label = `${cart.name} · ${status}`;
        ctx.font = '600 11px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const lw = ctx.measureText(label).width + 10;
        const ly = cy + h / 2 + 5;
        ctx.fillStyle = 'rgba(13, 17, 23, 0.72)';
        ctx.beginPath();
        ctx.roundRect(cx - lw / 2, ly, lw, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#e6edf3';
        ctx.fillText(label, cx, ly + 3);
      }
    }
    ctx.restore();
  }

  /** A building's display name from its id (for a cart's destination label), or the id. */
  private buildingNameById(view: WorldView, id: string): string {
    return view.buildings.find((b) => b.id === id)?.name ?? id;
  }

  private drawGatherings(view: WorldView, scale: number): void {
    const gatherings = view.gatherings;
    if (!gatherings || gatherings.length === 0) return;
    const { ctx } = this;
    const bodyR = Math.max(3, scale * 1.5);

    ctx.save();
    for (const g of gatherings) {
      const members = g.memberIds
        .map((id) => view.villagers.find((v) => v.id === id))
        .filter((v): v is Villager => !!v);
      if (members.length < 2) continue;

      const cx = g.center.x * scale + this.panX;
      const cy = g.center.y * scale + this.panY;
      let r = 0;
      for (const m of members) {
        const mx = m.position.x * scale + this.panX;
        const my = m.position.y * scale + this.panY;
        r = Math.max(r, Math.hypot(mx - cx, my - cy));
      }
      r += bodyR + 10;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(188, 140, 255, 0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(210, 168, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label above the hull.
      const label = `👥 ${g.place ?? 'Gathering'} · ${g.memberIds.length}`;
      ctx.font = '600 12px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const w = ctx.measureText(label).width + 12;
      const lx = cx;
      const ly = cy - r - 4;
      ctx.fillStyle = 'rgba(13, 17, 23, 0.82)';
      ctx.beginPath();
      ctx.roundRect(lx - w / 2, ly - 18, w, 18, 5);
      ctx.fill();
      ctx.fillStyle = '#d2a8ff';
      ctx.fillText(label, lx, ly - 3);
    }
    ctx.restore();
  }

  /** Draw each building as a filled, outlined footprint, labelled when readable. */
  private drawBuildings(buildings: Building[], scale: number): void {
    if (buildings.length === 0) return;
    const { ctx } = this;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    for (const b of buildings) {
      const x = b.position.x * scale + this.panX;
      const y = b.position.y * scale + this.panY;
      const w = b.width * scale;
      const h = b.height * scale;

      // The INTERACTION ZONE: the footprint grown by SERVICE_REACH tiles on every
      // side — the area a villager can stand in to use this place. Drawn as a faint
      // tinted band with a dashed border so it reads as "near enough to act here",
      // matching the engine's reach exactly.
      const pad = SERVICE_REACH * scale;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(1, scale * 0.12);
      ctx.setLineDash([Math.max(2, scale * 0.6), Math.max(2, scale * 0.5)]);
      ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      ctx.fillStyle = b.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;

      // A construction site reads as "being built": a dashed hatch border over the
      // fill so it stands apart from a finished building at a glance.
      if (b.kind === 'construction_site') {
        ctx.strokeStyle = 'rgba(13, 17, 23, 0.85)';
        ctx.lineWidth = Math.max(1, scale * 0.18);
        ctx.setLineDash([Math.max(2, scale * 0.5), Math.max(2, scale * 0.4)]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }

      // A building that has run dry of every resource it serves gets a bright red
      // outline so "this place is out of stock — someone must refill it" reads at
      // a glance; healthy buildings keep their quiet dark border.
      const empty = isDepleted(b.kind, b.stock ?? {});
      const selected = b.id === this.selectedBuildingId;
      // A selected building gets a bright amber outline; an empty one red; else quiet.
      ctx.strokeStyle = selected
        ? 'rgba(240, 180, 41, 0.95)'
        : empty
          ? 'rgba(248, 81, 73, 0.95)'
          : 'rgba(13, 17, 23, 0.85)';
      ctx.lineWidth = selected || empty ? Math.max(1.5, scale * 0.25) : Math.max(1, scale * 0.15);
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 1;

      // Label the building once its footprint is large enough to read on.
      if (w >= 46 && h >= 16) {
        const fontPx = Math.max(10, Math.min(15, h * 0.3));
        ctx.font = `${fontPx}px system-ui, -apple-system, sans-serif`;
        const label = b.name;
        // Backplate for legibility against the fill.
        const textW = ctx.measureText(label).width;
        if (textW + 8 <= w) {
          ctx.fillStyle = 'rgba(13, 17, 23, 0.6)';
          ctx.fillRect(x + w / 2 - textW / 2 - 4, y + h / 2 - fontPx / 2 - 2, textW + 8, fontPx + 4);
          ctx.fillStyle = '#f0f6fc';
          ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
        }
      }

      // Live resource stock, drawn along the foot of the building when it both has
      // an economy and is large enough to read on. Construction sites show their
      // build progress the same way (materials gathered toward what they need).
      if (w >= 46 && h >= 28) this.drawBuildingStock(b, x, y, w, h);
    }
    ctx.restore();
  }

  /**
   * Draw a compact resource readout — one tiny labelled bar per stocked resource —
   * pinned to the bottom edge of a building's footprint, so its food/water/… levels
   * (and whether it has run out) are visible right on the map.
   */
  private drawBuildingStock(b: Building, x: number, y: number, w: number, h: number): void {
    const stock = b.stock ?? {};
    const { ctx } = this;
    // A construction site reads its progress against each material it still NEEDS
    // (gathered / required), not against a flat capacity — a finished bar per material
    // means the build is done.
    const site = b.kind === 'construction_site' ? b.construction : undefined;
    const kinds: ResourceKind[] = site
      ? (Object.keys(site.required) as ResourceKind[])
      : buildingStockKinds(b.kind);
    if (kinds.length === 0) return;
    const capacity = b.capacity || 1;

    const rowH = 7;
    const gap = 3;
    const padX = 4;
    const totalH = kinds.length * rowH + (kinds.length - 1) * gap + 6;
    const bx = x + padX;
    const bw = Math.min(w - padX * 2, 96);
    let by = y + h - totalH;

    // A dark backplate behind the bars keeps them legible over the building fill.
    ctx.fillStyle = 'rgba(13, 17, 23, 0.55)';
    ctx.fillRect(x, by - 3, w, totalH + 3);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '8px system-ui, -apple-system, sans-serif';
    for (const r of kinds) {
      const value = Math.max(0, Math.round(stock[r] ?? 0));
      const goal = site ? site.required[r] ?? 1 : capacity;
      const frac = Math.max(0, Math.min(1, value / goal));
      ctx.fillStyle = 'rgba(230, 237, 243, 0.9)';
      ctx.fillText(RESOURCE_ICON[r] ?? '?', bx, by + rowH / 2);
      const trackX = bx + 14;
      const trackW = Math.max(10, bw - 14);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(trackX, by, trackW, rowH);
      // A site's bars fill amber→blue as materials arrive; an economy's go red when dry.
      ctx.fillStyle = site
        ? frac >= 1 ? '#3fb950' : '#58a6ff'
        : value <= 0 ? '#f85149' : frac < 0.3 ? '#d29922' : '#3fb950';
      ctx.fillRect(trackX, by, trackW * frac, rowH);
      by += rowH + gap;
    }
  }

  private drawGrid(width: number, height: number, scale: number): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(48, 54, 61, 0.6)';
    ctx.lineWidth = 1;

    // World border, then a coarse grid (every 50 cells) so 500x500 isn't a smear.
    const x0 = this.panX;
    const y0 = this.panY;
    const x1 = width * scale + this.panX;
    const y1 = height * scale + this.panY;

    ctx.strokeRect(x0, y0, width * scale, height * scale);

    const step = 50;
    ctx.beginPath();
    for (let x = step; x < width; x += step) {
      ctx.moveTo(x * scale + this.panX, y0);
      ctx.lineTo(x * scale + this.panX, y1);
    }
    for (let y = step; y < height; y += step) {
      ctx.moveTo(x0, y * scale + this.panY);
      ctx.lineTo(x1, y * scale + this.panY);
    }
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // Camera controls.

  /** Pointer position in CSS pixels relative to the canvas. */
  private pointerPos(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const { x, y } = this.pointerPos(event);

    // World point under the cursor before zooming.
    const scaleBefore = this.scale;
    const worldX = (x - this.panX) / scaleBefore;
    const worldY = (y - this.panY) / scaleBefore;

    // Exponential zoom feels natural; clamp to sane bounds.
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));

    // Keep that same world point pinned under the cursor.
    const scaleAfter = this.scale;
    this.panX = x - worldX * scaleAfter;
    this.panY = y - worldY * scaleAfter;
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.dragging = true;
    this.moved = 0;
    const p = this.pointerPos(event);
    this.lastPointer = p;
    this.downAt = p;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add('dragging');
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    const p = this.pointerPos(event);
    const dx = p.x - this.lastPointer.x;
    const dy = p.y - this.lastPointer.y;
    this.panX += dx;
    this.panY += dy;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.lastPointer = p;
  }

  private handlePointerUp(): void {
    if (!this.dragging) return;
    this.endDrag();
    // A pointer that barely moved is a click → God Hand.
    if (this.moved <= CLICK_SLOP) {
      this.handleClick(this.downAt.x, this.downAt.y);
    }
  }

  private endDrag(): void {
    this.dragging = false;
    this.canvas.classList.remove('dragging');
  }

  // -------------------------------------------------------------------------

  /** Programmatically set (or clear) the highlighted villager. */
  selectVillager(villagerId: string | null): void {
    this.selectedId = villagerId;
  }

  /** Programmatically set (or clear) the highlighted building. */
  selectBuilding(buildingId: string | null): void {
    this.selectedBuildingId = buildingId;
  }

  /**
   * Record what a villager just decided to do, so a bubble pops up above it. Fed
   * the same thought stream as the inspector — every time a mind answers the
   * LLM, the villager visibly says/does it on the map.
   */
  noteThought(thought: VillagerThoughtMessage): void {
    // Learn the villager's display name for its always-on stat card.
    if (thought.villagerName) this.names.set(thought.villagerId, thought.villagerName);
    const text = bubbleText(thought.decision);
    if (!text) return; // the mind declined to act this turn — nothing to show
    // Speech and private thoughts both carry words worth reading, so they linger
    // longer than a terse action bubble. A thought is rendered as a status-style
    // (italic) bubble so it reads as inner voice rather than something said aloud.
    const wordy = thought.decision?.kind === 'say' || thought.decision?.kind === 'reason';
    const ttl = wordy ? SPEECH_TTL_MS : BUBBLE_TTL_MS;
    this.bubbles.set(thought.villagerId, {
      text,
      until: Date.now() + ttl,
      ...(thought.decision?.kind === 'reason' ? { status: true } : {}),
    });
  }

  /**
   * An engine LLM round-trip started. We only care about a villager's per-turn THINK
   * (`/decide`); record it as in-flight so that villager's sense disc pulses while its
   * mind is running. Planner/reflection (`/complete`) and embeddings (`/embed`) are
   * ignored — they are not the villager "taking its turn".
   */
  noteEngineCallStarted(call: LlmCallStartedMessage): void {
    if (call.endpoint !== '/decide') return;
    this.thinkingCalls.set(call.id, { agent: call.agent, startedAt: call.startedAt ?? Date.now() });
  }

  /** The matching round-trip finished (or failed): the villager is no longer thinking. */
  noteEngineCallFinished(call: LlmCallFinishedMessage): void {
    this.thinkingCalls.delete(call.id);
  }

  /**
   * The set of agent labels (villager names) whose mind is running right now, pruning
   * any call that has outlived {@link THINK_STALE_MS} so a missed `finished` event
   * cannot leave a disc pulsing forever.
   */
  private activeThinkers(): Set<string> {
    const now = Date.now();
    const active = new Set<string>();
    for (const [id, call] of this.thinkingCalls) {
      if (now - call.startedAt > Renderer.THINK_STALE_MS) {
        this.thinkingCalls.delete(id);
        continue;
      }
      active.add(call.agent);
    }
    return active;
  }

  /**
   * Pop a status popup above a villager the moment its engine status changes to a
   * new action (e.g. it sets off walking, or starts drinking at the well). The
   * first status we ever see for a villager is recorded silently, so connecting
   * doesn't spray popups for everyone's current state.
   */
  private trackStatusChanges(villagers: Villager[]): void {
    for (const v of villagers) {
      const status = v.status ?? '';
      const prev = this.lastStatus.get(v.id);
      if (prev === status) continue;
      this.lastStatus.set(v.id, status);
      if (prev === undefined) continue; // first sighting — seed without popping
      if (!status || /^idle$/i.test(status)) continue; // returning to rest isn't an action
      this.bubbles.set(v.id, {
        text: `${statusIcon(status)} ${status}`,
        until: Date.now() + STATUS_TTL_MS,
        status: true,
      });
    }
  }

  /**
   * Draw a compact, always-on stat card above every villager so its name,
   * current status, needs (hunger / thirst / fatigue) and backpack are readable
   * at a glance — no clicking required. Fixed screen size; villagers that are
   * close together at low zoom will overlap until you zoom in.
   */
  private drawVillagerCards(view: WorldView, scale: number, radius: number): void {
    if (view.villagers.length === 0) return;
    const { ctx } = this;
    const inner = CARD_W - CARD_PAD * 2;
    ctx.save();
    ctx.textBaseline = 'top';

    for (const villager of view.villagers) {
      if (!villager.needs) continue; // defensive: pre-stats payload
      const ax = villager.position.x * scale + this.panX;
      const ay = villager.position.y * scale + this.panY;
      const x = ax - CARD_W / 2;
      const y = ay - radius - CARD_GAP - CARD_HEIGHT;
      const selected = villager.id === this.selectedId;

      // Panel.
      ctx.fillStyle = 'rgba(13, 17, 23, 0.82)';
      ctx.strokeStyle = selected ? 'rgba(240, 246, 252, 0.5)' : 'rgba(240, 246, 252, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, CARD_W, CARD_HEIGHT, 6);
      ctx.fill();
      ctx.stroke();

      let cy = y + CARD_PAD;
      const tx = x + CARD_PAD;

      // Active-task badge in the top-right corner (e.g. a refill chore in progress),
      // so it's clear at a glance which villagers are busy on a job. The status line
      // below spells out the detail.
      if (villager.task) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.font = '10px system-ui, -apple-system, sans-serif';
        ctx.fillText('🛠️', x + CARD_W - CARD_PAD, cy);
      }

      // Name (in the villager's own colour).
      ctx.textAlign = 'left';
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = villager.color;
      ctx.fillText(clip(ctx, villager.name || this.names.get(villager.id) || villager.id, inner), tx, cy);
      cy += CARD_NAME_H + CARD_ROW_GAP;

      // Status line.
      ctx.font = '10px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(201, 209, 217, 0.85)';
      ctx.fillText(clip(ctx, villager.status ?? '', inner), tx, cy);
      cy += CARD_STATUS_H + CARD_ROW_GAP;

      // Need bars.
      this.drawNeedBars(tx, cy, inner, CARD_BARS_H, villager.needs);
      cy += CARD_BARS_H + CARD_ROW_GAP;

      // Backpack pips.
      this.drawBackpack(tx, cy, villager.backpack ?? []);
    }

    ctx.restore();
  }

  /** Four side-by-side need bars (Hunger / Thirst / Fatigue / Boredom) — fuller & warmer = more pressing. */
  private drawNeedBars(x: number, y: number, w: number, h: number, needs: VillagerNeeds): void {
    const { ctx } = this;
    const cells: [string, number][] = [
      ['H', needs.hunger],
      ['T', needs.thirst],
      ['F', needs.fatigue],
      ['B', needs.boredom],
    ];
    const segW = w / cells.length;
    ctx.textAlign = 'left';
    ctx.font = '9px system-ui, -apple-system, sans-serif';
    cells.forEach(([label, value], i) => {
      const sx = x + i * segW;
      ctx.fillStyle = 'rgba(201, 209, 217, 0.7)';
      ctx.fillText(label, sx, y);

      const bx = sx + 9;
      const bw = segW - 12;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(bx, y, bw, h);
      const frac = Math.max(0, Math.min(1, value / 100));
      ctx.fillStyle = needColor(value);
      ctx.fillRect(bx, y, bw * frac, h);
      ctx.strokeStyle = 'rgba(13, 17, 23, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, h - 1);
    });
  }

  /** A backpack glyph followed by `BACKPACK_CAPACITY` pips, filled per carried item. */
  private drawBackpack(x: number, y: number, items: string[]): void {
    const { ctx } = this;
    ctx.textAlign = 'left';
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(201, 209, 217, 0.85)';
    ctx.fillText('🎒', x, y - 1);

    const carried = Math.min(items.length, BACKPACK_CAPACITY);
    const r = 3;
    const gap = 4;
    const startX = x + 20 + r;
    for (let i = 0; i < BACKPACK_CAPACITY; i++) {
      const cx = startX + i * (r * 2 + gap);
      ctx.beginPath();
      ctx.arc(cx, y + 4, r, 0, Math.PI * 2);
      if (i < carried) {
        ctx.fillStyle = '#58a6ff';
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(201, 209, 217, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  /** Draw each live bubble above its villager, in screen space, and prune stale ones. */
  private drawBubbles(view: WorldView, scale: number, radius: number): void {
    if (this.bubbles.size === 0) return;
    const { ctx } = this;
    const now = Date.now();
    const fontPx = 13;
    const lineH = fontPx + 4;
    const padX = 7;
    const padY = 5;
    /** Wrap a bubble's text once it would grow wider than this (CSS px). */
    const maxTextW = 260;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const [id, bubble] of this.bubbles) {
      if (bubble.until <= now) {
        this.bubbles.delete(id);
        continue;
      }
      const villager = view.villagers.find((v) => v.id === id);
      if (!villager) continue;

      const ax = villager.position.x * scale + this.panX;
      const ay = villager.position.y * scale + this.panY;

      // A status/action popup reads in italics; speech is upright. Set the font
      // before measuring so wrapping accounts for the right metrics.
      ctx.font = `${bubble.status ? 'italic ' : ''}${fontPx}px system-ui, -apple-system, sans-serif`;

      // Wrap the full message across as many lines as it needs.
      const lines = wrapText(ctx, bubble.text, maxTextW);
      const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const boxW = textW + padX * 2;
      const boxH = lines.length * lineH + padY * 2;
      const bx = ax - boxW / 2;
      // Sit above the always-on stat card so the two never overlap.
      const by = ay - radius - CARD_GAP - CARD_HEIGHT - 6 - boxH;

      // Ease out over the final stretch so bubbles dissolve instead of blinking.
      ctx.globalAlpha = Math.min(1, (bubble.until - now) / BUBBLE_FADE_MS);

      ctx.fillStyle = bubble.status ? 'rgba(13, 30, 28, 0.88)' : 'rgba(13, 17, 23, 0.86)';
      ctx.strokeStyle = bubble.status ? 'rgba(63, 185, 160, 0.6)' : 'rgba(240, 246, 252, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      // Little tail pointing down at the villager.
      ctx.beginPath();
      ctx.moveTo(ax - 5, by + boxH - 0.5);
      ctx.lineTo(ax + 5, by + boxH - 0.5);
      ctx.lineTo(ax, by + boxH + 6);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = bubble.status ? '#7ee2c8' : '#e6edf3';
      lines.forEach((line, i) => {
        ctx.fillText(line, bx + padX, by + padY + i * lineH + lineH / 2);
      });
    }

    ctx.restore();
  }

  private handleClick(cssX: number, cssY: number): void {
    const view = this.net.getState();
    if (view.width === 0) return;

    // A click on a villager's body selects it (and opens its inspector); a click on
    // empty land is the God Hand. Hit-test villagers first since they sit on tiles.
    const hit = this.villagerAtPixel(cssX, cssY, view);
    if (hit) {
      this.selectedId = hit.id;
      this.onSelectVillager?.(hit.id);
      return;
    }

    const scale = this.scale;
    const worldX = Math.floor((cssX - this.panX) / scale);
    const worldY = Math.floor((cssY - this.panY) / scale);

    if (worldX < 0 || worldY < 0 || worldX >= view.width || worldY >= view.height) {
      return;
    }

    // A click inside a building's footprint selects it (and opens its inspector),
    // taking precedence over the God Hand on that tile.
    const building = this.buildingAtTile(view.buildings, worldX, worldY);
    if (building) {
      this.selectedBuildingId = building.id;
      this.onSelectBuilding?.(building.id);
      return;
    }

    // Ignore clicks on a tree tile — the God Hand only moves villagers onto empty land.
    if (this.isTreeTile(view.trees, worldX, worldY)) {
      return;
    }

    this.net.sendCommand({
      command: 'force_move',
      targetId: GOD_HAND_TARGET,
      x: worldX,
      y: worldY,
    });
  }

  /**
   * The villager whose drawn circle contains the given CSS-pixel point, or null.
   * Uses a slightly generous radius so small dots stay clickable when zoomed out.
   */
  private villagerAtPixel(cssX: number, cssY: number, view: WorldView): Villager | null {
    const scale = this.scale;
    const hitRadius = Math.max(6, scale * 1.5);
    let best: Villager | null = null;
    let bestDist = hitRadius;
    for (const villager of view.villagers) {
      const ax = villager.position.x * scale + this.panX;
      const ay = villager.position.y * scale + this.panY;
      const dist = Math.hypot(cssX - ax, cssY - ay);
      if (dist <= bestDist) {
        best = villager;
        bestDist = dist;
      }
    }
    return best;
  }

  /** The building whose footprint covers tile (x, y), or null. */
  private buildingAtTile(buildings: Building[], x: number, y: number): Building | null {
    for (const b of buildings) {
      if (x >= b.position.x && x < b.position.x + b.width && y >= b.position.y && y < b.position.y + b.height) {
        return b;
      }
    }
    return null;
  }

  /** Memoized tree-tile lookup; rebuilt only when the tree list changes. */
  private isTreeTile(trees: Tree[], x: number, y: number): boolean {
    if (this.treeTiles.size !== trees.length) {
      this.treeTiles = new Set(
        trees.map((t) => `${Math.round(t.position.x)},${Math.round(t.position.y)}`),
      );
    }
    return this.treeTiles.has(`${x},${y}`);
  }
}

/**
 * A short, human-readable line for a villager's chosen action, or null to skip.
 * `move_to` is intentionally omitted: walking surfaces as a status popup (e.g.
 * "🚶 Walking to (250, 248)") driven by the engine status, so bubbling it here
 * too would double up.
 */
function bubbleText(decision: AgentDecision | null): string | null {
  if (!decision) return null;
  switch (decision.kind) {
    case 'say':
      // Full speech, untruncated — the bubble wraps it across lines.
      return `💬 ${decision.message}`;
    case 'reason':
      // A private thought — shown only to you (the watcher), with a thought-cloud
      // glyph so it reads as inner deliberation, not something spoken aloud.
      return `💭 ${decision.thought}`;
    case 'interact_with':
      return `✋ ${decision.objectId}`;
    case 'work_at':
      return `🛠️ working ${decision.buildingId}`;
    case 'take_from':
      return `📥 take ${decision.resource}`;
    case 'give_to':
      return `📤 give ${decision.resource}`;
    case 'pray_at':
      return `🙏 ${decision.message}`;
    case 'propose_plan':
      return `📋 ${decision.goal}`;
    case 'join_plan':
      return `🤝 ${decision.role}`;
    case 'propose_build':
      return `🏗️ build ${decision.name}`;
    case 'command_cart':
      return `🛒 cart: ${decision.resource}`;
    case 'move_to':
      return null;
  }
}

/** Pick an emoji for an engine status line, by keyword, for the action popup. */
function statusIcon(status: string): string {
  if (/taking /i.test(status)) return '📥';
  if (/giving /i.test(status)) return '📤';
  if (/harvest|bak|draw|prepar|stor|refill|work/i.test(status)) return '🛠️';
  if (/empty/i.test(status)) return '🚫';
  if (/drink/i.test(status)) return '🥤';
  if (/eat/i.test(status)) return '🍽️';
  if (/rest/i.test(status)) return '😴';
  if (/walk/i.test(status)) return '🚶';
  return '✨';
}

/** A stable pseudo-random 0..1 from a seed — for procedural, frame-stable rain. */
function rnd(seed: number): number {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/** A need's bar colour: green when comfortable, amber when pressing, red when dire. */
function needColor(value: number): string {
  if (value >= 80) return '#f85149';
  if (value >= 50) return '#d29922';
  return '#3fb950';
}

/**
 * Truncate `text` with an ellipsis so it fits within `maxWidth` CSS px, measured
 * with the context's current font. Returns the text unchanged if it already fits.
 */
function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/**
 * Greedy word-wrap of `text` to lines no wider than `maxWidth` CSS px, measured
 * with the context's current font. A single word longer than the limit is left
 * on its own (over-long) line rather than split mid-word.
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}
