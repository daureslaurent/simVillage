/**
 * client/src/AgendaPanel.ts
 * ---------------------------------------------------------------------------
 * The AGENDA view — every villager's book of intentions and the happenings the
 * village has planned. Two ways to read it, toggled in the card header:
 *
 *   - TIMELINE   — all upcoming events across the village in one chronological list,
 *                  soonest first, each colour-coded to its attendees.
 *   - BY VILLAGER — a section per villager: the events they are attending, the ones
 *                   they have been invited to, and their untimed notes.
 *
 * Seeded from `GET /agenda` and updated live as `agenda.updated` / `agenda.removed`
 * messages arrive. Events expire server-side once their time has passed, so the list
 * stays a window onto what is still to come.
 * ---------------------------------------------------------------------------
 */

import type { AgendaEvent, AgendaItem } from '../../shared/types';
import { simTimeFromTick, formatSimTimeOfDay } from '../../shared/simClock';
import { escapeHtml } from './modal';
import { makeVlifeCard, type VlifeCard } from './vlife';

export interface AgendaPanelOptions {
  /** Fetch the live agenda once at startup. */
  onFetch: () => Promise<AgendaItem[]>;
  /** Resolve a villager's render colour (for the colour dots / swatches), if known. */
  colorOf: (villagerId: string) => string | undefined;
  /** The current sim tick, for relative-day labels ("Today", "Tomorrow"). */
  getTick: () => number;
}

/** A villager's slice of the agenda, assembled for the by-villager view. */
interface VillagerAgenda {
  id: string;
  name: string;
  attending: AgendaEvent[];
  invited: AgendaEvent[];
  notes: string[];
}

export class AgendaPanel {
  private readonly card: VlifeCard;
  private readonly items = new Map<string, AgendaItem>();
  private view: 'timeline' | 'villager' = 'timeline';

  constructor(
    root: HTMLElement,
    private readonly options: AgendaPanelOptions,
  ) {
    this.card = makeVlifeCard(root, { icon: '📅', title: 'Agenda' });
    // Toggle the view from the segmented control (event-delegated, attached once).
    this.card.body.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-view]');
      if (!btn) return;
      const next = btn.dataset.view === 'villager' ? 'villager' : 'timeline';
      if (next !== this.view) {
        this.view = next;
        this.render();
      }
    });
    this.render();
    void this.options
      .onFetch()
      .then((items) => {
        for (const i of items) this.items.set(i.id, i);
        this.render();
      })
      .catch(() => {
        /* empty until the first live item */
      });
  }

  /** Fold one created/changed agenda item into the view. */
  ingest(item: AgendaItem): void {
    this.items.set(item.id, item);
    this.render();
  }

  /** Drop an expired event or stale note. */
  remove(itemId: string): void {
    if (this.items.delete(itemId)) this.render();
  }

  // -------------------------------------------------------------------------

  private events(): AgendaEvent[] {
    return [...this.items.values()]
      .filter((i): i is AgendaEvent => i.type === 'event')
      .sort((a, b) => a.scheduledTick - b.scheduledTick);
  }

  private render(): void {
    this.card.setCount(this.items.size);
    const toggle = this.renderToggle();

    if (this.items.size === 0) {
      this.card.body.innerHTML =
        toggle +
        `<div class="vlife__empty">No plans afoot — villagers note intentions and propose events as the day unfolds.</div>`;
      return;
    }

    this.card.body.innerHTML =
      toggle +
      (this.view === 'timeline' ? this.renderTimeline() : this.renderByVillager());
  }

  private renderToggle(): string {
    const on = (v: string): string => (this.view === v ? ' agenda-seg__btn--on' : '');
    return `
      <div class="agenda-seg">
        <button class="agenda-seg__btn${on('timeline')}" data-view="timeline">Timeline</button>
        <button class="agenda-seg__btn${on('villager')}" data-view="villager">By villager</button>
      </div>`;
  }

  // — Timeline view —

  private renderTimeline(): string {
    const events = this.events();
    if (events.length === 0) {
      return `<div class="vlife__empty">No scheduled events — only personal notes so far. Switch to "By villager" to see them.</div>`;
    }
    return events.map((e) => this.renderEvent(e, true)).join('');
  }

  private renderEvent(e: AgendaEvent, showAttendees: boolean): string {
    const place = e.placeName
      ? `<div class="agenda-ev__place">📍 ${escapeHtml(e.placeName)}</div>`
      : '';
    const badge = e.shared
      ? `<span class="agenda-ev__badge agenda-ev__badge--shared">shared</span>`
      : `<span class="agenda-ev__badge agenda-ev__badge--personal">personal</span>`;
    const attendees =
      showAttendees && e.participants.length > 0
        ? `<div class="agenda-ev__people">${e.participants.map((m) => this.dot(m.villagerId, m.villagerName)).join('')}</div>`
        : '';
    const invited =
      showAttendees && e.invited.length > 0
        ? `<div class="agenda-ev__invited">invited: ${e.invited.map((m) => escapeHtml(m.villagerName)).join(', ')}</div>`
        : '';
    return `
      <div class="agenda-ev">
        <div class="agenda-ev__when">${this.whenLabel(e)}</div>
        <div class="agenda-ev__title">${escapeHtml(e.title)} ${badge}</div>
        ${place}
        ${attendees}
        ${invited}
      </div>`;
  }

  // — By-villager view —

  private renderByVillager(): string {
    const byId = new Map<string, VillagerAgenda>();
    const ensure = (id: string, name: string): VillagerAgenda => {
      let v = byId.get(id);
      if (!v) {
        v = { id, name, attending: [], invited: [], notes: [] };
        byId.set(id, v);
      }
      // Keep the freshest name we have seen for this villager.
      if (name && name !== id) v.name = name;
      return v;
    };

    for (const item of this.items.values()) {
      if (item.type === 'note') {
        ensure(item.ownerId, item.ownerName).notes.push(item.title);
        continue;
      }
      for (const m of item.participants) ensure(m.villagerId, m.villagerName).attending.push(item);
      for (const m of item.invited) ensure(m.villagerId, m.villagerName).invited.push(item);
    }

    const people = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (people.length === 0) return `<div class="vlife__empty">No agendas yet.</div>`;

    return people
      .map((p) => {
        const attending = p.attending
          .sort((a, b) => a.scheduledTick - b.scheduledTick)
          .map((e) => this.renderEvent(e, false))
          .join('');
        const invited = p.invited
          .sort((a, b) => a.scheduledTick - b.scheduledTick)
          .map(
            (e) =>
              `<div class="agenda-ev agenda-ev--invited"><div class="agenda-ev__when">${this.whenLabel(e)}</div><div class="agenda-ev__title">${escapeHtml(e.title)} <span class="agenda-ev__badge agenda-ev__badge--invited">invited</span></div></div>`,
          )
          .join('');
        const notes = p.notes.length
          ? `<ul class="agenda-notes">${p.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
          : '';
        const empty =
          !attending && !invited && !notes
            ? `<div class="agenda-person__empty">nothing planned</div>`
            : '';
        return `
          <div class="agenda-person">
            <div class="agenda-person__who">
              <span class="agenda-person__swatch" style="background:${this.colorFor(p.id)}"></span>
              <span class="agenda-person__name">${escapeHtml(p.name)}</span>
            </div>
            ${attending}${invited}${notes}${empty}
          </div>`;
      })
      .join('');
  }

  // — helpers —

  /** A villager colour dot with a name, for an event's attendee row. */
  private dot(id: string, name: string): string {
    return `<span class="agenda-dot"><span class="agenda-dot__swatch" style="background:${this.colorFor(id)}"></span>${escapeHtml(name)}</span>`;
  }

  private colorFor(id: string): string {
    return this.options.colorOf(id) ?? '#8aa0c8';
  }

  /** "Today · evening (20:00)" / "Tomorrow · morning (09:00)" / "Day 5 · afternoon …". */
  private whenLabel(e: AgendaEvent): string {
    const currentDay = simTimeFromTick(this.options.getTick()).day;
    const dd = e.day - currentDay;
    const rel = dd <= 0 ? 'Today' : dd === 1 ? 'Tomorrow' : `Day ${e.day}`;
    return `<span class="agenda-ev__rel">${rel}</span><span class="agenda-ev__time">${escapeHtml(e.partOfDay)} · ${formatSimTimeOfDay(e.scheduledTick)}</span>`;
  }
}
