/**
 * client/src/RosterPanel.ts
 * ---------------------------------------------------------------------------
 * The left-docked VILLAGER ROSTER.
 *
 *   ROSTER VIEW   — one card per villager currently in the world. Click a card…
 *   HISTORY VIEW  — …to see every action/interaction that villager has taken,
 *                   newest first. The list is seeded from the durable action log
 *                   (fetched over HTTP) and then kept live as new thoughts stream
 *                   in. Each row carries a "LLM" button that pops a MODAL with the
 *                   technical context behind that action: the prompt sent to the
 *                   model, the memories RAG recalled, and the raw model output.
 *
 * The panel owns its DOM and stays transport-agnostic: `main.ts` injects the
 * history fetcher and feeds it the world's villager list + the thought stream.
 * ---------------------------------------------------------------------------
 */

import type { AgentDecision, Gathering, Villager, VillagerNeeds, VillagerActionRecord, VillagerThoughtMessage } from '../../shared/types';
import { BACKPACK_CAPACITY } from '../../shared/types';
import { escapeHtml, showModal } from './modal';

export interface RosterOptions {
  /** Load a villager's persisted action history (newest first). */
  onFetchActions: (villagerId: string) => Promise<VillagerActionRecord[]>;
}

/** How many live-appended actions to keep before trimming the history view. */
const MAX_ROWS = 300;

export class RosterPanel {
  private readonly listEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly backBtn: HTMLButtonElement;

  /** Villager currently expanded into history view, or null in roster view. */
  private selectedId: string | null = null;
  /** Last rendered roster signature, to avoid rebuilding cards every tick. */
  private rosterSig = '';
  /** id -> display name, learned from the thought/action streams. */
  private readonly names = new Map<string, string>();
  /** Latest villager list, so we can re-render the roster after going "back". */
  private villagers: Villager[] = [];
  /** Latest gatherings, so each card can show who its villager is grouped with. */
  private gatherings: Gathering[] = [];
  /** id -> the card element currently shown, so live stats update in place. */
  private readonly cardById = new Map<string, HTMLElement>();

  constructor(
    root: HTMLElement,
    private readonly options: RosterOptions,
  ) {
    root.classList.add('roster');
    root.innerHTML = `
      <header class="roster__head">
        <button class="roster__back" title="Back to villagers" hidden>←</button>
        <span class="roster__title">Villagers</span>
      </header>
      <div class="roster__list"></div>`;

    this.titleEl = root.querySelector('.roster__title')!;
    this.listEl = root.querySelector('.roster__list')!;
    this.backBtn = root.querySelector('.roster__back')!;
    this.backBtn.addEventListener('click', () => this.showRoster());
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
    if (this.selectedId) return; // history view is open; don't disturb it
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
    if (thought.villagerId !== this.selectedId || !thought.decision) return;
    this.prependRow(
      this.actionRow({
        villagerId: thought.villagerId,
        villagerName: thought.villagerName,
        tick: thought.tick,
        decision: thought.decision,
        recalledMemories: thought.recalledMemories,
        prompt: thought.prompt,
        rawOutput: thought.rawOutput,
        recordedAt: new Date().toISOString(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Roster view
  // -------------------------------------------------------------------------

  private showRoster(): void {
    this.selectedId = null;
    this.rosterSig = ''; // force a rebuild
    this.backBtn.hidden = true;
    this.titleEl.textContent = 'Villagers';
    this.renderRoster();
  }

  /** Build the (static) card skeletons; live values are filled by {@link updateStats}. */
  private renderRoster(): void {
    this.cardById.clear();
    const cards = this.villagers.map((v) => {
      const card = document.createElement('button');
      card.className = 'roster__card';
      card.innerHTML = `
        <div class="roster__top">
          <span class="roster__swatch" style="background:${escapeAttr(v.color)}"></span>
          <span class="roster__name"></span>
        </div>
        <div class="roster__status"></div>
        <div class="roster__task" hidden></div>
        <div class="roster__needs">
          ${needRow('Hunger')}
          ${needRow('Thirst')}
          ${needRow('Fatigue')}
          ${needRow('Boredom')}
        </div>
        <div class="roster__pack" title="backpack"></div>
        <div class="roster__group" hidden></div>`;
      card.addEventListener('click', () => void this.openHistory(v.id));
      this.cardById.set(v.id, card);
      return card;
    });
    this.listEl.replaceChildren(...cards);
    if (cards.length === 0) {
      this.listEl.innerHTML = `<div class="roster__empty">no villagers yet…</div>`;
    }
  }

  /** Refresh the live values (name, status, need bars, backpack) on every card. */
  private updateStats(): void {
    for (const v of this.villagers) {
      const card = this.cardById.get(v.id);
      if (!card) continue;

      const name = v.name || this.names.get(v.id) || v.id;
      setText(card, '.roster__name', name);
      setText(card, '.roster__status', v.status ?? (v.target ? 'walking' : 'idle'));

      // The villager's standing job (a refill chore), if any — shown as a small
      // task line so it's clear who is busy keeping the village's buildings stocked.
      const task = card.querySelector('.roster__task') as HTMLElement | null;
      if (task) {
        if (v.task) {
          task.textContent = `🛠️ ${v.task.label}`;
          task.hidden = false;
        } else {
          task.hidden = true;
        }
      }

      if (v.needs) this.fillNeeds(card, v.needs);

      const pack = card.querySelector('.roster__pack');
      if (pack) {
        const items = v.backpack ?? [];
        const filled = Math.min(items.length, BACKPACK_CAPACITY);
        const pips = '●'.repeat(filled) + '○'.repeat(Math.max(0, BACKPACK_CAPACITY - filled));
        pack.textContent = `🎒 ${pips}`;
        pack.setAttribute('title', items.length ? items.join(', ') : 'empty');
      }

      const group = card.querySelector('.roster__group') as HTMLElement | null;
      if (group) {
        const gathering = this.gatherings.find((g) => g.memberIds.includes(v.id));
        if (gathering) {
          const others = gathering.memberIds
            .filter((id) => id !== v.id)
            .map((id) => this.displayName(id));
          const where = gathering.place ? ` at ${gathering.place}` : '';
          group.textContent = `👥 with ${others.join(', ')}${where}`;
          group.hidden = false;
        } else {
          group.hidden = true;
        }
      }
    }
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

  // -------------------------------------------------------------------------
  // History view
  // -------------------------------------------------------------------------

  private async openHistory(villagerId: string): Promise<void> {
    this.selectedId = villagerId;
    this.backBtn.hidden = false;
    const villager = this.villagers.find((v) => v.id === villagerId);
    this.titleEl.textContent = villager?.name || this.names.get(villagerId) || villagerId;
    this.listEl.replaceChildren();
    this.listEl.innerHTML = `<div class="roster__empty">loading actions…</div>`;

    let records: VillagerActionRecord[] = [];
    try {
      records = await this.options.onFetchActions(villagerId);
    } catch {
      this.listEl.innerHTML = `<div class="roster__empty">failed to load history</div>`;
      return;
    }
    if (this.selectedId !== villagerId) return; // user navigated away while loading

    if (records.length === 0) {
      this.listEl.innerHTML = `<div class="roster__empty">no actions recorded yet</div>`;
      return;
    }
    this.listEl.replaceChildren(...records.map((r) => this.actionRow(r)));
  }

  /** Build one action row: a summary line + a button into the LLM-data modal. */
  private actionRow(r: VillagerActionRecord): HTMLElement {
    const row = document.createElement('div');
    row.className = 'action';
    row.innerHTML = `
      <div class="action__main">
        <span class="action__tick">t${r.tick}</span>
        <span class="action__desc">${escapeHtml(describe(r.decision))}</span>
      </div>
      <button class="action__llm" title="Technical LLM data">LLM</button>`;
    row.querySelector('.action__llm')!.addEventListener('click', () => this.openModal(r));
    return row;
  }

  private prependRow(row: HTMLElement): void {
    const empty = this.listEl.querySelector('.roster__empty');
    if (empty) empty.remove();
    this.listEl.prepend(row);
    while (this.listEl.childElementCount > MAX_ROWS) {
      this.listEl.lastElementChild?.remove();
    }
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

    const header = `${escapeHtml(r.villagerName)} · tick ${r.tick} · <b>${escapeHtml(describe(r.decision))}</b>`;
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
        <pre>${escapeHtml(r.rawOutput || '(empty)')}</pre>
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
  }
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
