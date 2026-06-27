/**
 * client/src/react/components/SupervisorConsole.tsx
 * ---------------------------------------------------------------------------
 * The N-village GOD / SUPERVISOR console — the operator's seat at every temple
 * altar at once. A standings strip at the top doubles as the village SELECTOR
 * (synced with the topbar); below it, the focused village's prayers, divine acts,
 * raid alerts, and divine powers. Every petition and act is attributed to its
 * village via the wire's `villageId`, and verdicts / force-run / pause route to
 * that village's god (v3 rival seam).
 * ---------------------------------------------------------------------------
 */

import { useMemo, useState } from 'react';
import type { WeatherKind } from '../../../../shared/types';
import { VILLAGE_SCORE_PILLARS } from '../../../../shared/types';
import { useEnv, useNet, useVillages, useVillagerOptions } from '../NetworkProvider';
import { useActiveVillage } from '../activeVillage';
import { cx, Empty, Meter, RESOURCE_ICON } from './ui';
import type { VillageVM } from '../villageModel';
import type { ResourceKind } from '../../../../shared/types';

type Verdict = 'granted' | 'dismissed' | 'passed';

const WEATHER_CHOICES: { kind: WeatherKind; icon: string; label: string }[] = [
  { kind: 'clear', icon: '☀️', label: 'Clear' },
  { kind: 'rain', icon: '🌧️', label: 'Rain' },
  { kind: 'storm', icon: '⛈️', label: 'Storm' },
  { kind: 'fog', icon: '🌫️', label: 'Fog' },
];

/** A selectable standings card per village — the rival scoreboard + the selector. */
function StandingCard({
  v,
  active,
  onClick,
}: {
  v: VillageVM;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const accent = v.palette?.groundAccent ?? '#6ea8ff';
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex flex-1 flex-col gap-1 rounded-lg border p-2 text-left transition-colors',
        active ? 'border-accent/60 bg-accent/10' : 'border-soft bg-card/50 hover:bg-card-hover',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full ring-1 ring-black/40" style={{ background: accent }} />
        <span className="flex items-center gap-1 truncate text-xs font-semibold text-text">
          {v.isLeader && '👑'} {v.name}
        </span>
        {v.score !== null && <span className="ml-auto text-sm font-bold tabular-nums text-text">{v.score}</span>}
      </div>
      {v.score !== null && <Meter value={v.score} tone={v.isLeader ? 'gold' : 'accent'} />}
      {v.pillars && (
        <div className="flex gap-1 text-[10px] text-muted">
          {VILLAGE_SCORE_PILLARS.map((p) => (
            <span key={p} className="rounded bg-black/25 px-1">
              {p[0]!.toUpperCase()} {v.pillars![p]}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function ResourceRow({ resources }: { resources: Partial<Record<ResourceKind, number>> }): React.JSX.Element | null {
  const entries = Object.entries(resources) as [ResourceKind, number][];
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px] text-muted">
      {entries.map(([k, n]) => (
        <span key={k} className="inline-flex items-center gap-0.5 rounded bg-card px-1.5 py-0.5" title={k}>
          {RESOURCE_ICON[k]} {n}
        </span>
      ))}
    </div>
  );
}

export function SupervisorConsole(): React.JSX.Element {
  const villages = useVillages();
  const env = useEnv();
  const net = useNet();
  const allOptions = useVillagerOptions();
  const { activeId, setActiveId } = useActiveVillage();

  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [pausedVillages, setPausedVillages] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>('');

  const active = useMemo(() => villages.find((v) => v.id === activeId) ?? villages[0] ?? null, [villages, activeId]);
  const options = useMemo(
    () => (active ? allOptions.filter((o) => o.villageId === active.id) : allOptions),
    [allOptions, active],
  );

  if (!active) {
    return (
      <div className="grid h-full place-items-center p-4 text-xs text-faint">
        Awaiting the world — no villages yet.
      </div>
    );
  }

  const grant = (prayerId: string): void => {
    const prayer = active.prayers.find((p) => p.id === prayerId);
    if (!prayer) return;
    net.sendVerdict(prayer, 'choose');
    setVerdicts((prev) => {
      const next = { ...prev, [prayerId]: 'granted' as Verdict };
      // Only one prayer may be heard: every other unresolved prayer of this village passes.
      for (const p of active.prayers) {
        if (p.id !== prayerId && !next[p.id]) next[p.id] = 'passed';
      }
      return next;
    });
  };
  const dismiss = (prayerId: string): void => {
    const prayer = active.prayers.find((p) => p.id === prayerId);
    if (!prayer) return;
    net.sendVerdict(prayer, 'reject');
    setVerdicts((prev) => ({ ...prev, [prayerId]: 'dismissed' }));
  };
  const togglePause = (): void => {
    const paused = !pausedVillages.has(active.id);
    net.pauseSupervisor(paused, active.id);
    setPausedVillages((prev) => {
      const next = new Set(prev);
      if (paused) next.add(active.id);
      else next.delete(active.id);
      return next;
    });
  };
  const blessSmite = (fn: (id: string) => void): void => {
    const id = target || options[0]?.id;
    if (id) fn(id);
  };

  const pending = active.prayers.filter((p) => !verdicts[p.id]);
  const isPaused = pausedVillages.has(active.id);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2 text-xs">
      {/* Standings strip / village selector */}
      <div className="flex flex-wrap gap-1.5">
        {villages.map((v) => (
          <StandingCard key={v.id} v={v} active={v.id === active.id} onClick={() => setActiveId(v.id)} />
        ))}
      </div>

      {/* Focused village header */}
      <div className="flex items-center gap-2 rounded-lg bg-card/60 px-2 py-1.5">
        <span className="text-sm font-semibold text-text">⛪ {active.name}</span>
        <span className="text-faint">· {active.population} faithful</span>
        <div className="ml-auto flex gap-1">
          <button
            onClick={() => net.forceRun(active.id)}
            title="Force this god to weigh its pending prayers now"
            className="rounded-md border border-soft bg-card px-2 py-1 text-muted hover:text-text"
          >
            ⚡ Force Run
          </button>
          <button
            onClick={togglePause}
            title="Pause this autonomous god so you drive; click to resume"
            className={cx(
              'rounded-md border px-2 py-1',
              isPaused ? 'border-warn/60 bg-warn/15 text-warn' : 'border-soft bg-card text-muted hover:text-text',
            )}
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </div>

      <ResourceRow resources={active.resources} />

      {/* Divine powers */}
      <div className="space-y-1.5 rounded-lg border border-soft bg-card/30 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Divine powers</div>
        <div className="flex flex-wrap gap-1">
          {WEATHER_CHOICES.map((wc) => (
            <button
              key={wc.kind}
              onClick={() => net.setWeather(wc.kind)}
              className={cx(
                'rounded-md border px-2 py-1',
                env.weather === wc.kind ? 'border-accent/60 bg-accent/15 text-text' : 'border-soft bg-card text-muted hover:text-text',
              )}
            >
              {wc.icon} {wc.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-soft bg-surface-2 px-2 py-1 text-text"
          >
            {options.length === 0 ? (
              <option value="">(no villagers)</option>
            ) : (
              options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))
            )}
          </select>
          <button onClick={() => blessSmite((id) => net.bless(id))} className="rounded-md border border-soft bg-card px-2 py-1 text-ok hover:bg-card-hover">
            ✨ Bless
          </button>
          <button onClick={() => blessSmite((id) => net.smite(id))} className="rounded-md border border-soft bg-card px-2 py-1 text-danger hover:bg-card-hover">
            ⚡ Smite
          </button>
        </div>
        <div className="flex gap-1">
          <button onClick={() => net.spawn('villager')} className="rounded-md border border-soft bg-card px-2 py-1 text-muted hover:text-text">
            🧍 Spawn villager
          </button>
          <button onClick={() => net.spawn('tree')} className="rounded-md border border-soft bg-card px-2 py-1 text-muted hover:text-text">
            🌳 Spawn tree
          </button>
        </div>
      </div>

      {/* Alerts */}
      {active.alerts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Alerts</div>
          {active.alerts.slice(0, 6).map((a) => (
            <div
              key={a.id}
              className={cx(
                'flex items-center gap-2 rounded-md px-2 py-1',
                a.event.salience === 'crisis' ? 'bg-danger/10 text-danger' : a.event.salience === 'warning' ? 'bg-warn/10 text-warn' : 'bg-card/50 text-muted',
              )}
            >
              <span>{a.event.kind === 'raid' ? '⚔️' : a.event.salience === 'crisis' ? '🔥' : '•'}</span>
              <span className="truncate">{a.event.text}</span>
              <span className="ml-auto shrink-0 text-faint">t{a.event.tick}</span>
            </div>
          ))}
        </div>
      )}

      {/* Prayers */}
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Prayers</div>
        <span className="text-faint">· {pending.length} awaiting judgement</span>
      </div>
      <div className="space-y-1.5">
        {active.prayers.length === 0 ? (
          <Empty>No prayers yet — the faithful are quiet.</Empty>
        ) : (
          active.prayers.map((p) => {
            const verdict = verdicts[p.id];
            return (
              <div
                key={p.id}
                className={cx(
                  'rounded-lg border p-2',
                  verdict === 'granted' ? 'border-ok/40 bg-ok/5' : verdict ? 'border-soft bg-card/20 opacity-60' : 'border-soft bg-card/50',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-text">{p.villagerName}</span>
                  <span className="ml-auto text-faint">t{p.tick}</span>
                </div>
                <div className="mt-0.5 italic text-muted">“{p.message}”</div>
                {verdict ? (
                  <div className="mt-1 text-[11px] text-faint">
                    {verdict === 'granted' ? '🙏 granted — the god answers this one' : verdict === 'dismissed' ? '✕ dismissed' : '— the god chose another prayer'}
                  </div>
                ) : (
                  <div className="mt-1.5 flex gap-1">
                    <button onClick={() => grant(p.id)} className="rounded-md border border-ok/40 bg-ok/10 px-2 py-0.5 text-ok hover:bg-ok/20">
                      🙏 Grant
                    </button>
                    <button onClick={() => dismiss(p.id)} className="rounded-md border border-soft bg-card px-2 py-0.5 text-muted hover:text-text">
                      ✕ Dismiss
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Divine acts */}
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Divine acts</div>
      <div className="space-y-1">
        {active.actions.length === 0 ? (
          <Empty>The god has not yet acted.</Empty>
        ) : (
          active.actions.slice(0, 12).map((a, i) => (
            <div key={i} className="flex items-baseline gap-2 rounded bg-card/40 px-2 py-1">
              <span className="shrink-0 rounded bg-violet/15 px-1 text-[10px] text-violet">{a.action}</span>
              <span className="text-muted">{a.summary}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
