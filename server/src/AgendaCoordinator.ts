/**
 * server/src/AgendaCoordinator.ts
 * ---------------------------------------------------------------------------
 * The keeper of every villager's AGENDA — their private book of intentions and the
 * scheduled happenings the village plans together.
 *
 * Where the {@link GroupCoordinator} tracks the loose plans a gathering forms in the
 * moment, the agenda is about TIME: a villager jots untimed notes to itself, fixes
 * personal events to a day + part of day, and proposes shared events that neighbours
 * accept and are then drawn toward when the hour comes. This service is the small
 * authority that turns those intents into live {@link AgendaItem}s:
 *
 *   - `villager.add_agenda`    → a note, or a personal (private) event, on the owner;
 *   - `villager.propose_event` → a shared event with the proposer attending and everyone
 *                                gathered with them invited;
 *   - `villager.accept_event`  → moves a villager from a shared event's invited list to
 *                                its attendees.
 *
 * It tracks the live gatherings (off the world stream) so a proposal invites the right
 * circle, resolves a `placeId` to a building name (off `world.init`), broadcasts every
 * change on the telemetry exchange (so the minds keep their own agenda current and the
 * UI can show the whole village's), and EXPIRES events once their time has comfortably
 * passed and notes once they go stale — so an agenda stays a window onto what is still
 * to come. Its live items are persisted so the village's plans survive a reboot, and it
 * is the read model behind the gateway's `/agenda`.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import {
  EXCHANGES,
  type VillagerIntentEvent,
  type WorldEvent,
} from '../../shared/events';
import type {
  AgendaEvent,
  AgendaItem,
  AgendaNote,
  AgendaParticipant,
  AgendaPartOfDay,
} from '../../shared/types';
import { simTimeFromTick, tickForDayPart } from '../../shared/simClock';
import type { RuntimeStateStore } from './persistence/RuntimeStateStore';

/**
 * How long (in ticks) after a scheduled event's time it lingers before being dropped.
 * ~120 ticks is roughly a single in-world part-of-day, so an event stays visible for
 * the window it was meant to happen in, then clears.
 */
const EVENT_GRACE_TICKS = 120;
/** Untimed notes are dropped after this long, so the list stays current (~2 in-world days). */
const NOTE_TTL_TICKS = 960;
/** Most items to keep live at once, so a busy village can't grow the agenda unbounded. */
const MAX_ITEMS = 60;
/** The runtime-state key the village's agendas are persisted under. */
const AGENDAS_KEY = 'agendas';

/** The persisted shape: the live notes and events as plain arrays. */
interface AgendaSnapshot {
  notes: AgendaNote[];
  events: AgendaEvent[];
}

export class AgendaCoordinator {
  /** Untimed personal notes, by id. */
  private readonly notes = new Map<string, AgendaNote>();
  /** Scheduled events (personal and shared), by id. */
  private readonly events = new Map<string, AgendaEvent>();
  /** Latest tick from the world stream, used to schedule + expire items. */
  private tick = 0;
  /** villagerId -> the set of ids it is currently gathered with (itself included). */
  private gatheringOf = new Map<string, Set<string>>();
  /** id -> display name, kept current from the world stream. */
  private readonly names = new Map<string, string>();
  /** buildingId -> display name, cached from `world.init` for resolving event places. */
  private readonly buildingNames = new Map<string, string>();
  /** Monotonic counter so ids minted in the same tick never collide. */
  private seq = 0;

  constructor(
    private readonly bus: EventBus,
    /** Optional durable store so the village's agendas survive a reboot. */
    private readonly state?: RuntimeStateStore,
  ) {}

  async start(): Promise<void> {
    // Restore persisted agendas first, so a reboot keeps the village's plans.
    await this.restore();

    // Cache building names (for resolving event places) and track gatherings + tick +
    // villager names off the world stream.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.init', (event) => {
      if (event.type !== 'world.init') return;
      for (const b of event.payload.buildings) this.buildingNames.set(b.id, b.name);
    });
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.map_updated', (event) => {
      if (event.type !== 'world.map_updated') return;
      this.tick = event.payload.tick;
      for (const v of event.payload.villagers) this.names.set(v.id, v.name ?? v.id);
      const map = new Map<string, Set<string>>();
      for (const g of event.payload.gatherings ?? []) {
        const set = new Set(g.memberIds);
        for (const id of g.memberIds) map.set(id, set);
      }
      this.gatheringOf = map;
      this.expireStale();
    });

    // The agenda intents. Each gets its own durable queue so it never competes with the
    // engine (which ignores these) or any other consumer for the envelopes.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.add_agenda',
      (event) => {
        if (event.type === 'villager.add_agenda') this.onAdd(event.payload);
      },
      { queue: 'agenda.add', durable: true },
    );
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.propose_event',
      (event) => {
        if (event.type === 'villager.propose_event') this.onProposeEvent(event.payload);
      },
      { queue: 'agenda.propose', durable: true },
    );
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.accept_event',
      (event) => {
        if (event.type === 'villager.accept_event') this.onAcceptEvent(event.payload);
      },
      { queue: 'agenda.accept', durable: true },
    );

    console.log('[agenda] tracking villager agendas');
  }

  /** Every live agenda item, soonest events first then notes — the gateway's read model. */
  all(): AgendaItem[] {
    const events = [...this.events.values()].sort((a, b) => a.scheduledTick - b.scheduledTick);
    const notes = [...this.notes.values()].sort((a, b) => b.createdTick - a.createdTick);
    return [...events, ...notes];
  }

  // -------------------------------------------------------------------------

  private onAdd(p: {
    villagerId: string;
    itemKind: 'note' | 'event';
    title: string;
    dayOffset?: number;
    partOfDay?: AgendaPartOfDay;
    placeId?: string;
  }): void {
    const title = p.title?.trim();
    if (!title) return;
    const ownerName = this.nameOf(p.villagerId);

    if (p.itemKind === 'event' && p.partOfDay) {
      const event = this.makeEvent({
        organizerId: p.villagerId,
        organizerName: ownerName,
        title,
        dayOffset: p.dayOffset ?? 0,
        partOfDay: p.partOfDay,
        placeId: p.placeId,
        shared: false,
        invited: [],
      });
      this.events.set(event.id, event);
      this.trim();
      console.log(`[agenda] ${ownerName} set a personal event: "${title}" (${event.day}/${event.partOfDay})`);
      this.broadcast(event);
      return;
    }

    const note: AgendaNote = {
      type: 'note',
      id: this.mintId('note', p.villagerId),
      ownerId: p.villagerId,
      ownerName,
      title,
      createdTick: this.tick,
    };
    this.notes.set(note.id, note);
    this.trim();
    console.log(`[agenda] ${ownerName} noted: "${title}"`);
    this.broadcast(note);
  }

  private onProposeEvent(p: {
    villagerId: string;
    title: string;
    dayOffset: number;
    partOfDay: AgendaPartOfDay;
    placeId?: string;
  }): void {
    const title = p.title?.trim();
    if (!title) return;
    const organizerName = this.nameOf(p.villagerId);

    // Invite everyone currently gathered with the proposer (its circle, minus itself).
    const circle = this.gatheringOf.get(p.villagerId);
    const invited: AgendaParticipant[] = [];
    if (circle) {
      for (const id of circle) {
        if (id === p.villagerId) continue;
        invited.push({ villagerId: id, villagerName: this.nameOf(id) });
      }
    }

    const event = this.makeEvent({
      organizerId: p.villagerId,
      organizerName,
      title,
      dayOffset: p.dayOffset,
      partOfDay: p.partOfDay,
      placeId: p.placeId,
      shared: true,
      invited,
    });
    this.events.set(event.id, event);
    this.trim();
    console.log(
      `[agenda] ${organizerName} proposed an event: "${title}" (${event.day}/${event.partOfDay}), ` +
        `inviting ${invited.length} neighbour(s)`,
    );
    this.broadcast(event);
  }

  private onAcceptEvent(p: { villagerId: string; eventId: string }): void {
    const event = this.events.get(p.eventId);
    if (!event) {
      console.log(`[agenda] ${this.nameOf(p.villagerId)} tried to accept an event that is gone`);
      return;
    }
    if (event.participants.some((m) => m.villagerId === p.villagerId)) return; // already attending
    const name = this.nameOf(p.villagerId);
    event.participants.push({ villagerId: p.villagerId, villagerName: name });
    event.invited = event.invited.filter((m) => m.villagerId !== p.villagerId);
    console.log(`[agenda] ${name} accepted "${event.title}"`);
    this.broadcast(event);
  }

  /** Build a scheduled event from a proposal, resolving its time and place. */
  private makeEvent(input: {
    organizerId: string;
    organizerName: string;
    title: string;
    dayOffset: number;
    partOfDay: AgendaPartOfDay;
    placeId?: string;
    shared: boolean;
    invited: AgendaParticipant[];
  }): AgendaEvent {
    const currentDay = simTimeFromTick(this.tick).day;
    let day = currentDay + Math.max(0, Math.floor(input.dayOffset));
    let scheduledTick = tickForDayPart(day, input.partOfDay);
    // If that moment has already slipped past today, roll it to the next day so an
    // event is never scheduled in the past (e.g. "this morning" proposed at dusk).
    if (scheduledTick <= this.tick) {
      day += 1;
      scheduledTick = tickForDayPart(day, input.partOfDay);
    }
    const placeName = input.placeId ? this.buildingNames.get(input.placeId) : undefined;
    const event: AgendaEvent = {
      type: 'event',
      id: this.mintId('evt', input.organizerId),
      title: input.title,
      organizerId: input.organizerId,
      organizerName: input.organizerName,
      scheduledTick,
      day,
      partOfDay: input.partOfDay,
      shared: input.shared,
      participants: [{ villagerId: input.organizerId, villagerName: input.organizerName }],
      invited: input.invited,
      createdTick: this.tick,
    };
    if (input.placeId) event.placeId = input.placeId;
    if (placeName) event.placeName = placeName;
    return event;
  }

  /** Drop events whose time has comfortably passed and notes that have gone stale. */
  private expireStale(): void {
    let dropped = false;
    for (const [id, event] of this.events) {
      if (this.tick - event.scheduledTick > EVENT_GRACE_TICKS) {
        this.events.delete(id);
        this.remove(id);
        dropped = true;
      }
    }
    for (const [id, note] of this.notes) {
      if (this.tick - note.createdTick > NOTE_TTL_TICKS) {
        this.notes.delete(id);
        this.remove(id);
        dropped = true;
      }
    }
    if (dropped) void this.persist();
  }

  /** Keep only the most recent {@link MAX_ITEMS} items, oldest-created dropped first. */
  private trim(): void {
    const total = this.notes.size + this.events.size;
    if (total <= MAX_ITEMS) return;
    const all: { id: string; createdTick: number; map: Map<string, unknown> }[] = [
      ...[...this.notes.values()].map((n) => ({ id: n.id, createdTick: n.createdTick, map: this.notes as Map<string, unknown> })),
      ...[...this.events.values()].map((e) => ({ id: e.id, createdTick: e.createdTick, map: this.events as Map<string, unknown> })),
    ].sort((a, b) => a.createdTick - b.createdTick);
    const toDrop = all.slice(0, total - MAX_ITEMS);
    for (const d of toDrop) {
      d.map.delete(d.id);
      this.remove(d.id);
    }
  }

  private broadcast(item: AgendaItem): void {
    this.bus.publish(EXCHANGES.villagerTelemetry, makeEvent('villager.agenda.updated', item));
    void this.persist();
  }

  private remove(itemId: string): void {
    this.bus.publish(EXCHANGES.villagerTelemetry, makeEvent('villager.agenda.removed', { itemId }));
  }

  private mintId(prefix: string, ownerId: string): string {
    return `${prefix}_${ownerId}_${this.tick}_${this.seq++}`;
  }

  private nameOf(id: string): string {
    return this.names.get(id) ?? id;
  }

  // -------------------------------------------------------------------------
  // Durable state: the village's agendas survive a reboot
  // -------------------------------------------------------------------------

  private async restore(): Promise<void> {
    if (!this.state) return;
    try {
      const saved = await this.state.get<AgendaSnapshot>(AGENDAS_KEY);
      if (!saved) return;
      for (const note of saved.notes ?? []) this.notes.set(note.id, note);
      for (const event of saved.events ?? []) this.events.set(event.id, event);
      if (this.notes.size + this.events.size > 0) {
        console.log(`[agenda] restored ${this.events.size} event(s) and ${this.notes.size} note(s)`);
      }
    } catch (err) {
      console.warn('[agenda] failed to restore agendas:', errMsg(err));
    }
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.set<AgendaSnapshot>(AGENDAS_KEY, {
        notes: [...this.notes.values()],
        events: [...this.events.values()],
      });
    } catch (err) {
      console.warn('[agenda] failed to persist agendas:', errMsg(err));
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
