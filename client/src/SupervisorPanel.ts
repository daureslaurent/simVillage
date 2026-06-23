/**
 * client/src/SupervisorPanel.ts
 * ---------------------------------------------------------------------------
 * The "Supervisor" console — the temple's god seen through the human's eyes.
 *
 * In the simulation the Supervisor IS the temple: the supreme god the villagers
 * pray to. This panel is the operator's seat at that altar. It does three things:
 *
 *   HEAR   — every villager prayer streams in live (`net.onPrayer`), newest first.
 *   JUDGE  — Grant CHOOSES one prayer for the god to answer and dismisses every
 *            other pending prayer (only one may be heard); Dismiss drops a single
 *            prayer. Both are one click and send a `supervisor_verdict` up.
 *   ACT    — "⚡ Force Run" makes the god deliberate over the pending prayers NOW,
 *            off its once-a-day cadence, answering at most one; whatever it does
 *            comes back on the "divine acts" feed (`net.onSupervisorAction`).
 *
 * Like the Debug feed it is fed entirely off the network client and holds no
 * world state of its own.
 * ---------------------------------------------------------------------------
 */

import type { SupervisorActionMessage, SupervisorPrayerMessage, Villager, WeatherKind } from '../../shared/types';
import { escapeHtml } from './modal';

/** Keep at most this many prayer rows (resolved or not) before trimming. */
const MAX_PRAYERS = 40;
/** Keep at most this many divine-act lines. */
const MAX_ACTS = 30;

/** The weather states the human god may set, with a glyph each, for the buttons. */
const WEATHER_CHOICES: { kind: WeatherKind; icon: string; label: string }[] = [
  { kind: 'clear', icon: '☀️', label: 'Clear' },
  { kind: 'rain', icon: '🌧️', label: 'Rain' },
  { kind: 'storm', icon: '⛈️', label: 'Storm' },
  { kind: 'fog', icon: '🌫️', label: 'Fog' },
];

export interface SupervisorPanelCallbacks {
  onVerdict: (prayer: SupervisorPrayerMessage, verdict: 'choose' | 'reject') => void;
  onForceRun: () => void;
  /** Set the village-wide weather (a Divine Power). */
  onSetWeather: (weather: WeatherKind) => void;
  /** Bless a villager — ease its every need. */
  onBless: (villagerId: string) => void;
  /** Smite a villager — visit hardship on it. */
  onSmite: (villagerId: string) => void;
  /** Conjure a newcomer or a tree into the world. */
  onSpawn: (entityType: 'villager' | 'tree') => void;
}

export class SupervisorPanel {
  private readonly listEl: HTMLElement;
  private readonly actsEl: HTMLElement;
  private readonly countEl: HTMLElement;
  /** The villager <select> used as the target for bless/smite. */
  private readonly targetSel: HTMLSelectElement;
  /** The weather buttons, keyed by kind, so the active one can be highlighted. */
  private readonly weatherBtns = new Map<WeatherKind, HTMLButtonElement>();
  /** Prayers still awaiting a verdict: id -> its row, so choosing one can dismiss the rest. */
  private readonly pending = new Map<string, HTMLElement>();
  /** All prayer ids we've seen, so a re-broadcast never double-inserts. */
  private readonly seen = new Set<string>();

  constructor(root: HTMLElement, private readonly cb: SupervisorPanelCallbacks) {
    root.classList.add('super');
    const weatherButtons = WEATHER_CHOICES.map(
      (w) => `<button class="super__wbtn" data-weather="${w.kind}" title="${w.label}">${w.icon} ${w.label}</button>`,
    ).join('');
    root.innerHTML = `
      <header class="super__head">
        <span class="super__title">⛪ Supervisor · the God</span>
        <button class="super__run" title="Force the god to weigh the pending prayers now and answer at most one">⚡ Force Run</button>
      </header>

      <div class="super__powers">
        <div class="super__plabel">Weather</div>
        <div class="super__weather">${weatherButtons}</div>
        <div class="super__plabel">Bless or smite a villager</div>
        <div class="super__godrow">
          <select class="super__target" title="Target villager"></select>
          <button class="super__gbtn super__bless" title="Ease every need, wake a sleeper">✨ Bless</button>
          <button class="super__gbtn super__smite" title="Visit hardship on every need">⚡ Smite</button>
        </div>
        <div class="super__plabel">Conjure</div>
        <div class="super__godrow">
          <button class="super__gbtn super__spawnv" title="Add a newcomer to the village">🧍 Villager</button>
          <button class="super__gbtn super__spawnt" title="Add a tree to the terrain">🌳 Tree</button>
        </div>
      </div>

      <div class="super__sub">Prayers from the village · <span class="super__count">0</span> awaiting judgement</div>
      <div class="super__list"><div class="super__empty">No prayers yet — the faithful are quiet.</div></div>
      <div class="super__actshead">Divine acts</div>
      <div class="super__acts"><div class="super__empty">The god has not yet acted.</div></div>`;
    this.listEl = root.querySelector('.super__list')!;
    this.actsEl = root.querySelector('.super__acts')!;
    this.countEl = root.querySelector('.super__count')!;
    this.targetSel = root.querySelector('.super__target')!;
    root.querySelector('.super__run')!.addEventListener('click', () => this.cb.onForceRun());

    for (const btn of root.querySelectorAll<HTMLButtonElement>('.super__wbtn')) {
      const kind = btn.dataset.weather as WeatherKind;
      this.weatherBtns.set(kind, btn);
      btn.addEventListener('click', () => this.cb.onSetWeather(kind));
    }
    root.querySelector('.super__bless')!.addEventListener('click', () => this.withTarget((id) => this.cb.onBless(id)));
    root.querySelector('.super__smite')!.addEventListener('click', () => this.withTarget((id) => this.cb.onSmite(id)));
    root.querySelector('.super__spawnv')!.addEventListener('click', () => this.cb.onSpawn('villager'));
    root.querySelector('.super__spawnt')!.addEventListener('click', () => this.cb.onSpawn('tree'));
  }

  /** Refresh the bless/smite target dropdown, preserving the current selection. */
  setVillagers(villagers: Villager[]): void {
    const chosen = this.targetSel.value;
    const options = villagers
      .map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name || v.id)}</option>`)
      .join('');
    this.targetSel.innerHTML = options || `<option value="">(no villagers)</option>`;
    if (chosen && villagers.some((v) => v.id === chosen)) this.targetSel.value = chosen;
  }

  /** Highlight the button for the weather currently in force. */
  setWeather(weather: WeatherKind): void {
    for (const [kind, btn] of this.weatherBtns) {
      btn.classList.toggle('super__wbtn--on', kind === weather);
    }
  }

  /** Run `fn` with the chosen target villager id, if one is selected. */
  private withTarget(fn: (villagerId: string) => void): void {
    const id = this.targetSel.value;
    if (id) fn(id);
  }

  /** A villager just prayed: add a judgeable row to the top of the feed. */
  ingestPrayer(p: SupervisorPrayerMessage): void {
    if (this.seen.has(p.id)) return;
    this.seen.add(p.id);
    this.clearEmpty(this.listEl);

    const row = document.createElement('div');
    row.className = 'super__prayer';
    row.innerHTML = `
      <div class="super__praytop">
        <span class="super__who">${escapeHtml(p.villagerName)}</span>
        <span class="super__tick">t${p.tick}</span>
      </div>
      <div class="super__msg">“${escapeHtml(p.message)}”</div>
      <div class="super__btns">
        <button class="super__btn super__accept" title="Grant this prayer — the god answers it and the rest are dismissed">🙏 Grant</button>
        <button class="super__btn super__reject" title="Let this one prayer go unheard">✕ Dismiss</button>
      </div>`;
    row.querySelector('.super__accept')!.addEventListener('click', () => this.resolve(p, 'choose', row));
    row.querySelector('.super__reject')!.addEventListener('click', () => this.resolve(p, 'reject', row));

    this.pending.set(p.id, row);
    this.listEl.prepend(row);
    while (this.listEl.childElementCount > MAX_PRAYERS) this.listEl.lastElementChild?.remove();
    this.refreshCount();
  }

  /** The god took an action (force-run or autonomous): log it to the acts feed. */
  ingestAction(a: SupervisorActionMessage): void {
    this.clearEmpty(this.actsEl);
    const line = document.createElement('div');
    line.className = 'super__act';
    line.innerHTML =
      `<span class="super__actkind">${escapeHtml(a.action)}</span>` +
      `<span class="super__actsum">${escapeHtml(a.summary)}</span>`;
    this.actsEl.prepend(line);
    while (this.actsEl.childElementCount > MAX_ACTS) this.actsEl.lastElementChild?.remove();
  }

  private resolve(p: SupervisorPrayerMessage, verdict: 'choose' | 'reject', row: HTMLElement): void {
    if (!this.pending.has(p.id)) return; // already judged
    this.pending.delete(p.id);
    this.cb.onVerdict(p, verdict);

    if (verdict === 'choose') {
      // Only one prayer may be heard: mark this one granted and dismiss every
      // other prayer still pending — the god has turned its ear elsewhere.
      this.markRow(row, 'super__prayer--ok', '🙏 granted — the god answers this one');
      for (const [, otherRow] of this.pending) {
        this.markRow(otherRow, 'super__prayer--no', '— the god chose another prayer');
      }
      this.pending.clear();
    } else {
      this.markRow(row, 'super__prayer--no', '✕ dismissed — fell on deaf ears');
    }
    this.refreshCount();
  }

  /** Lock a prayer row to a resolved state, replacing its buttons with a note. */
  private markRow(row: HTMLElement, cls: string, note: string): void {
    row.classList.add(cls);
    const btns = row.querySelector('.super__btns') ?? row.querySelector('.super__verdict');
    if (btns) {
      btns.className = 'super__verdict';
      btns.textContent = note;
    }
  }

  private refreshCount(): void {
    this.countEl.textContent = String(this.pending.size);
  }

  private clearEmpty(host: HTMLElement): void {
    host.querySelector('.super__empty')?.remove();
  }
}
