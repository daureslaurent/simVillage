/**
 * client/src/LiveLlmPanel.ts
 * ---------------------------------------------------------------------------
 * The "Live LLM" window — a real-time look INSIDE the model as it decides.
 *
 * Where the LLM-engine debug window answers "what is running and how long", this
 * one answers "what is the model actually SAYING, token by token". It has two
 * stacked regions:
 *
 *   - LIVE (top): one block per in-flight `/decide` call, each streaming the
 *     model's reasoning and visible output as the tokens arrive. The reasoning
 *     ("think") is split out from the answer — both from `<think>…</think>` tags
 *     in the text and from a model's separately-streamed reasoning channel — so
 *     you watch it deliberate, then commit to a tool.
 *   - HISTORY (below): when a call finishes it collapses into a CARD capturing
 *     the four things that mattered — Input · Think · Output · Tool. The newest
 *     card sits on top; only the last {@link MAX_HISTORY} are kept.
 *
 * It is fed off the same WebSocket telemetry as the debug window, plus the new
 * `engine.llm.delta` stream that carries the per-token slices; no polling.
 * ---------------------------------------------------------------------------
 */

import type {
  LlmCallPurpose,
  LlmCallStartedMessage,
  LlmCallDeltaMessage,
  LlmCallFinishedMessage,
} from '../../shared/types';
import { escapeHtml } from './modal';
import { splitThink, joinThink } from './llmThink';

/** How many finished cards to keep before the oldest drops off. */
const MAX_HISTORY = 10;
/** Elapsed beyond these (ms) tints a running call's timer amber, then red. */
const SLOW_MS = 15_000;
const VERY_SLOW_MS = 60_000;

/** Which purposes this window follows — only the streaming `/decide` family. */
const STREAMED: ReadonlyArray<LlmCallPurpose> = ['decide', 'supervisor'];

/** One in-flight, streaming decision being accumulated for the live region. */
interface LiveCall {
  id: number;
  agent: string;
  purpose: LlmCallPurpose;
  label: string;
  /** The request preview captured at start — the "Input" of the eventual card. */
  input: string;
  startedAt: number;
  /** All visible-output text so far (may contain `<think>` tags). */
  content: string;
  /** Reasoning streamed on the separate channel (no tags), if any. */
  reasoning: string;
}

/** A finished call distilled into the four sections a card shows. */
interface HistoryCard {
  id: number;
  agent: string;
  purpose: LlmCallPurpose;
  label: string;
  ok: boolean;
  durationMs: number;
  input: string;
  think: string;
  output: string;
  /** The chosen tool call (the finish preview), or the error text when it failed. */
  tool: string;
  error?: string;
}

export class LiveLlmPanel {
  private readonly liveEl: HTMLElement;
  private readonly historyEl: HTMLElement;
  private readonly tallyEl: HTMLElement;

  /** In-flight streams, keyed by call id, in arrival order. */
  private readonly live = new Map<number, LiveCall>();
  /** Finished cards, newest first, capped at {@link MAX_HISTORY}. */
  private readonly history: HistoryCard[] = [];
  private finishedCount = 0;

  constructor(root: HTMLElement) {
    root.classList.add('livellm');
    root.innerHTML = `
      <header class="livellm__head">
        <span class="livellm__title">Live LLM</span>
        <span class="livellm__tally"></span>
      </header>
      <div class="livellm__live"></div>
      <div class="livellm__hsep">History</div>
      <div class="livellm__history"></div>`;
    this.liveEl = root.querySelector('.livellm__live')!;
    this.historyEl = root.querySelector('.livellm__history')!;
    this.tallyEl = root.querySelector('.livellm__tally')!;

    // One ticker drives the elapsed timers AND flushes any tokens that arrived
    // since the last paint — cheap, and smooth enough to read a stream by.
    setInterval(() => {
      if (this.live.size > 0) this.renderLive();
    }, 200);

    this.renderLive();
    this.renderHistory();
    this.renderTally();
  }

  /** A round-trip started. Only the streaming `/decide` family opens a live block. */
  ingestStart(call: LlmCallStartedMessage): void {
    if (!STREAMED.includes(call.purpose)) return;
    this.live.set(call.id, {
      id: call.id,
      agent: call.agent,
      purpose: call.purpose,
      label: call.label,
      input: call.request,
      startedAt: call.startedAt,
      content: '',
      reasoning: '',
    });
    this.renderLive();
    this.renderTally();
  }

  /** A streamed slice of an in-flight call — append it to that call's buffers. */
  ingestDelta(call: LlmCallDeltaMessage): void {
    const live = this.live.get(call.id);
    if (!live) return;
    if (call.content) live.content += call.content;
    if (call.reasoning) live.reasoning += call.reasoning;
    // Painted by the 200ms ticker; no immediate re-render so a token burst can't
    // thrash layout.
  }

  /** The matching round-trip finished — land it as a history card. */
  ingestFinish(call: LlmCallFinishedMessage): void {
    const live = this.live.get(call.id);
    if (!live && !STREAMED.includes(call.purpose)) return;
    this.live.delete(call.id);
    this.finishedCount++;

    const { think: tagThink, output } = splitThink(live?.content ?? '');
    const think = joinThink(live?.reasoning ?? '', tagThink);
    this.history.unshift({
      id: call.id,
      agent: live?.agent ?? 'unknown',
      purpose: live?.purpose ?? call.purpose,
      label: live?.label ?? call.label,
      ok: call.ok,
      durationMs: call.durationMs,
      input: live?.input ?? '',
      think,
      output: output || (call.ok ? call.response : ''),
      tool: call.ok ? call.response || '(no tool call)' : '',
      ...(call.ok ? {} : { error: call.error || 'failed' }),
    });
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;

    this.renderLive();
    this.renderHistory();
    this.renderTally();
  }

  // -------------------------------------------------------------------------

  private renderTally(): void {
    const live = this.live.size;
    this.tallyEl.innerHTML =
      `<b class="livellm__count${live ? ' livellm__count--on' : ''}">${live} streaming</b>` +
      `  ·  <span class="livellm__done">${this.finishedCount} done</span>`;
  }

  private renderLive(): void {
    const calls = [...this.live.values()].sort((a, b) => a.startedAt - b.startedAt);
    if (calls.length === 0) {
      this.liveEl.innerHTML = '<div class="livellm__idle">idle — no calls streaming</div>';
      return;
    }
    const now = Date.now();
    this.liveEl.innerHTML = calls
      .map((c) => {
        const ms = now - c.startedAt;
        const sev = ms >= VERY_SLOW_MS ? ' livellm__elapsed--vslow' : ms >= SLOW_MS ? ' livellm__elapsed--slow' : '';
        const { think: tagThink, output } = splitThink(c.content);
        const think = joinThink(c.reasoning, tagThink);
        const thinkBlock = think
          ? `<div class="livellm__think"><span class="livellm__think-h">thinking</span>${escapeHtml(think)}</div>`
          : '';
        const out = output
          ? `${escapeHtml(output)}<span class="livellm__caret"></span>`
          : `<span class="livellm__waiting">…</span>`;
        return `
          <div class="livellm__stream">
            <div class="livellm__stream-head">
              <span class="livellm__spin"></span>
              <span class="livellm__agent" title="${escapeHtml(c.agent)}">${escapeHtml(c.agent)}</span>
              <span class="llm__label llm__label--${c.purpose}">${escapeHtml(c.label)}</span>
              <span class="livellm__elapsed${sev}">${fmtMs(ms)}</span>
            </div>
            ${thinkBlock}
            <div class="livellm__out">${out}</div>
          </div>`;
      })
      .join('');
    // Keep each growing stream pinned to its newest tokens.
    for (const el of this.liveEl.querySelectorAll<HTMLElement>('.livellm__think, .livellm__out')) {
      el.scrollTop = el.scrollHeight;
    }
  }

  private renderHistory(): void {
    if (this.history.length === 0) {
      this.historyEl.innerHTML = '<div class="livellm__empty">no finished calls yet</div>';
      return;
    }
    this.historyEl.innerHTML = this.history
      .map((c) => {
        const sec = (label: string, body: string, mod = ''): string =>
          body
            ? `<div class="livellm__sec${mod}"><span class="livellm__sec-h">${label}</span><div class="livellm__sec-b">${escapeHtml(body)}</div></div>`
            : '';
        const toolBit = c.ok
          ? `<span class="livellm__tool" title="${escapeHtml(c.tool)}">${escapeHtml(c.tool)}</span>`
          : `<span class="livellm__tool livellm__tool--err" title="${escapeHtml(c.error ?? '')}">✕ ${escapeHtml(c.error ?? 'failed')}</span>`;
        return `
          <details class="livellm__card${c.ok ? '' : ' livellm__card--err'}">
            <summary>
              <span class="livellm__dot${c.ok ? '' : ' livellm__dot--err'}"></span>
              <span class="livellm__agent" title="${escapeHtml(c.agent)}">${escapeHtml(c.agent)}</span>
              <span class="llm__label llm__label--${c.purpose}">${escapeHtml(c.label)}</span>
              ${toolBit}
              <span class="livellm__dur">${fmtMs(c.durationMs)}</span>
            </summary>
            <div class="livellm__card-body">
              ${sec('Input', c.input)}
              ${sec('Think', c.think, ' livellm__sec--think')}
              ${sec('Output', c.output)}
              ${c.ok ? sec('Tool', c.tool, ' livellm__sec--tool') : sec('Error', c.error ?? '', ' livellm__sec--errtext')}
            </div>
          </details>`;
      })
      .join('');
  }
}

/** Compact ms -> "820ms" / "12.4s". */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
