/**
 * server/src/persistence/ConversationStore.ts
 * ---------------------------------------------------------------------------
 * The seam for persisted CONVERSATIONS — the back-and-forth transcripts the
 * `ConversationTracker` builds from villager speech.
 *
 * Unlike the action log (one document per action, never updated), a conversation
 * is upserted in place: it grows a line at a time as the same pair keeps talking,
 * so the store replaces the whole document by its stable `id` each turn.
 *
 * Split into a write side (`ConversationStore`) and a read side
 * (`ConversationReader`, handed to the gateway) so the browser-facing endpoint
 * can only ever read.
 * ---------------------------------------------------------------------------
 */

import type { Conversation } from '../../../shared/types';

/** Read-only view, as exposed to the gateway's HTTP endpoint. */
export interface ConversationReader {
  /** Most-recently-active conversations, newest first, capped at `limit`. */
  list(limit?: number): Promise<Conversation[]>;
}

/** Full conversation store: the tracker writes, the gateway reads. */
export interface ConversationStore extends ConversationReader {
  connect(): Promise<void>;
  /** Insert or replace a conversation by its `id`. */
  upsert(conversation: Conversation): Promise<void>;
  close(): Promise<void>;
}
