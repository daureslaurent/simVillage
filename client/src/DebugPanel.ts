/**
 * client/src/DebugPanel.ts
 * ---------------------------------------------------------------------------
 * A left-docked live DEBUG FEED: one line per villager think, newest first, so
 * you can watch the simulation tick by tick — which villager acted on which tick
 * and what they decided (move / speak / interact / skipped).
 *
 * It is fed the exact same thought stream as the map bubbles and the inspector
 * (`net.onThought`), so it needs no extra wiring on the server. Each villager is
 * given a stable colour so you can pick one out of the interleaved stream at a
 * glance, and the feed can be paused to inspect a moment without it scrolling.
 * ---------------------------------------------------------------------------
 */

import type { AgentDecision, VillagerThoughtMessage } from '../../shared/types';
import { escapeHtml } from './modal';

/** How many lines to keep before trimming the scroll-back. */
const MAX_LINES = 250;
/** How many recent tick intervals the rolling average is taken over. */
const AVG_WINDOW = 20;

/** Stable per-villager colours, assigned in first-seen order. */
const PALETTE = ['#ff6b6b', '#4dafff', '#ffd24d', '#9b5dff', '#4dffa1', '#ff8c00', '#00ced1', '#ff69b4'];

export class DebugPanel {
  private readonly tickEl: HTMLElement;
  private readonly avgTickEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly colors = new Map<string, string>();
  private paused = false;

  /** Wall-clock arrival time of the last `sim.tick`, for measuring the gap to the next. */
  private lastTickAt: number | null = null;
  /** Recent inter-tick gaps (ms), newest last, capped to {@link AVG_WINDOW}. */
  private readonly tickGaps: number[] = [];

  constructor(root: HTMLElement) {
    root.classList.add('debug');
    root.innerHTML = `
      <header class="debug__head">
        <span class="debug__title">Debug · tick <span class="debug__tickno">—</span></span>
        <span class="debug__avgtick" title="Average wall-clock time per logical tick (rolling, last ${AVG_WINDOW})">avg —</span>
        <button class="debug__pause" title="Pause / resume the feed">⏸</button>
      </header>
      <div class="debug__status"></div>
      <div class="debug__list"></div>`;
    this.tickEl = root.querySelector('.debug__tickno')!;
    this.avgTickEl = root.querySelector('.debug__avgtick')!;
    this.statusEl = root.querySelector('.debug__status')!;
    this.listEl = root.querySelector('.debug__list')!;
    this.pauseBtn = root.querySelector('.debug__pause')!;
    this.pauseBtn.addEventListener('click', () => this.togglePause());
  }

  /**
   * The current logical tick (turn-coordinator round): who is acting this round
   * and who is resting on cooldown (and for how many more ticks). Also clocks
   * the wall-clock gap since the previous round, for the rolling avg-sec/tick
   * readout — the thing that actually tells you how fast the village is living,
   * since LLM latency (not `MIN_ROUND_MS`) is usually what paces a round.
   */
  setTick(tick: number, acting: string[], cooldown: Record<string, number>): void {
    this.tickEl.textContent = String(tick);
    this.recordTickGap();

    const resting = Object.entries(cooldown);
    const parts = [`acting: ${acting.length}`];
    if (resting.length > 0) {
      parts.push(`cooldown: ${resting.map(([id, n]) => `${shortId(id)}·${n}`).join(', ')}`);
    }
    this.statusEl.textContent = parts.join('  ·  ');
  }

  private recordTickGap(): void {
    const now = Date.now();
    if (this.lastTickAt !== null) {
      this.tickGaps.push(now - this.lastTickAt);
      if (this.tickGaps.length > AVG_WINDOW) this.tickGaps.shift();
    }
    this.lastTickAt = now;

    if (this.tickGaps.length === 0) return;
    const avgMs = this.tickGaps.reduce((sum, ms) => sum + ms, 0) / this.tickGaps.length;
    this.avgTickEl.textContent = `avg ${(avgMs / 1000).toFixed(1)}s/tick`;
  }

  /** Append one think to the feed (round tick + villager + decision). */
  ingest(t: VillagerThoughtMessage): void {
    if (this.paused) return;
    const color = this.colorFor(t.villagerId);
    const acted = t.decision !== null;
    // Prefer the logical round tick; fall back to the world tick if uncoordinated.
    const tickLabel = t.roundTick ?? t.tick;

    const line = document.createElement('div');
    line.className = 'debug__line';
    line.innerHTML = `
      <span class="debug__tick">t${tickLabel}</span>
      <span class="debug__name" style="color:${color}">${escapeHtml(t.villagerName)}</span>
      <span class="debug__act${acted ? '' : ' debug__act--skip'}">${escapeHtml(summarize(t.decision))}</span>`;

    this.listEl.prepend(line);
    while (this.listEl.childElementCount > MAX_LINES) {
      this.listEl.lastElementChild?.remove();
    }
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseBtn.textContent = this.paused ? '▶' : '⏸';
    this.pauseBtn.classList.toggle('debug__pause--on', this.paused);
  }

  private colorFor(id: string): string {
    let c = this.colors.get(id);
    if (!c) {
      c = PALETTE[this.colors.size % PALETTE.length]!;
      this.colors.set(id, c);
    }
    return c;
  }
}

/** Compact one-liner for a decision, or a skip marker when the turn produced none. */
function summarize(d: AgentDecision | null): string {
  if (!d) return '— skipped';
  switch (d.kind) {
    case 'move_to':
      return `move → (${d.x}, ${d.y})`;
    case 'say':
      return `say: "${truncate(d.message, 60)}"`;
    case 'reason':
      return `think: "${truncate(d.thought, 60)}"`;
    case 'interact_with':
      return `use ${d.objectId}`;
    case 'work_at':
      return `work @${d.buildingId}`;
    case 'take_from':
      return `take ${d.resource} @${d.buildingId}`;
    case 'give_to':
      return `give ${d.resource} @${d.buildingId}`;
    case 'pray_at':
      return `pray @${d.buildingId}: "${truncate(d.message, 60)}"`;
    case 'propose_plan':
      return `propose ${d.planKind}: "${truncate(d.goal, 50)}"`;
    case 'join_plan':
      return `join plan: "${truncate(d.role, 50)}"`;
    case 'propose_build':
      return `build ${d.structure}: "${truncate(d.name, 40)}" @(${d.x}, ${d.y})`;
    case 'command_cart':
      return `cart ${d.cartId}: ${d.resource} ${d.fromBuildingId}→${d.toBuildingId}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Compact villager id for the cooldown line, e.g. "villager_3" -> "v3". */
function shortId(id: string): string {
  return id.replace(/^villager_/, 'v');
}
