/**
 * client/src/GenerationOverlay.ts
 * ---------------------------------------------------------------------------
 * The full-screen LOADING OVERLAY shown while the backend generates a fresh
 * village with the LLM (a multi-minute, one-time build on first boot).
 *
 * It appears ONLY during a true generation: the backend streams `world.generating`
 * progress events, each of which drives `update()`; when the world is ready the
 * backend sends `world.init`, and `hide()` dismisses the overlay for good. A normal
 * (non-generating) boot never streams these, so the overlay never shows.
 *
 * The component owns its pre-rendered DOM node (in index.html) and only toggles
 * visibility + fills in the live phase label and the per-villager progress bar — no
 * layout is built here, keeping it cheap and flicker-free.
 * ---------------------------------------------------------------------------
 */

import type { WorldGeneratingMessage } from '../../shared/types';

export class GenerationOverlay {
  private readonly root: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly countEl: HTMLElement;
  /** True once `world.init` has dismissed it, so a late stray event can't re-open it. */
  private dismissed = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.phaseEl = root.querySelector('#gen-overlay-phase') as HTMLElement;
    this.barEl = root.querySelector('#gen-overlay-bar > i') as HTMLElement;
    this.countEl = root.querySelector('#gen-overlay-count') as HTMLElement;
  }

  /**
   * Apply one generation-progress step: reveal the overlay (if not already), set the
   * phase line, and — for the counted villager phase — advance the progress bar.
   */
  update(msg: WorldGeneratingMessage): void {
    if (this.dismissed) return; // the world already arrived; ignore stragglers
    if (msg.done) {
      // The build finished; keep the overlay up (with a full bar) until world.init
      // actually arrives, so there's no flash of an empty map mid-handoff.
      this.setBar(1, '');
      this.phaseEl.textContent = msg.label;
      return;
    }

    this.root.hidden = false;
    this.phaseEl.textContent = withEllipsis(msg.label);

    if (typeof msg.step === 'number' && typeof msg.total === 'number' && msg.total > 0) {
      this.setBar(msg.step / msg.total, `${msg.step} / ${msg.total}`);
    } else {
      // Uncounted phase (map / bible): an indeterminate-feeling partial bar.
      this.setBar(PHASE_FRACTION[msg.phase] ?? 0.1, '');
    }
  }

  /** Dismiss the overlay once the world exists; idempotent. */
  hide(): void {
    this.dismissed = true;
    this.root.hidden = true;
  }

  private setBar(fraction: number, count: string): void {
    this.barEl.style.width = `${Math.round(clamp01(fraction) * 100)}%`;
    this.countEl.textContent = count;
  }
}

/** Rough progress for the uncounted phases, so the bar still moves forward. */
const PHASE_FRACTION: Record<WorldGeneratingMessage['phase'], number> = {
  map: 0.12,
  villagers: 0.5,
  bible: 0.85,
  assembling: 0.97,
};

function withEllipsis(s: string): string {
  return /[.…!?]$/.test(s) ? s : `${s}…`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
