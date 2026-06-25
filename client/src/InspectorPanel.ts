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

import type { AgentTraceStep, VillagerThoughtMessage } from '../../shared/types';
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

    const steps = t.steps ?? [];
    const headline = steps.length > 0 ? summariseSteps(steps) : t.decision ? t.decision.kind : '— (skipped)';
    const memories = t.recalledMemories.length
      ? t.recalledMemories
          .map((m) => `  · [${m.kind} ${m.score.toFixed(2)}] ${escapeHtml(m.text)}`)
          .join('\n')
      : '  (none recalled)';

    // The agentic TRACE: the chain of lookups + actions the mind ran this turn.
    const traceSec =
      steps.length > 0
        ? `<details class="thought__sec thought__sec--trace" open>
             <summary>reasoning trace (${steps.length} step${steps.length === 1 ? '' : 's'})</summary>
             <div class="trace">${steps.map(renderStep).join('')}</div>
           </details>`
        : '';

    entry.innerHTML = `
      <div class="thought__meta">tick ${t.tick} → <b>${escapeHtml(headline)}</b></div>
      ${traceSec}
      <details class="thought__sec"${steps.length > 0 ? '' : ' open'}>
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

/** A one-line headline for the turn: how many lookups + actions the mind ran. */
function summariseSteps(steps: AgentTraceStep[]): string {
  const actions = steps.filter((s) => s.kind === 'action' && s.committed).map((s) => s.tool);
  const reads = steps.filter((s) => s.kind === 'read').length;
  const readBit = reads > 0 ? `${reads} lookup${reads === 1 ? '' : 's'}` : '';
  const actBit = actions.length > 0 ? actions.join(' → ') : 'no action';
  return [readBit, actBit].filter(Boolean).join(' · ');
}

/** Render one trace step as a row: a kind glyph, the tool, its input, and the result fed back. */
function renderStep(s: AgentTraceStep): string {
  const glyph = s.kind === 'read' ? '🔍' : s.kind === 'action' ? (s.committed ? '⚙️' : '⚠️') : '✓';
  const tool = s.tool ? `<span class="trace__tool">${escapeHtml(s.tool)}</span>` : '<span class="trace__tool">yield</span>';
  const input = s.input ? `<span class="trace__in">${escapeHtml(s.input)}</span>` : '';
  const thought = s.thought ? `<div class="trace__thought">${escapeHtml(s.thought)}</div>` : '';
  const result = s.result ? `<div class="trace__result">${escapeHtml(s.result)}</div>` : '';
  return `<div class="trace__step trace__step--${s.kind}${s.kind === 'action' && !s.committed ? ' trace__step--rejected' : ''}">
      <div class="trace__head">${glyph} ${tool} ${input}</div>
      ${thought}${result}
    </div>`;
}

/** Minimal HTML-escape so memory/prompt text can't inject markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
