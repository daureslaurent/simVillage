/**
 * client/src/react/components/EngineTelemetry.tsx
 * ---------------------------------------------------------------------------
 * The LLM-engine telemetry window: what's running on the shared engine now, the
 * latency/result of recent round-trips, a per-purpose filter, the endpoint pool,
 * and cumulative token usage. Fed off the {@link useEngine} slice; the only live
 * timer is a local 250ms tick that refreshes the running rows' elapsed counters.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo, useState } from 'react';
import type { LlmCallPurpose, ReasoningEffort } from '../../../../shared/types';
import { REASONING_EFFORT_LABELS } from '../../../../shared/types';
import { useEngine } from '../NetworkProvider';
import { cx, fmtMs, fmtTok, shortHost, Empty } from './ui';

const SLOW_MS = 15_000;
const VERY_SLOW_MS = 60_000;

const PURPOSES: ReadonlyArray<{ key: LlmCallPurpose; label: string; dot: string }> = [
  { key: 'decide', label: 'Decide', dot: 'bg-accent' },
  { key: 'supervisor', label: 'Supervisor', dot: 'bg-violet' },
  { key: 'reflect', label: 'Reflect', dot: 'bg-teal' },
  { key: 'plan', label: 'Plan', dot: 'bg-gold' },
  { key: 'embed', label: 'Embed', dot: 'bg-muted' },
];

function EffortPill({ level }: { level: ReasoningEffort | null | undefined }): React.JSX.Element | null {
  if (!level) return null;
  const tone =
    level === 'high' ? 'bg-danger/15 text-danger' : level === 'medium' ? 'bg-warn/15 text-warn' : 'bg-ok/15 text-ok';
  return <span className={cx('rounded px-1 text-[10px] uppercase', tone)}>{REASONING_EFFORT_LABELS[level]}</span>;
}

export function EngineTelemetry(): React.JSX.Element {
  const engine = useEngine();
  const [filters, setFilters] = useState<Set<LlmCallPurpose>>(new Set(PURPOSES.map((p) => p.key)));
  const [, forceTick] = useState(0);

  // Live-refresh the running rows' elapsed timers.
  useEffect(() => {
    if (engine.running.length === 0) return;
    const h = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(h);
  }, [engine.running.length]);

  const toggle = (k: LlmCallPurpose): void => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next.size === 0 ? new Set(PURPOSES.map((p) => p.key)) : next;
    });
  };

  const now = Date.now();
  const running = useMemo(
    () => engine.running.filter((c) => filters.has(c.purpose)).sort((a, b) => a.startedAt - b.startedAt),
    [engine.running, filters],
  );
  const recent = useMemo(() => engine.recent.filter((c) => filters.has(c.purpose)), [engine.recent, filters]);
  const { tally } = engine;

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-2 text-xs">
      {/* Tally */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <b className={cx('flex items-center gap-1', tally.live > 0 ? 'text-accent' : 'text-muted')}>
          <span className={cx('h-2 w-2 rounded-full', tally.live > 0 ? 'animate-pulse bg-accent' : 'bg-faint')} />
          {tally.live} running
        </b>
        <span className="text-ok">{tally.ok} ok</span>
        <span className="text-danger">{tally.err} err</span>
        <span className="text-muted" title="Average duration of finished calls">
          avg {tally.avgMs > 0 ? fmtMs(tally.avgMs) : '–'}
        </span>
        <span className="ml-auto text-faint" title="Cumulative tokens across calls that reported usage">
          in <b className="text-muted">{fmtTok(tally.tokIn)}</b> · out <b className="text-muted">{fmtTok(tally.tokOut)}</b>
          {tally.tokThink > 0 && (
            <>
              {' '}
              · think <b className="text-muted">{fmtTok(tally.tokThink)}</b>
            </>
          )}
        </span>
      </div>

      {/* Pool */}
      <div className="flex flex-wrap items-center gap-1 border-y border-soft py-1.5">
        {!engine.pool || engine.pool.endpoints.length === 0 ? (
          <span className="text-faint">pool: —</span>
        ) : (
          <>
            <span className="text-muted" title="How many minds can think at once (= endpoints)">
              pool ×{engine.pool.capacity}
            </span>
            {engine.pool.endpoints.map((e) => (
              <span
                key={e.baseUrl}
                title={`${e.baseUrl} — ${e.busy ? 'busy' : 'idle'}\n${e.models.join(', ') || 'no models'}`}
                className={cx(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5',
                  e.busy ? 'border-accent/50 bg-accent/10 text-text' : 'border-soft text-faint',
                )}
              >
                <span className={cx('h-1.5 w-1.5 rounded-full', e.busy ? 'animate-pulse bg-accent' : 'bg-faint')} />
                {shortHost(e.baseUrl)} ·{e.models.length}m
              </span>
            ))}
          </>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-1">
        {PURPOSES.map((p) => {
          const stat = engine.stats[p.key];
          const on = filters.has(p.key);
          const avg = stat && stat.count > 0 ? fmtMs(Math.round(stat.totalMs / stat.count)) : '–';
          return (
            <button
              key={p.key}
              onClick={() => toggle(p.key)}
              title={`${p.label} — ${stat?.count ?? 0} calls, avg ${avg}${stat && stat.err > 0 ? ` · ${stat.err} err` : ''}`}
              className={cx(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5',
                on ? 'border-soft bg-card text-text' : 'border-transparent text-faint opacity-50',
              )}
            >
              <span className={cx('h-1.5 w-1.5 rounded-full', p.dot)} />
              {p.label}
              <span className="tabular-nums text-muted">{stat?.count ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Running */}
      <div className="shrink-0 space-y-1">
        {running.length === 0 ? (
          <div className="text-faint">{engine.running.length === 0 ? 'idle — no calls in flight' : 'none match filter'}</div>
        ) : (
          running.map((c) => {
            const ms = now - c.startedAt;
            const sev = ms >= VERY_SLOW_MS ? 'text-danger' : ms >= SLOW_MS ? 'text-warn' : 'text-text';
            return (
              <div key={c.id} className="flex items-center gap-2 rounded bg-card/50 px-1.5 py-1">
                <span className="animate-pulse text-accent">●</span>
                <span className="truncate text-muted" title={c.agent}>
                  {c.agent}
                </span>
                <span className="truncate text-faint">{c.label}</span>
                <span className={cx('ml-auto tabular-nums', sev)}>{fmtMs(ms)}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Recent log */}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-soft pt-1.5">
        {recent.length === 0 ? (
          <Empty>{engine.recent.length === 0 ? 'no calls yet' : 'none match filter'}</Empty>
        ) : (
          recent.map((c, i) => {
            const sev = c.durationMs >= VERY_SLOW_MS ? 'text-danger' : c.durationMs >= SLOW_MS ? 'text-warn' : 'text-muted';
            const think = c.usage?.thinkTokens ?? c.thinkTokensEst;
            return (
              <details key={`${c.id}:${i}`} className={cx('rounded bg-card/40 px-1.5 py-1', !c.ok && 'bg-danger/5')}>
                <summary className="flex cursor-pointer list-none items-center gap-2">
                  <span className={cx('h-1.5 w-1.5 rounded-full', c.ok ? 'bg-ok' : 'bg-danger')} />
                  <span className="truncate text-muted" title={c.agent}>
                    {c.agent}
                  </span>
                  <span className="truncate text-faint">{c.label}</span>
                  <EffortPill level={c.effort} />
                  <span className="ml-auto flex items-center gap-1">
                    {c.toolCount !== undefined && c.toolCount > 0 && (
                      <span className="text-faint" title={`${c.toolCount} tool calls`}>
                        🔧{c.toolCount}
                      </span>
                    )}
                    {think !== undefined && think > 0 && (
                      <span className="text-faint" title="reasoning tokens">
                        🧠{fmtTok(think)}
                      </span>
                    )}
                    <span className={cx('tabular-nums', sev)}>{fmtMs(c.durationMs)}</span>
                  </span>
                </summary>
                {c.request && <div className="mt-1 break-words text-faint">← {c.request}</div>}
                {c.ok ? (
                  <div className="mt-0.5 break-words text-muted">→ {c.response || '(empty)'}</div>
                ) : (
                  <div className="mt-0.5 break-words text-danger">
                    ✕{c.status !== undefined ? ` ${c.status}` : ''} {c.error || 'failed'}
                  </div>
                )}
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}
