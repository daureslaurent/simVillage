/**
 * client/src/SetupScreen.ts
 * ---------------------------------------------------------------------------
 * The first-run SETUP screen — a full-screen overlay shown when the backend has
 * no world yet and is waiting for the player to choose how to create one.
 *
 * Two shapes, picked by the backend's `rival` flag in `world.needs_setup`:
 *   - SINGLE village — a free-text STYLE, a villager count and a size, with a live
 *     colour preview. Auto (LLM) or the hand-crafted Classic village.
 *   - RIVAL (two villages) — a shared MAP theme plus independent per-side controls
 *     (style, villager count, size, raid stance) for the Home and Rival settlements.
 *
 * Both paths: AUTO generates with the LLM; CLASSIC uses the hand-crafted seed (for
 * rival, the fixed-blueprint two-village world honouring the per-side counts).
 *
 * It owns its DOM (built here, mounted into #setup-screen) and talks to the backend
 * only through two callbacks: `onGenerate` (the final choice) and `onPreview`
 * (debounced style → colour swatch). Driven by `show()` / `applyPreview()` / `hide()`.
 * ---------------------------------------------------------------------------
 */

import type {
  CompetitionIntensity,
  RivalSetupParams,
  TerrainPalette,
  VillageSetupParams,
  VillageSize,
  WorldNeedsSetupMessage,
  WorldStylePreviewMessage,
} from '../../shared/types';

/** Quick-pick styles — a label + the phrase actually sent to the model. */
const STYLE_PRESETS: { label: string; emoji: string; style: string }[] = [
  { label: 'Farmland', emoji: '🌾', style: 'a temperate farming valley' },
  { label: 'Desert', emoji: '🏜️', style: 'a sun-baked desert oasis' },
  { label: 'Coast', emoji: '🌊', style: 'a fishing village on a rugged coast' },
  { label: 'Forest', emoji: '🌲', style: 'a deep old-growth forest hamlet' },
  { label: 'Volcanic', emoji: '🌋', style: 'a village on a dark volcanic crater' },
  { label: 'Tundra', emoji: '❄️', style: 'a frozen tundra outpost' },
  { label: 'Jungle', emoji: '🌴', style: 'a humid jungle settlement' },
  { label: 'Alien', emoji: '👽', style: 'an alien crystalline hive on a strange world' },
];

const SIZES: { value: VillageSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

/** Raid-stance presets for the rival layout, mapped to {@link CompetitionIntensity}. */
const INTENSITIES: { value: CompetitionIntensity; label: string }[] = [
  { value: 'peaceful', label: '🕊️ Peaceful' },
  { value: 'balanced', label: '⚖️ Balanced' },
  { value: 'aggressive', label: '⚔️ Aggressive' },
];

/** One side's live form state in the rival layout. */
interface SideState {
  style: string;
  villagers: number;
  size: VillageSize;
  intensity: CompetitionIntensity;
  /** Cached chip container, so its active highlight tracks the side's style. */
  chips?: HTMLElement;
}

export class SetupScreen {
  private readonly root: HTMLElement;
  private readonly onGenerate: (opts: {
    mode: 'auto' | 'static';
    style?: string;
    villagers?: number;
    size?: VillageSize;
    rival?: RivalSetupParams;
  }) => void;
  private readonly onPreview: (requestId: number, style: string) => void;

  // Live form state.
  private mode: 'auto' | 'static' = 'auto';
  private rival = false;
  // Single-village fields.
  private style = '';
  private villagers = 5;
  private size: VillageSize = 'medium';
  // Rival fields.
  private mapTheme = '';
  private home: SideState = { style: '', villagers: 5, size: 'medium', intensity: 'balanced' };
  private rivalSide: SideState = { style: '', villagers: 5, size: 'medium', intensity: 'balanced' };

  private maxVillagers = 6;
  private canAuto = true;

  // Preview debounce + stale-guard.
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewSeq = 0;
  private submitted = false;

  // Cached element refs (built once in render()).
  private els: {
    autoBody: HTMLElement;
    staticBody: HTMLElement;
    styleInput?: HTMLInputElement;
    chips?: HTMLElement;
    sizeSeg?: HTMLElement;
    modeSeg: HTMLElement;
    swatch: HTMLElement;
    swatchLabel: HTMLElement;
    go: HTMLButtonElement;
  } | null = null;

  constructor(
    root: HTMLElement,
    handlers: {
      onGenerate: (opts: {
        mode: 'auto' | 'static';
        style?: string;
        villagers?: number;
        size?: VillageSize;
        rival?: RivalSetupParams;
      }) => void;
      onPreview: (requestId: number, style: string) => void;
    },
  ) {
    this.root = root;
    this.onGenerate = handlers.onGenerate;
    this.onPreview = handlers.onPreview;
  }

  /** Open the screen with the backend's defaults. */
  show(msg: WorldNeedsSetupMessage): void {
    this.submitted = false;
    this.canAuto = msg.canAuto;
    this.rival = msg.rival ?? false;
    this.maxVillagers = Math.max(1, msg.maxVillagers);
    const startCount = Math.min(Math.max(1, msg.defaultVillagers), this.maxVillagers);
    this.villagers = startCount;
    this.size = msg.defaultSize;
    this.style = msg.defaultStyle ?? '';
    this.mode = msg.canAuto ? 'auto' : 'static';
    // Seed both rival sides from the same defaults (a symmetric, fair start).
    this.mapTheme = msg.defaultStyle ?? '';
    this.home = { style: '', villagers: startCount, size: msg.defaultSize, intensity: 'balanced' };
    this.rivalSide = { style: '', villagers: startCount, size: msg.defaultSize, intensity: 'balanced' };
    this.render();
    this.root.hidden = false;
    if (this.mode === 'auto') this.requestPreview(); // seed the swatch
  }

  /** Dismiss the screen (generation has begun / world arrived). */
  hide(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.root.hidden = true;
  }

  /** Apply a colour preview answer, ignoring stale (out-of-order) ones. */
  applyPreview(msg: WorldStylePreviewMessage): void {
    if (!this.els || msg.requestId !== this.previewSeq) return;
    this.paintSwatch(msg.palette, msg.theme);
  }

  // -------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = '';
    const card = el('div', 'setup__card');

    card.append(
      el('h1', 'setup__title', this.rival ? '⚔️ Two villages, one valley' : '🛖 Found a new valley'),
      el(
        'p',
        'setup__subtitle',
        this.rival
          ? 'Shape the two rival settlements that will share this valley — a common land, but each side with its own character, size and temper.'
          : 'Shape the village that will live here — let an AI dream one up from a style of your choosing, or start with the hand-crafted village.',
      ),
    );

    // Mode segmented control (auto / classic) — shared by both layouts.
    const modeSeg = el('div', 'setup__seg setup__modes');
    const autoBtn = segButton('✨ Auto-generate', this.mode === 'auto', () => this.setMode('auto'));
    const staticBtn = segButton(
      this.rival ? '🏡 Classic villages' : '🏡 Classic village',
      this.mode === 'static',
      () => this.setMode('static'),
    );
    if (!this.canAuto) {
      autoBtn.disabled = true;
      autoBtn.title = 'AI generation is disabled on this server (GENERATE_LLM=off)';
    }
    modeSeg.append(autoBtn, staticBtn);
    card.append(modeSeg);

    const swatchHost = { swatch: el('div', 'setup__swatch'), label: el('span', 'setup__swatchlabel', 'Picking colours…') };
    swatchHost.swatch.append(swatchHost.label);

    let autoBody: HTMLElement;
    let staticBody: HTMLElement;
    let styleInput: HTMLInputElement | undefined;
    let chips: HTMLElement | undefined;
    let sizeSeg: HTMLElement | undefined;

    if (this.rival) {
      const built = this.buildRivalBodies(swatchHost.swatch);
      autoBody = built.autoBody;
      staticBody = built.staticBody;
    } else {
      const built = this.buildSingleBodies(swatchHost.swatch);
      autoBody = built.autoBody;
      staticBody = built.staticBody;
      styleInput = built.styleInput;
      chips = built.chips;
      sizeSeg = built.sizeSeg;
    }
    card.append(autoBody, staticBody);

    // Go button.
    const go = el('button', 'setup__go') as HTMLButtonElement;
    go.type = 'button';
    go.addEventListener('click', () => this.submit());
    card.append(go);

    this.root.append(card);
    this.els = {
      autoBody,
      staticBody,
      modeSeg,
      swatch: swatchHost.swatch,
      swatchLabel: swatchHost.label,
      go,
      ...(styleInput ? { styleInput } : {}),
      ...(chips ? { chips } : {}),
      ...(sizeSeg ? { sizeSeg } : {}),
    };
    this.syncMode();
    this.syncChips();
  }

  // --- SINGLE-village bodies (the original layout) --------------------------

  private buildSingleBodies(swatch: HTMLElement): {
    autoBody: HTMLElement;
    staticBody: HTMLElement;
    styleInput: HTMLInputElement;
    chips: HTMLElement;
    sizeSeg: HTMLElement;
  } {
    const autoBody = el('div', 'setup__auto');

    autoBody.append(el('label', 'setup__label', 'Style'));
    const chips = this.buildStyleChips((style) => {
      this.style = style;
      if (this.els?.styleInput) this.els.styleInput.value = style;
      this.syncChips();
      this.requestPreview();
    });
    autoBody.append(chips);

    const styleInput = this.buildStyleInput(this.style, (v) => {
      this.style = v;
      this.syncChips();
      this.requestPreview();
    });
    autoBody.append(styleInput, swatch);

    autoBody.append(
      this.buildVillagerRow(this.villagers, (n) => {
        this.villagers = n;
      }),
    );

    autoBody.append(el('label', 'setup__label', 'Size'));
    const sizeSeg = this.buildSizeSeg(this.size, (s) => {
      this.size = s;
    });
    autoBody.append(sizeSeg);

    const staticBody = el('div', 'setup__static');
    staticBody.append(
      el(
        'p',
        'setup__staticnote',
        'Start with the hand-crafted starter village — the Old Spring, Greenfield Farmstead, Emberfall Forge and their familiar faces. Instant, no AI.',
      ),
    );

    return { autoBody, staticBody, styleInput, chips, sizeSeg };
  }

  // --- RIVAL bodies ---------------------------------------------------------

  private buildRivalBodies(swatch: HTMLElement): { autoBody: HTMLElement; staticBody: HTMLElement } {
    const autoBody = el('div', 'setup__auto setup__rival');

    // Shared map theme — owns the live colour preview.
    autoBody.append(el('label', 'setup__label', 'Map theme — the shared valley'));
    const mapChips = this.buildStyleChips((style) => {
      this.mapTheme = style;
      const input = autoBody.querySelector('.setup__style') as HTMLInputElement | null;
      if (input) input.value = style;
      this.syncMapChips(mapChips);
      this.requestPreview();
    });
    this.mapChipsEl = mapChips;
    autoBody.append(mapChips);
    autoBody.append(
      this.buildStyleInput(this.mapTheme, (v) => {
        this.mapTheme = v;
        this.syncMapChips(mapChips);
        this.requestPreview();
      }),
      swatch,
    );

    // Two side panels.
    const cols = el('div', 'setup__rivalcols');
    cols.append(this.buildSidePanel('🏠 Home (west)', this.home), this.buildSidePanel('⚔️ Rival (east)', this.rivalSide));
    autoBody.append(cols);

    // Classic body — fixed blueprint, only the per-side counts apply.
    const staticBody = el('div', 'setup__static');
    staticBody.append(
      el(
        'p',
        'setup__staticnote',
        'Start two hand-crafted rival villages on a shared map — instant, no AI. Only the villager counts below apply.',
      ),
    );
    const staticCols = el('div', 'setup__rivalcols');
    staticCols.append(this.buildCountOnlyPanel('🏠 Home (west)', this.home), this.buildCountOnlyPanel('⚔️ Rival (east)', this.rivalSide));
    staticBody.append(staticCols);

    return { autoBody, staticBody };
  }

  /** Cached map-theme chip container, so its highlight tracks `mapTheme`. */
  private mapChipsEl: HTMLElement | null = null;

  /** A full per-side panel: style, villager count, size, raid stance. */
  private buildSidePanel(title: string, side: SideState): HTMLElement {
    const panel = el('div', 'setup__side');
    panel.append(el('h3', 'setup__sidetitle', title));

    panel.append(el('label', 'setup__label', 'Style'));
    const chips = this.buildStyleChips((style) => {
      side.style = style;
      const input = panel.querySelector('.setup__style') as HTMLInputElement | null;
      if (input) input.value = style;
      this.syncSideChips(side);
    });
    side.chips = chips;
    panel.append(chips);
    panel.append(
      this.buildStyleInput(side.style, (v) => {
        side.style = v;
        this.syncSideChips(side);
      }),
    );

    panel.append(
      this.buildVillagerRow(side.villagers, (n) => {
        side.villagers = n;
      }),
    );

    panel.append(el('label', 'setup__label', 'Size'));
    panel.append(
      this.buildSizeSeg(side.size, (s) => {
        side.size = s;
      }),
    );

    panel.append(el('label', 'setup__label', 'Raid stance'));
    panel.append(this.buildIntensitySeg(side.intensity, (v) => {
      side.intensity = v;
    }));

    return panel;
  }

  /** A reduced per-side panel for classic mode: just the villager count. */
  private buildCountOnlyPanel(title: string, side: SideState): HTMLElement {
    const panel = el('div', 'setup__side');
    panel.append(el('h3', 'setup__sidetitle', title));
    panel.append(
      this.buildVillagerRow(side.villagers, (n) => {
        side.villagers = n;
      }),
    );
    return panel;
  }

  // --- shared control builders ---------------------------------------------

  private buildStyleChips(onPick: (style: string) => void): HTMLElement {
    const chips = el('div', 'setup__chips');
    for (const p of STYLE_PRESETS) {
      const chip = el('button', 'setup__chip', `${p.emoji} ${p.label}`) as HTMLButtonElement;
      chip.type = 'button';
      chip.dataset.style = p.style;
      chip.addEventListener('click', () => onPick(p.style));
      chips.append(chip);
    }
    return chips;
  }

  private buildStyleInput(value: string, onInput: (v: string) => void): HTMLInputElement {
    const styleInput = el('input', 'setup__style') as HTMLInputElement;
    styleInput.type = 'text';
    styleInput.placeholder = 'or describe your own… (e.g. "a steampunk sky-port", "a mushroom-folk warren")';
    styleInput.value = value;
    styleInput.addEventListener('input', () => onInput(styleInput.value));
    return styleInput;
  }

  private buildVillagerRow(value: number, onChange: (n: number) => void): HTMLElement {
    const vRow = el('div', 'setup__row');
    vRow.append(el('label', 'setup__label', 'Villagers'));
    const villagerValue = el('span', 'setup__rowval', String(value));
    const villagerRange = el('input', 'setup__range') as HTMLInputElement;
    villagerRange.type = 'range';
    villagerRange.min = '1';
    villagerRange.max = String(this.maxVillagers);
    villagerRange.value = String(value);
    villagerRange.addEventListener('input', () => {
      const n = Number(villagerRange.value);
      villagerValue.textContent = String(n);
      onChange(n);
    });
    vRow.append(villagerRange, villagerValue);
    return vRow;
  }

  private buildSizeSeg(value: VillageSize, onPick: (s: VillageSize) => void): HTMLElement {
    const sizeSeg = el('div', 'setup__seg');
    for (const s of SIZES) {
      const b = segButton(s.label, value === s.value, () => {
        onPick(s.value);
        for (const x of Array.from(sizeSeg.children) as HTMLElement[]) {
          x.classList.toggle('is-active', x.dataset.size === s.value);
        }
      });
      b.dataset.size = s.value;
      sizeSeg.append(b);
    }
    return sizeSeg;
  }

  private buildIntensitySeg(value: CompetitionIntensity, onPick: (v: CompetitionIntensity) => void): HTMLElement {
    const seg = el('div', 'setup__seg');
    for (const it of INTENSITIES) {
      const b = segButton(it.label, value === it.value, () => {
        onPick(it.value);
        for (const x of Array.from(seg.children) as HTMLElement[]) {
          x.classList.toggle('is-active', x.dataset.intensity === it.value);
        }
      });
      b.dataset.intensity = it.value;
      seg.append(b);
    }
    return seg;
  }

  // -------------------------------------------------------------------------

  private setMode(mode: 'auto' | 'static'): void {
    this.mode = mode;
    this.syncMode();
    if (mode === 'auto') this.requestPreview();
  }

  private syncMode(): void {
    if (!this.els) return;
    const auto = this.mode === 'auto';
    this.els.autoBody.hidden = !auto;
    this.els.staticBody.hidden = auto;
    this.els.go.textContent = auto
      ? this.rival
        ? '✨ Generate both villages'
        : '✨ Generate village'
      : this.rival
        ? '🏡 Start classic villages'
        : '🏡 Start classic village';
    for (const b of Array.from(this.els.modeSeg.children) as HTMLButtonElement[]) {
      const isAuto = b.textContent?.includes('Auto');
      b.classList.toggle('is-active', isAuto === auto);
    }
  }

  private syncChips(): void {
    if (!this.els) return;
    if (this.rival) {
      if (this.mapChipsEl) this.syncMapChips(this.mapChipsEl);
      this.syncSideChips(this.home);
      this.syncSideChips(this.rivalSide);
      return;
    }
    if (!this.els.chips) return;
    for (const c of Array.from(this.els.chips.children) as HTMLElement[]) {
      c.classList.toggle('is-active', c.dataset.style === this.style.trim());
    }
  }

  private syncMapChips(chips: HTMLElement): void {
    for (const c of Array.from(chips.children) as HTMLElement[]) {
      c.classList.toggle('is-active', c.dataset.style === this.mapTheme.trim());
    }
  }

  private syncSideChips(side: SideState): void {
    if (!side.chips) return;
    for (const c of Array.from(side.chips.children) as HTMLElement[]) {
      c.classList.toggle('is-active', c.dataset.style === side.style.trim());
    }
  }

  /** Debounced colour-preview request as the style (or map theme) changes. */
  private requestPreview(): void {
    if (!this.canAuto) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.els) this.els.swatchLabel.textContent = 'Picking colours…';
    this.previewTimer = setTimeout(() => {
      const id = ++this.previewSeq;
      this.onPreview(id, (this.rival ? this.mapTheme : this.style).trim());
    }, 550);
  }

  private paintSwatch(palette: TerrainPalette, theme: string): void {
    if (!this.els) return;
    const dots = [palette.ground, palette.groundAccent, palette.vegetation]
      .map((c) => `<span class="setup__dot" style="background:${escapeAttr(c)}"></span>`)
      .join('');
    this.els.swatch.innerHTML = `${dots}<span class="setup__swatchlabel">${escapeHtml(theme)}</span>`;
  }

  private submit(): void {
    if (this.submitted) return;
    this.submitted = true;
    if (this.els) {
      this.els.go.disabled = true;
      this.els.go.textContent = this.mode === 'auto' ? 'Summoning…' : 'Building…';
    }
    if (this.rival) {
      // Both modes carry the rival block; the server reads counts always, and the
      // styles/sizes/stances only in auto mode.
      this.onGenerate({ mode: this.mode, rival: this.collectRival() });
      return;
    }
    if (this.mode === 'static') {
      this.onGenerate({ mode: 'static' });
    } else {
      this.onGenerate({ mode: 'auto', style: this.style.trim(), villagers: this.villagers, size: this.size });
    }
  }

  /** Snapshot the rival form into the wire shape. */
  private collectRival(): RivalSetupParams {
    const side = (s: SideState): VillageSetupParams => ({
      style: s.style.trim(),
      villagers: s.villagers,
      size: s.size,
      intensity: s.intensity,
    });
    return { mapTheme: this.mapTheme.trim(), home: side(this.home), rival: side(this.rivalSide) };
  }
}

// --- tiny DOM helpers --------------------------------------------------------

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function segButton(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'setup__segbtn' + (active ? ' is-active' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/[^#0-9a-zA-Z(),.%\s-]/g, '');
}
