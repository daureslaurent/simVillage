/**
 * server/src/ConversationTracker.ts
 * ---------------------------------------------------------------------------
 * Collects every `villager.speak` intent into the village CHAT — one rolling
 * transcript of everything said aloud, in the order it was said.
 *
 * Speech is broadcast, not directed: a villager says something and whoever is in
 * earshot hears it. So rather than weaving utterances into per-pair threads, the
 * tracker keeps a SINGLE growing chat log (capped to the most recent lines) — the
 * observer's god-view of the whole conversation, even though each villager only
 * perceives the part spoken near it.
 *
 * Every new line is (a) upserted to the `ConversationStore` for durability and
 * history, and (b) published on the telemetry exchange so the gateway can push the
 * update to the browser live. It owns no world state of record: it tracks only the
 * latest tick (to stamp lines) and the running log, and writes fire-and-forget so a
 * slow disk never stalls the speech stream.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import { EXCHANGES, type VillagerSpeakEvent, type WorldEvent } from '../../shared/events';
import type { Conversation } from '../../shared/types';
import type { ConversationStore } from './persistence/ConversationStore';

/** The fixed id of the single village-wide chat log. */
const VILLAGE_CHAT_ID = 'village-chat';

export interface ConversationTrackerOptions {
  /** Resolve a villager id to a display name (falls back to the id). */
  nameById: (id: string) => string;
  /** How many recent lines to keep in the rolling log. Defaults to 200. */
  maxLines?: number;
}

export class ConversationTracker {
  private readonly nameById: (id: string) => string;
  private readonly maxLines: number;

  /** The single village chat log, built lazily on the first utterance. */
  private chat: Conversation | null = null;
  /** Latest world tick, used to stamp each line. */
  private tick = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly store: ConversationStore,
    options: ConversationTrackerOptions,
  ) {
    this.nameById = options.nameById;
    this.maxLines = options.maxLines ?? 200;
  }

  async start(): Promise<void> {
    // Track the world clock so each line carries a sensible tick.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.map_updated', (event) => {
      if (event.type === 'world.map_updated') this.tick = event.payload.tick;
    });

    await this.bus.subscribe<VillagerSpeakEvent>(
      EXCHANGES.villagerIntents,
      'villager.speak',
      (event) => this.onSpeak(event),
    );

    console.log('[conversations] collecting villager speech into the village chat');
  }

  private onSpeak(event: VillagerSpeakEvent): void {
    const { villagerId: speakerId, message } = event.payload;
    if (!message) return;

    const nowIso = new Date().toISOString();
    const chat = this.chat ?? this.openChat(nowIso);

    chat.messages.push({
      speakerId,
      speakerName: this.nameById(speakerId),
      message,
      tick: this.tick,
      at: nowIso,
    });
    // Keep the log bounded — drop the oldest lines past the cap.
    if (chat.messages.length > this.maxLines) {
      chat.messages.splice(0, chat.messages.length - this.maxLines);
    }
    // Grow the participant roster in first-seen order.
    if (!chat.participants.includes(speakerId)) {
      chat.participants.push(speakerId);
      chat.participantNames.push(this.nameById(speakerId));
    }
    chat.lastAt = nowIso;
    chat.lastTick = this.tick;

    this.persist(chat);
    this.broadcast(chat);
  }

  /** Start the village chat log on the first thing anyone says. */
  private openChat(nowIso: string): Conversation {
    this.chat = {
      id: VILLAGE_CHAT_ID,
      participants: [],
      participantNames: [],
      startedAt: nowIso,
      lastAt: nowIso,
      startTick: this.tick,
      lastTick: this.tick,
      messages: [],
    };
    return this.chat;
  }

  /** Durably store the chat log; fire-and-forget so writes never block speech. */
  private persist(conversation: Conversation): void {
    void this.store.upsert(conversation).catch((err) => {
      console.warn('[conversations] failed to persist:', err);
    });
  }

  /** Push the updated chat to observers (the gateway forwards it on). */
  private broadcast(conversation: Conversation): void {
    this.bus.publish(
      EXCHANGES.villagerTelemetry,
      makeEvent('villager.conversation.updated', conversation),
    );
  }
}
