/**
 * client/src/SettingsPanel.ts
 * ---------------------------------------------------------------------------
 * The "Settings" window — operator controls for the LLM engine's behaviour.
 *
 * It holds two things. First, the ENGINE MODEL: which chat model every villager
 * mind, the God, reflection and planning think with. The current model is shown
 * live, and a picker (populated from the models the backend discovers) switches
 * it; the change takes effect on the next thought. Second, REASONING EFFORT. For
 * each kind of thinking the
 * model does — a villager's moment-to-moment choice, the God's judgement, the
 * nightly reflection, the morning plan — the human picks how hard the model is
 * asked to deliberate (Low / Medium / High). The choice is a pure prompt lever
 * on the backend (a line appended to that call's system prompt); the model is
 * steered to think more or less, while what it must output is unchanged.
 *
 * The backend owns the truth: each pick is sent up immediately, and the live
 * config streams back over `reasoning.effort` (on connect and on every change),
 * so the segmented controls always mirror the server — across reloads and across
 * multiple open tabs. A pick is shown optimistically and then confirmed by that
 * echo.
 * ---------------------------------------------------------------------------
 */

import {
  EFFORT_PURPOSES,
  REASONING_EFFORT_LABELS,
  type EffortPurpose,
  type LlmModelConfig,
  type ReasoningEffort,
  type ReasoningEffortSettings,
} from '../../shared/types';

/** The three levels, in order, for the segmented control. */
const LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/** Friendly title + one-line gloss for each tunable call purpose. */
const PURPOSE_META: Record<EffortPurpose, { title: string; icon: string; hint: string }> = {
  decide: {
    title: 'Villager minds',
    icon: '🧍',
    hint: "Each villager's moment-to-moment choice of what to do next.",
  },
  supervisor: {
    title: 'The God (Supervisor)',
    icon: '⛪',
    hint: "The god's judgement over the village and its prayers.",
  },
  reflect: {
    title: 'Nightly reflection',
    icon: '🌙',
    hint: 'How a villager reasons over its day and forms a belief each night.',
  },
  plan: {
    title: 'Daily planning',
    icon: '📜',
    hint: "Each villager's loose morning agenda for the day ahead.",
  },
};

export interface SettingsPanelCallbacks {
  /** Send one effort change up to the backend. */
  onSetEffort: (purpose: EffortPurpose, level: ReasoningEffort) => void;
  /** Switch the engine's global chat model. */
  onSetModel: (model: string) => void;
  /** Ask the backend to re-discover the available models. */
  onRefreshModels: () => void;
  /** Wipe the world and return to the setup screen ("New Village"). */
  onResetWorld: () => void;
}

export class SettingsPanel {
  /** The segmented-control buttons, keyed `${purpose}:${level}`, for highlighting. */
  private readonly buttons = new Map<string, HTMLButtonElement>();
  /** The "connecting…" notice, shown until the first config arrives. */
  private readonly pendingEl: HTMLElement;
  /** Last config the server confirmed, so we can fall back if a tab desyncs. */
  private current: ReasoningEffortSettings | null = null;

  // --- Engine-model picker ---
  /** The "currently thinking with X" label. */
  private readonly modelNameEl: HTMLElement;
  /** The dropdown of available models. */
  private readonly modelSelectEl: HTMLSelectElement;
  /** The re-scan button. */
  private readonly modelRefreshEl: HTMLButtonElement;
  /** The "no models found" fallback note. */
  private readonly modelEmptyEl: HTMLElement;
  /** The current/optimistic model id, so a redundant pick is a no-op and the dot can pulse while pending. */
  private modelCurrent: string | null = null;

  constructor(root: HTMLElement, private readonly cb: SettingsPanelCallbacks) {
    root.classList.add('settings');
    const rows = EFFORT_PURPOSES.map((purpose) => {
      const meta = PURPOSE_META[purpose];
      const seg = LEVELS.map(
        (level) =>
          `<button class="settings__seg" data-purpose="${purpose}" data-level="${level}" ` +
          `title="${REASONING_EFFORT_LABELS[level]} reasoning effort">${REASONING_EFFORT_LABELS[level]}</button>`,
      ).join('');
      return `
        <div class="settings__row" data-purpose="${purpose}">
          <div class="settings__rowhead">
            <span class="settings__icon">${meta.icon}</span>
            <span class="settings__name">${meta.title}</span>
          </div>
          <div class="settings__hint">${meta.hint}</div>
          <div class="settings__segs" role="group" aria-label="${meta.title} reasoning effort">${seg}</div>
        </div>`;
    }).join('');

    root.innerHTML = `
      <header class="settings__head">
        <span class="settings__title">⚙️ Settings</span>
      </header>
      <div class="settings__scroll">
      <div class="settings__group settings__group--model">
        <div class="settings__grouphead">Engine model</div>
        <div class="settings__groupnote">
          The chat model every villager mind, the God, nightly reflection and daily planning
          think with. Switching takes effect on the next thought; memory embeddings are untouched.
        </div>
        <div class="settings__model">
          <div class="settings__modelnow">
            <span class="settings__modeldot" aria-hidden="true"></span>
            <div class="settings__modelmeta">
              <span class="settings__modellabel">Currently thinking with</span>
              <span class="settings__modelname" data-role="model-current">…</span>
            </div>
          </div>
          <div class="settings__modelpick">
            <div class="settings__selectwrap">
              <select class="settings__select" data-role="model-select" aria-label="Engine model"></select>
            </div>
            <button class="settings__iconbtn" data-role="model-refresh"
              title="Re-scan the engine for available models" aria-label="Refresh model list">⟲</button>
          </div>
          <div class="settings__modelempty" data-role="model-empty" hidden>
            The engine reported no models. It may still be starting, or its server is unreachable —
            try refresh.
          </div>
        </div>
      </div>
      <div class="settings__group">
        <div class="settings__grouphead">Reasoning effort</div>
        <div class="settings__groupnote">
          How hard the model is asked to think for each kind of decision. Higher means more
          deliberate (and slower) choices; the extra thinking stays internal and never shows in
          what villagers say or do.
        </div>
        ${rows}
        <div class="settings__pending" hidden>Connecting to the engine…</div>
      </div>
      <div class="settings__group settings__group--danger">
        <div class="settings__grouphead">New village</div>
        <div class="settings__groupnote">
          Start over from the setup screen with a brand-new village. This permanently
          deletes the current world, its villagers and their memories.
        </div>
        <button class="settings__danger" data-role="reset-world">🌱 New village…</button>
        <div class="settings__confirm" data-role="reset-confirm" hidden>
          <span>Delete this village and start fresh?</span>
          <div class="settings__confirmbtns">
            <button class="settings__danger" data-role="reset-yes">Yes, wipe it</button>
            <button class="settings__cancel" data-role="reset-no">Cancel</button>
          </div>
        </div>
      </div>
      </div>`;

    // One delegated listener for every effort segment (scoped to the effort group so
    // it isn't fooled by the model group, which now comes first in the DOM).
    root
      .querySelector('.settings__group:not(.settings__group--model)')!
      .addEventListener('click', (e) => this.onClick(e));

    for (const btn of root.querySelectorAll<HTMLButtonElement>('.settings__seg')) {
      this.buttons.set(`${btn.dataset.purpose}:${btn.dataset.level}`, btn);
    }
    this.pendingEl = root.querySelector('.settings__pending')!;

    // The engine-model picker.
    this.modelNameEl = root.querySelector('[data-role="model-current"]')!;
    this.modelSelectEl = root.querySelector('[data-role="model-select"]')!;
    this.modelRefreshEl = root.querySelector('[data-role="model-refresh"]')!;
    this.modelEmptyEl = root.querySelector('[data-role="model-empty"]')!;
    this.modelSelectEl.addEventListener('change', () => this.onModelPick());
    this.modelRefreshEl.addEventListener('click', () => this.onRefresh());

    // "New village" — a two-step confirm before the destructive wipe.
    const resetBtn = root.querySelector<HTMLButtonElement>('[data-role="reset-world"]')!;
    const resetConfirm = root.querySelector<HTMLElement>('[data-role="reset-confirm"]')!;
    const resetYes = root.querySelector<HTMLButtonElement>('[data-role="reset-yes"]')!;
    const resetNo = root.querySelector<HTMLButtonElement>('[data-role="reset-no"]')!;
    resetBtn.addEventListener('click', () => {
      resetBtn.hidden = true;
      resetConfirm.hidden = false;
    });
    resetNo.addEventListener('click', () => {
      resetConfirm.hidden = true;
      resetBtn.hidden = false;
    });
    resetYes.addEventListener('click', () => {
      resetYes.disabled = true;
      resetYes.textContent = 'Wiping…';
      this.cb.onResetWorld();
    });

    // Until the first config arrives from the server, dim the controls.
    this.setReady(false);
    this.setModelReady(false);
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.settings__seg');
    if (!btn) return;
    const purpose = btn.dataset.purpose as EffortPurpose | undefined;
    const level = btn.dataset.level as ReasoningEffort | undefined;
    if (!purpose || !level) return;
    if (this.current && this.current[purpose] === level) return; // no change
    // Optimistic highlight; the server's echo confirms (or corrects) it.
    this.highlight(purpose, level);
    this.cb.onSetEffort(purpose, level);
  }

  /** Mirror the authoritative config from the backend onto every segmented control. */
  setSettings(settings: ReasoningEffortSettings): void {
    this.current = settings;
    this.setReady(true);
    for (const purpose of EFFORT_PURPOSES) this.highlight(purpose, settings[purpose]);
  }

  /** Light up the chosen level for one purpose, clearing the others in its row. */
  private highlight(purpose: EffortPurpose, level: ReasoningEffort): void {
    for (const lvl of LEVELS) {
      this.buttons.get(`${purpose}:${lvl}`)?.classList.toggle('settings__seg--on', lvl === level);
    }
  }

  /** Enable the controls once the live config is known; dim them until then. */
  private setReady(ready: boolean): void {
    this.pendingEl.hidden = ready;
    for (const btn of this.buttons.values()) btn.disabled = !ready;
  }

  // -------------------------------------------------------------------------
  // Engine model
  // -------------------------------------------------------------------------

  /** The operator picked a model from the dropdown. */
  private onModelPick(): void {
    const model = this.modelSelectEl.value;
    if (!model || model === this.modelCurrent) return; // no change
    // Optimistic: show it as current and pulse the dot until the server echoes back.
    this.modelCurrent = model;
    this.modelNameEl.textContent = model;
    this.modelNameEl.parentElement!.parentElement!.classList.add('settings__modelnow--pending');
    this.cb.onSetModel(model);
  }

  /** The operator asked to re-scan the engine for models. */
  private onRefresh(): void {
    this.modelRefreshEl.classList.add('settings__iconbtn--spin');
    this.cb.onRefreshModels();
  }

  /**
   * Mirror the authoritative model config from the backend: update the "now" label
   * and rebuild the dropdown. The current model is always selectable even if the
   * backend didn't list it (e.g. a custom id), so the picker never misrepresents
   * what's actually running.
   */
  setModelConfig(config: LlmModelConfig): void {
    this.modelCurrent = config.current;
    this.modelRefreshEl.classList.remove('settings__iconbtn--spin');
    this.modelNameEl.parentElement!.parentElement!.classList.remove('settings__modelnow--pending');

    const hasCurrent = config.current.length > 0;
    this.modelNameEl.textContent = hasCurrent ? config.current : 'unknown';

    // The option set = discovered models, plus the running one if it isn't among them.
    const options = [...config.available];
    if (hasCurrent && !options.includes(config.current)) options.unshift(config.current);

    this.modelSelectEl.replaceChildren(
      ...options.map((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        opt.selected = id === config.current;
        return opt;
      }),
    );

    this.modelEmptyEl.hidden = options.length > 0;
    // A config message means we're connected, so refresh is always usable now; the
    // dropdown only makes sense when there's an alternative to the running model.
    this.modelRefreshEl.disabled = false;
    this.modelSelectEl.disabled = options.length <= 1;
  }

  /** Dim the model picker until the first config lands. */
  private setModelReady(ready: boolean): void {
    this.modelSelectEl.disabled = !ready;
    this.modelRefreshEl.disabled = !ready;
  }
}
