/**
 * client/src/RosterPanel.ts
 * ---------------------------------------------------------------------------
 * The left-docked VILLAGER ROSTER.
 *
 * One CARD per villager in the world. A card's always-visible face carries the
 * villager's name, live status and need bars. Click it and the card EXPANDS in
 * place (accordion — opening one collapses any other) into three tabs:
 *
 *   LOG        — every action/interaction the villager has taken, newest first.
 *                Seeded from the durable action log (fetched over HTTP) and kept
 *                live as new thoughts stream in. Each row carries an "LLM" button
 *                that pops a modal with the technical context behind that action.
 *   MEMORIES   — the villager's stored long-term memories (RAG), newest first.
 *   CHARACTER  — the static persona: traits, goal and backstory.
 *
 * The panel owns its DOM and stays transport-agnostic: `main.ts` injects the
 * data fetchers and feeds it the world's villager list + the thought stream.
 * ---------------------------------------------------------------------------
 */

import type {
  AgentDecision,
  Gathering,
  Villager,
  VillagerNeeds,
  VillagerActionRecord,
  VillagerMemory,
  VillagerPersona,
  VillagerThoughtMessage,
} from '../../shared/types';
import { BACKPACK_CAPACITY } from '../../shared/types';
import { escapeHtml, showModal } from './modal';

export interface RosterOptions {
  /** Load a villager's persisted action history (newest first). */
  onFetchActions: (villagerId: string) => Promise<VillagerActionRecord[]>;
  /** Load a villager's stored long-term memories (newest first). */
  onFetchMemories: (villagerId: string) => Promise<VillagerMemory[]>;
  /** Load a villager's static persona (identity / character), or null if unknown. */
  onFetchPersona: (villagerId: string) => Promise<VillagerPersona | null>;
}

/** How many live-appended actions to keep before trimming the log. */
const MAX_ROWS = 300;

/** The three drawers inside an expanded card. */
type TabKey = 'log' | 'memories' | 'character';

/** Per-card UI state: which tab is showing and which tabs have loaded once. */
interface CardState {
  tab: TabKey;
  loaded: Set<TabKey>;
}

export class RosterPanel {
  private readonly listEl: HTMLElement;

  /** id -> the card element currently shown, so live stats update in place. */
  private readonly cardById = new Map<string, HTMLElement>();
  /** id -> its expansion/tab state. */
  private readonly stateById = new Map<string, CardState>();
  /** The one expanded card's id, or null when all are collapsed (accordion). */
  private expandedId: string | null = null;

  /** Last rendered roster signature, to avoid rebuilding cards every tick. */
  private rosterSig = '';
  /** id -> display name, learned from the thought/action streams. */
  private readonly names = new Map<string, string>();
  /** Latest villager list, so we can re-render the roster after a membership change. */
  private villagers: Villager[] = [];
  /** Latest gatherings, so each card can show who its villager is grouped with. */
  private gatherings: Gathering[] = [];

  constructor(
    root: HTMLElement,
    private readonly options: RosterOptions,
  ) {
    root.classList.add('roster');
    root.innerHTML = `
      <header class="roster__head">
        <span class="roster__title">Villagers</span>
        <span class="roster__count"></span>
      </header>
      <div class="roster__list"></div>`;

    this.listEl = root.querySelector('.roster__list')!;
  }

  // -------------------------------------------------------------------------
  // Data in
  // -------------------------------------------------------------------------

  /**
   * Update the known villager set. The card SKELETONS are rebuilt only when the
   * roster's membership changes; the live data on them (status, needs, backpack)
   * is refreshed in place every call, so the panel mirrors the map without churn.
   */
  syncVillagers(villagers: Villager[], gatherings: Gathering[] = []): void {
    this.villagers = villagers;
    this.gatherings = gatherings;
    const sig = villagers.map((v) => v.id).sort().join(',');
    if (sig !== this.rosterSig) {
      this.rosterSig = sig;
      this.renderRoster();
    }
    this.updateStats();
  }

  /** Feed one thought: learn the villager's name, and live-append if it acted. */
  ingest(thought: VillagerThoughtMessage): void {
    this.names.set(thought.villagerId, thought.villagerName);
    if (!thought.decision) return;
    const state = this.stateById.get(thought.villagerId);
    // Only the open card's loaded LOG tab keeps a live tail.
    if (this.expandedId !== thought.villagerId || !state || state.tab !== 'log' || !state.loaded.has('log')) return;
    const panel = this.panelEl(thought.villagerId, 'log');
    if (!panel) return;
    this.prependRow(
      panel,
      this.actionRow({
        villagerId: thought.villagerId,
        villagerName: thought.villagerName,
        tick: thought.tick,
        decision: thought.decision,
        decisionSource: thought.decisionSource,
        recalledMemories: thought.recalledMemories,
        prompt: thought.prompt,
        rawOutput: thought.rawOutput,
        recordedAt: new Date().toISOString(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Roster rendering
  // -------------------------------------------------------------------------

  /** Build the (static) card skeletons; live values are filled by {@link updateStats}. */
  private renderRoster(): void {
    this.cardById.clear();
    const cards = this.villagers.map((v) => this.buildCard(v));
    this.listEl.replaceChildren(...cards);
    if (cards.length === 0) {
      this.listEl.innerHTML = `<div class="roster__empty">no villagers yet…</div>`;
    }
    this.updateCount();
    // A rebuild replaces every card's DOM, so the old panels are detached: drop
    // the expansion and the per-tab load caches rather than point at stale nodes.
    this.expandedId = null;
    for (const st of this.stateById.values()) st.loaded.clear();
  }

  private buildCard(v: Villager): HTMLElement {
    const card = document.createElement('div');
    card.className = 'vcard';
    card.dataset.id = v.id;
    card.innerHTML = `
      <button class="vcard__face" aria-expanded="false">
        <span class="vcard__swatch" style="background:${escapeAttr(v.color)}"></span>
        <span class="vcard__id">
          <span class="vcard__name"></span>
          <span class="vcard__status"></span>
        </span>
        <span class="vcard__chev" aria-hidden="true">›</span>
      </button>
      <div class="vcard__needs">
        ${needRow('Hunger')}
        ${needRow('Thirst')}
        ${needRow('Fatigue')}
        ${needRow('Boredom')}
      </div>
      <div class="vcard__body" hidden>
        <div class="vcard__now"></div>
        <div class="vtabs" role="tablist">
          <button class="vtab is-active" data-tab="log">Log</button>
          <button class="vtab" data-tab="memories">Memories</button>
          <button class="vtab" data-tab="character">Character</button>
        </div>
        <div class="vpanel" data-panel="log"></div>
        <div class="vpanel" data-panel="memories" hidden></div>
        <div class="vpanel" data-panel="character" hidden></div>
      </div>`;

    card.querySelector('.vcard__face')!.addEventListener('click', () => this.toggle(v.id));
    for (const tab of card.querySelectorAll<HTMLElement>('.vtab')) {
      tab.addEventListener('click', () => this.selectTab(v.id, tab.dataset.tab as TabKey));
    }
    this.cardById.set(v.id, card);
    if (!this.stateById.has(v.id)) this.stateById.set(v.id, { tab: 'log', loaded: new Set() });
    return card;
  }

  /** Refresh the live values (name, status, need bars, backpack, group) on every card. */
  private updateStats(): void {
    for (const v of this.villagers) {
      const card = this.cardById.get(v.id);
      if (!card) continue;

      const name = v.name || this.names.get(v.id) || v.id;
      setText(card, '.vcard__name', name);
      const status = v.status ?? (v.target ? 'walking' : 'idle');
      setText(card, '.vcard__status', v.asleep ? `💤 ${status}` : status);
      card.classList.toggle('vcard--asleep', !!v.asleep);

      if (v.needs) this.fillNeeds(card, v.needs);
      this.fillNow(card, v);
    }
  }

  /** The expanded "right now" summary line: current job, backpack, and group. */
  private fillNow(card: HTMLElement, v: Villager): void {
    const now = card.querySelector('.vcard__now');
    if (!now) return;
    const bits: string[] = [];

    if (v.task) bits.push(`<span class="now__chip">🛠️ ${escapeHtml(v.task.label)}</span>`);

    const items = v.backpack ?? [];
    const filled = Math.min(items.length, BACKPACK_CAPACITY);
    const pips = '●'.repeat(filled) + '○'.repeat(Math.max(0, BACKPACK_CAPACITY - filled));
    const packTitle = items.length ? escapeAttr(items.join(', ')) : 'empty';
    bits.push(`<span class="now__chip" title="${packTitle}">🎒 ${pips}</span>`);

    const gathering = this.gatherings.find((g) => g.memberIds.includes(v.id));
    if (gathering) {
      const others = gathering.memberIds.filter((id) => id !== v.id).map((id) => this.displayName(id));
      const where = gathering.place ? ` at ${escapeHtml(gathering.place)}` : '';
      bits.push(`<span class="now__chip">👥 ${escapeHtml(others.join(', '))}${where}</span>`);
    }

    now.innerHTML = bits.join('');
  }

  /** Best-known display name for an id: the entity name, then a learned name, then the id. */
  private displayName(id: string): string {
    const v = this.villagers.find((x) => x.id === id);
    return v?.name || this.names.get(id) || id;
  }

  /** Set each need bar's width and colour from the villager's current needs. */
  private fillNeeds(card: HTMLElement, needs: VillagerNeeds): void {
    const values: Record<string, number> = {
      Hunger: needs.hunger,
      Thirst: needs.thirst,
      Fatigue: needs.fatigue,
      Boredom: needs.boredom,
    };
    for (const [label, value] of Object.entries(values)) {
      const bar = card.querySelector<HTMLElement>(`.need[data-need="${label}"] u`);
      if (!bar) continue;
      const pct = Math.max(0, Math.min(100, value));
      bar.style.width = `${pct}%`;
      bar.style.background = needColor(pct);
    }
  }

  private updateCount(): void {
    const el = this.listEl.parentElement?.querySelector('.roster__count');
    if (el) el.textContent = this.villagers.length ? String(this.villagers.length) : '';
  }

  // -------------------------------------------------------------------------
  // Expansion + tabs
  // -------------------------------------------------------------------------

  /** Toggle a card open/closed; opening it collapses any other open card. */
  private toggle(villagerId: string): void {
    if (this.expandedId === villagerId) {
      this.collapse(villagerId);
      this.expandedId = null;
      return;
    }
    if (this.expandedId) this.collapse(this.expandedId);
    this.expandedId = villagerId;
    this.expand(villagerId);
  }

  private collapse(villagerId: string): void {
    const card = this.cardById.get(villagerId);
    if (!card) return;
    card.classList.remove('vcard--open');
    card.querySelector('.vcard__face')!.setAttribute('aria-expanded', 'false');
    (card.querySelector('.vcard__body') as HTMLElement).hidden = true;
  }

  private expand(villagerId: string): void {
    const card = this.cardById.get(villagerId);
    if (!card) return;
    card.classList.add('vcard--open');
    card.querySelector('.vcard__face')!.setAttribute('aria-expanded', 'true');
    (card.querySelector('.vcard__body') as HTMLElement).hidden = false;
    const state = this.stateById.get(villagerId)!;
    this.showTab(villagerId, state.tab);
    void this.loadTab(villagerId, state.tab);
    card.scrollIntoView({ block: 'nearest' });
  }

  private selectTab(villagerId: string, tab: TabKey): void {
    const state = this.stateById.get(villagerId);
    if (!state) return;
    state.tab = tab;
    this.showTab(villagerId, tab);
    void this.loadTab(villagerId, tab);
  }

  /** Flip the active tab button + panel visibility. */
  private showTab(villagerId: string, tab: TabKey): void {
    const card = this.cardById.get(villagerId);
    if (!card) return;
    for (const btn of card.querySelectorAll<HTMLElement>('.vtab')) {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    }
    for (const panel of card.querySelectorAll<HTMLElement>('.vpanel')) {
      panel.hidden = panel.dataset.panel !== tab;
    }
  }

  private panelEl(villagerId: string, tab: TabKey): HTMLElement | null {
    return this.cardById.get(villagerId)?.querySelector(`.vpanel[data-panel="${tab}"]`) ?? null;
  }

  /** Fetch a tab's data on first view; cached thereafter (LOG keeps a live tail). */
  private async loadTab(villagerId: string, tab: TabKey): Promise<void> {
    const state = this.stateById.get(villagerId);
    const panel = this.panelEl(villagerId, tab);
    if (!state || !panel || state.loaded.has(tab)) return;
    state.loaded.add(tab);
    panel.innerHTML = `<div class="vpanel__loading">loading…</div>`;
    try {
      if (tab === 'log') await this.renderLog(villagerId, panel);
      else if (tab === 'memories') await this.renderMemories(villagerId, panel);
      else await this.renderCharacter(villagerId, panel);
    } catch {
      state.loaded.delete(tab); // let a re-open retry
      panel.innerHTML = `<div class="vpanel__empty">failed to load</div>`;
    }
  }

  // -------------------------------------------------------------------------
  // LOG tab
  // -------------------------------------------------------------------------

  private async renderLog(villagerId: string, panel: HTMLElement): Promise<void> {
    const records = await this.options.onFetchActions(villagerId);
    if (this.stateById.get(villagerId)?.loaded.has('log') !== true) return; // collapsed mid-load
    if (records.length === 0) {
      panel.innerHTML = `<div class="vpanel__empty">no actions recorded yet</div>`;
      return;
    }
    panel.replaceChildren(...records.map((r) => this.actionRow(r)));
  }

  /** Build one action row: a summary line + a button into the LLM-data modal. */
  private actionRow(r: VillagerActionRecord): HTMLElement {
    const row = document.createElement('div');
    row.className = 'action';
    // A fallback turn wasn't chosen by the model (engine error / unusable output) —
    // flag it so the log doesn't read as if the mind decided it.
    const fallback =
      r.decisionSource === 'fallback'
        ? ' <span class="action__fallback" title="Scripted fallback — the model produced no usable decision this turn">fallback</span>'
        : '';
    row.innerHTML = `
      <div class="action__main">
        <span class="action__tick">t${r.tick}</span>
        <span class="action__desc">${escapeHtml(describe(r.decision))}${fallback}</span>
      </div>
      <button class="action__llm" title="Technical LLM data">LLM</button>`;
    row.querySelector('.action__llm')!.addEventListener('click', () => this.openModal(r));
    return row;
  }

  private prependRow(panel: HTMLElement, row: HTMLElement): void {
    const empty = panel.querySelector('.vpanel__empty');
    if (empty) empty.remove();
    panel.prepend(row);
    while (panel.childElementCount > MAX_ROWS) {
      panel.lastElementChild?.remove();
    }
  }

  // -------------------------------------------------------------------------
  // MEMORIES tab
  // -------------------------------------------------------------------------

  private async renderMemories(villagerId: string, panel: HTMLElement): Promise<void> {
    const memories = await this.options.onFetchMemories(villagerId);
    if (this.stateById.get(villagerId)?.loaded.has('memories') !== true) return;
    if (memories.length === 0) {
      panel.innerHTML = `<div class="vpanel__empty">no memories formed yet</div>`;
      return;
    }
    panel.replaceChildren(...memories.map((m) => memoryRow(m)));
  }

  // -------------------------------------------------------------------------
  // CHARACTER tab
  // -------------------------------------------------------------------------

  private async renderCharacter(villagerId: string, panel: HTMLElement): Promise<void> {
    const persona = await this.options.onFetchPersona(villagerId);
    if (this.stateById.get(villagerId)?.loaded.has('character') !== true) return;
    if (!persona) {
      panel.innerHTML = `<div class="vpanel__empty">no character on file</div>`;
      return;
    }
    const traits = persona.traits.length
      ? `<div class="char__traits">${persona.traits.map((t) => `<span class="char__trait">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const goal = persona.goal
      ? `<div class="char__field"><i>Goal</i><p>${escapeHtml(persona.goal)}</p></div>`
      : '';
    const backstory = persona.backstory
      ? `<div class="char__field"><i>Backstory</i><p>${escapeHtml(persona.backstory)}</p></div>`
      : '';
    panel.innerHTML = `${traits}${goal}${backstory}` || `<div class="vpanel__empty">no character details</div>`;
  }

  // -------------------------------------------------------------------------
  // The technical-LLM-data modal
  // -------------------------------------------------------------------------

  private openModal(r: VillagerActionRecord): void {
    const memories = r.recalledMemories.length
      ? r.recalledMemories
          .map((m) => `  · [${m.kind} ${m.score.toFixed(2)}] ${m.text}`)
          .join('\n')
      : '  (none recalled)';

    const fallbackTag =
      r.decisionSource === 'fallback'
        ? ' · <span class="action__fallback">fallback</span>'
        : '';
    const header = `${escapeHtml(r.villagerName)} · tick ${r.tick} · <b>${escapeHtml(describe(r.decision))}</b>${fallbackTag}`;
    // For a fallback turn there is no authored output to show; say so rather than
    // leaving a bare "(empty)" that reads like a bug.
    const rawLabel =
      r.decisionSource === 'fallback'
        ? '(no model output — scripted fallback substituted after the model produced nothing usable)'
        : '(empty)';
    const body = `
      <details open>
        <summary>recalled memories (${r.recalledMemories.length})</summary>
        <pre>${escapeHtml(memories)}</pre>
      </details>
      <details>
        <summary>system prompt</summary>
        <pre>${escapeHtml(r.prompt.system)}</pre>
      </details>
      <details open>
        <summary>perception (user prompt)</summary>
        <pre>${escapeHtml(r.prompt.user)}</pre>
      </details>
      <details open>
        <summary>raw model output</summary>
        <pre>${escapeHtml(r.rawOutput || rawLabel)}</pre>
      </details>`;
    showModal(header, body);
  }
}

/** Human-readable one-liner for an action/interaction. */
function describe(d: AgentDecision): string {
  switch (d.kind) {
    case 'move_to':
      return `walk → (${d.x}, ${d.y})`;
    case 'say':
      return `say: "${d.message}"`;
    case 'reason':
      return `think: "${d.thought}"`;
    case 'interact_with':
      return `use ${d.objectId}`;
    case 'work_at':
      return `work at ${d.buildingId}`;
    case 'take_from':
      return `take ${d.resource} from ${d.buildingId}`;
    case 'give_to':
      return `give ${d.resource} to ${d.buildingId}`;
    case 'pray_at':
      return `pray at ${d.buildingId}: "${d.message}"`;
    case 'propose_plan':
      return `propose ${d.planKind} plan: "${d.goal}" (will ${d.role})`;
    case 'join_plan':
      return `join the group plan: ${d.role}`;
    case 'propose_build':
      return `propose building ${d.structure} "${d.name}" at (${d.x}, ${d.y})`;
    case 'command_cart':
      return `set cart ${d.cartId}: haul ${d.resource} from ${d.fromBuildingId} to ${d.toBuildingId}`;
    case 'add_to_agenda':
      return d.itemKind === 'event'
        ? `add event to agenda: "${d.title}"${d.partOfDay ? ` (+${d.dayOffset ?? 0}d ${d.partOfDay})` : ''}`
        : `note on agenda: "${d.title}"`;
    case 'propose_event':
      return `propose event: "${d.title}" (+${d.dayOffset}d ${d.partOfDay})`;
    case 'accept_event':
      return `accept event ${d.eventId}`;
  }
}

/** One stored memory rendered as a row: a kind badge, relative age, and the text. */
function memoryRow(m: VillagerMemory): HTMLElement {
  const row = document.createElement('div');
  row.className = `memory memory--${escapeAttr(m.kind)}`;
  row.innerHTML = `
    <div class="memory__meta">
      <span class="memory__kind">${escapeHtml(m.kind)}</span>
      <span class="memory__age">${escapeHtml(relativeTime(m.timestamp))}</span>
    </div>
    <div class="memory__text">${escapeHtml(m.text)}</div>`;
  // A salience dot whose opacity tracks importance, so reflections read as weightier.
  const dot = document.createElement('span');
  dot.className = 'memory__dot';
  dot.style.opacity = String(Math.max(0.2, Math.min(1, m.importance)));
  dot.title = `importance ${m.importance.toFixed(2)}`;
  row.querySelector('.memory__meta')!.prepend(dot);
  return row;
}

/** A compact "3h ago" style age from a wall-clock ms timestamp. */
function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Escape a value destined for an HTML attribute (e.g. a CSS color). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** One labelled need bar's skeleton; its fill is sized/coloured live by the panel. */
function needRow(label: string): string {
  return `
    <span class="need" data-need="${label}">
      <i>${label}</i>
      <b class="need__bar"><u></u></b>
    </span>`;
}

/** Set the text of a card's child element, found by selector. */
function setText(card: HTMLElement, selector: string, text: string): void {
  const el = card.querySelector(selector);
  if (el) el.textContent = text;
}

/** A need's bar colour: green when comfortable, amber when pressing, red when dire. */
function needColor(value: number): string {
  if (value >= 80) return '#f85149';
  if (value >= 50) return '#d29922';
  return '#3fb950';
}
