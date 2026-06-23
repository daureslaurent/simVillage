/**
 * client/src/ConversationsPanel.ts
 * ---------------------------------------------------------------------------
 * The live VILLAGE CHAT dock — now TABBED.
 *
 *   • "Village Chat"  — everything villagers say ALOUD, as one rolling feed
 *     (seeded from the durable chat log, then kept live via `conversation.updated`).
 *   • "Reasoning"     — every PRIVATE deliberation (the `reason` move). These are
 *     never spoken; they stream live off the thought feed, tagged *[REASONING DATA]*
 *     in a distinct colour, with the same in-world stamp + villager name as chat.
 *
 * Both feeds are "Twitch-chat" style: newest at the bottom, auto-scroll follows the
 * latest line only while the viewer is already pinned there. Each tab keeps its own
 * scroll position. Transport-agnostic: `main.ts` injects the chat fetcher, feeds
 * `ingest()` chat updates, and feeds `ingestThought()` the thought stream.
 * ---------------------------------------------------------------------------
 */

import type { Conversation, ConversationMessage, VillagerThoughtMessage } from '../../shared/types';
import { formatSimClock } from '../../shared/simClock';
import { escapeHtml } from './modal';

export interface ConversationsOptions {
  /** Load the existing chat log(s). */
  onFetch: () => Promise<Conversation[]>;
}

/** One private deliberation to show in the Reasoning tab. */
interface ReasoningEntry {
  tick: number;
  name: string;
  thought: string;
}

/** Cap the live reasoning buffer so a long session can't grow it without bound. */
const MAX_REASONING = 300;

export class ConversationsPanel {
  /** The "Village Chat" feed element. */
  private readonly chatListEl: HTMLElement;
  /** The "Reasoning" feed element. */
  private readonly reasonListEl: HTMLElement;
  private readonly tabButtons: HTMLButtonElement[];

  /** id -> latest known chat log (normally just the single village chat). */
  private readonly byId = new Map<string, Conversation>();
  /** Live buffer of private deliberations, oldest first. */
  private readonly reasoning: ReasoningEntry[] = [];

  constructor(
    root: HTMLElement,
    private readonly options: ConversationsOptions,
  ) {
    root.classList.add('convos');
    root.innerHTML = `
      <header class="convos__head convos__tabs">
        <button class="convos__tab convos__tab--on" data-tab="chat">Village Chat</button>
        <button class="convos__tab" data-tab="reason">Reasoning</button>
      </header>
      <div class="convos__list chat" data-pane="chat"><div class="convos__empty">no chatter yet…</div></div>
      <div class="convos__list reason" data-pane="reason" hidden><div class="convos__empty">no reasoning yet…</div></div>`;
    this.chatListEl = root.querySelector('[data-pane="chat"]')!;
    this.reasonListEl = root.querySelector('[data-pane="reason"]')!;
    this.tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.convos__tab'));
    for (const btn of this.tabButtons) {
      btn.addEventListener('click', () => this.showTab(btn.dataset.tab === 'reason' ? 'reason' : 'chat'));
    }
    void this.seed();
  }

  /** Switch the visible feed, updating the active-tab highlight. */
  private showTab(tab: 'chat' | 'reason'): void {
    this.chatListEl.hidden = tab !== 'chat';
    this.reasonListEl.hidden = tab !== 'reason';
    for (const btn of this.tabButtons) {
      btn.classList.toggle('convos__tab--on', btn.dataset.tab === tab);
    }
    // Re-pin to the bottom of whichever feed just became visible (it couldn't scroll
    // while hidden, so a freshly-shown tab should land on its newest line).
    const el = tab === 'chat' ? this.chatListEl : this.reasonListEl;
    el.scrollTop = el.scrollHeight;
  }

  /** Pull the persisted chat once, on load. */
  private async seed(): Promise<void> {
    let existing: Conversation[] = [];
    try {
      existing = await this.options.onFetch();
    } catch {
      return; // leave the "no chatter yet" placeholder
    }
    for (const c of existing) this.byId.set(c.id, c);
    this.renderChat();
  }

  /** Apply one live chat update: replace by id and re-render the chat feed. */
  ingest(conversation: Conversation): void {
    this.byId.set(conversation.id, conversation);
    this.renderChat();
  }

  /**
   * Feed one villager thought. Only PRIVATE deliberations (the `reason` move) land
   * in the Reasoning tab; every other decision is ignored here (it shows on the map /
   * inspector). Speech reaches the chat tab via {@link ingest}, not this.
   */
  ingestThought(thought: VillagerThoughtMessage): void {
    if (thought.decision?.kind !== 'reason') return;
    this.reasoning.push({ tick: thought.tick, name: thought.villagerName, thought: thought.decision.thought });
    if (this.reasoning.length > MAX_REASONING) this.reasoning.shift();
    this.renderReasoning();
  }

  // -------------------------------------------------------------------------

  private renderChat(): void {
    // Merge every known log's lines into one time-ordered stream (there is normally
    // a single village chat, but this stays correct if more than one is ever sent).
    const messages = [...this.byId.values()]
      .flatMap((c) => c.messages)
      .sort((a, b) => a.at.localeCompare(b.at));

    if (messages.length === 0) {
      this.chatListEl.innerHTML = `<div class="convos__empty">no chatter yet…</div>`;
      return;
    }
    const pinned = this.isPinnedToBottom(this.chatListEl);
    this.chatListEl.replaceChildren(...messages.map((m) => this.chatLine(m)));
    if (pinned) this.chatListEl.scrollTop = this.chatListEl.scrollHeight;
  }

  private renderReasoning(): void {
    if (this.reasoning.length === 0) {
      this.reasonListEl.innerHTML = `<div class="convos__empty">no reasoning yet…</div>`;
      return;
    }
    const pinned = this.isPinnedToBottom(this.reasonListEl);
    this.reasonListEl.replaceChildren(...this.reasoning.map((e) => this.reasonLine(e)));
    if (pinned) this.reasonListEl.scrollTop = this.reasonListEl.scrollHeight;
  }

  /** True when the given feed is scrolled to (or very near) the bottom. */
  private isPinnedToBottom(el: HTMLElement): boolean {
    const slack = 24; // px of tolerance, so "close enough" still counts as following
    return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  }

  private chatLine(m: ConversationMessage): HTMLElement {
    const line = document.createElement('div');
    line.className = 'chat__line';
    // In-world stamp ("Day 3 · 14:25") from the tick the line was spoken on.
    line.innerHTML =
      `<span class="chat__time">${escapeHtml(formatSimClock(m.tick))}</span>` +
      `<span class="chat__who">${escapeHtml(shortName(m.speakerName))}</span>` +
      `<span class="chat__msg">${escapeHtml(m.message)}</span>`;
    return line;
  }

  private reasonLine(e: ReasoningEntry): HTMLElement {
    const line = document.createElement('div');
    line.className = 'chat__line reason__line';
    // Same in-world stamp + name as chat, but tagged [REASONING DATA] and tinted so
    // it never reads as something the villager said aloud.
    line.innerHTML =
      `<span class="chat__time">${escapeHtml(formatSimClock(e.tick))}</span>` +
      `<span class="reason__tag">[REASONING DATA]</span>` +
      `<span class="reason__who">${escapeHtml(shortName(e.name))}</span>` +
      `<span class="reason__msg">${escapeHtml(e.thought)}</span>`;
    return line;
  }
}

/** First word of a name, for a compact chat handle. */
function shortName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
