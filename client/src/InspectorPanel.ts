/**
 * client/src/InspectorPanel.ts
 * ---------------------------------------------------------------------------
 * Final Phase — the "God Hand (Inception)" UI.
 *
 * A right-docked side panel that opens when you click a villager. It streams
 * that villager's thought process — the memories RAG recalled, the raw prompt, and
 * the raw model output — live over the WebSocket telemetry feed, and offers a
 * text box that whispers a synthetic memory straight into their vector store via
 * `plant_idea`. Watch the recalled-memories list after you plant: the idea
 * resurfaces at the top of the very next thought.
 *
 * The panel owns its own DOM (built into the provided root) and stays oblivious
 * to the network — `main.ts` feeds it thoughts and wires its onPlant callback.
 * ---------------------------------------------------------------------------
 */

import type { VillagerThoughtMessage } from '../../shared/types';
import type { ManagedWindow } from './WindowManager';

export interface InspectorOptions {
  /** Called when the user submits a synthetic memory for the selected villager. */
  onPlant: (villagerId: string, memory: string) => void;
}

/** How many past thoughts to keep in the scroll-back before trimming. */
const MAX_THOUGHTS = 30;

export class InspectorPanel {
  private readonly titleEl: HTMLElement;
  private readonly thoughtsEl: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly plantBtn: HTMLButtonElement;

  /** The host window — open/close delegate to it (wired by main via setWindow). */
  private win: ManagedWindow | null = null;
  /** The villager currently being inspected, or null when the panel is closed. */
  private selectedId: string | null = null;

  constructor(
    root: HTMLElement,
    options: InspectorOptions,
  ) {
    // Build the panel chrome once. The window supplies the titlebar controls;
    // this header carries only the (live) villager title.
    root.classList.add('inspector');
    root.innerHTML = `
      <header class="inspector__head">
        <span class="win__title inspector__title">No villager selected</span>
      </header>
      <div class="inspector__thoughts"></div>
      <div class="inspector__plant">
        <textarea class="inspector__input" rows="2"
          placeholder="Plant a memory in their mind, first person…"></textarea>
        <button class="inspector__btn" disabled>Plant idea</button>
      </div>`;

    this.titleEl = root.querySelector('.inspector__title')!;
    this.thoughtsEl = root.querySelector('.inspector__thoughts')!;
    this.input = root.querySelector('.inspector__input')!;
    this.plantBtn = root.querySelector('.inspector__btn')!;

    this.input.addEventListener('input', () => {
      this.plantBtn.disabled = this.input.value.trim().length === 0;
    });
    const submit = (): void => {
      const memory = this.input.value.trim();
      if (!memory || !this.selectedId) return;
      options.onPlant(this.selectedId, memory);
      this.appendNote(`💉 You planted: "${memory}"`);
      this.input.value = '';
      this.plantBtn.disabled = true;
    };
    this.plantBtn.addEventListener('click', submit);
    // Cmd/Ctrl+Enter sends, so the textarea can still take newlines.
    this.input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    });
  }

  /** Bind the host window so open/close drive its visibility. */
  setWindow(win: ManagedWindow): void {
    this.win = win;
  }

  /** Open (or switch) the panel onto a villager, clearing the previous stream. */
  open(villagerId: string): void {
    this.selectedId = villagerId;
    this.titleEl.textContent = villagerId;
    this.thoughtsEl.replaceChildren();
    this.win?.open();
    this.input.focus();
  }

  /** Hide the window (e.g. when a building is selected instead). */
  close(): void {
    this.win?.close();
  }

  /** Clear selection without touching the window — called when the window is closed. */
  markClosed(): void {
    this.selectedId = null;
  }

  /** The villager currently inspected, so callers can sync other UI (e.g. the map). */
  get selected(): string | null {
    return this.selectedId;
  }

  /** Feed one incoming thought. Ignored unless it belongs to the open villager. */
  ingest(thought: VillagerThoughtMessage): void {
    if (thought.villagerId !== this.selectedId) return;
    this.titleEl.textContent = `${thought.villagerName} · ${thought.villagerId}`;
    this.renderThought(thought);
  }

  // -------------------------------------------------------------------------

  private renderThought(t: VillagerThoughtMessage): void {
    const entry = document.createElement('div');
    entry.className = 'thought';

    const decision = t.decision ? `${t.decision.kind}` : '— (skipped)';
    const memories = t.recalledMemories.length
      ? t.recalledMemories
          .map((m) => `  · [${m.kind} ${m.score.toFixed(2)}] ${escapeHtml(m.text)}`)
          .join('\n')
      : '  (none recalled)';

    entry.innerHTML = `
      <div class="thought__meta">tick ${t.tick} → <b>${escapeHtml(decision)}</b></div>
      <details class="thought__sec" open>
        <summary>recalled memories (${t.recalledMemories.length})</summary>
        <pre>${memories}</pre>
      </details>
      <details class="thought__sec">
        <summary>prompt</summary>
        <pre>${escapeHtml(t.prompt.system)}\n\n--- perception ---\n${escapeHtml(t.prompt.user)}</pre>
      </details>
      <details class="thought__sec">
        <summary>raw output</summary>
        <pre>${escapeHtml(t.rawOutput || '(empty)')}</pre>
      </details>`;

    this.prepend(entry);
  }

  private appendNote(text: string): void {
    const note = document.createElement('div');
    note.className = 'thought thought--note';
    note.textContent = text;
    this.prepend(note);
  }

  /** Newest-first: prepend, then trim the scroll-back. */
  private prepend(node: HTMLElement): void {
    this.thoughtsEl.prepend(node);
    while (this.thoughtsEl.childElementCount > MAX_THOUGHTS) {
      this.thoughtsEl.lastElementChild?.remove();
    }
  }
}

/** Minimal HTML-escape so memory/prompt text can't inject markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
