/**
 * client/src/react/components/Topbar.tsx
 * ---------------------------------------------------------------------------
 * The top app bar — brand, the N-village SWITCHER + live standings (the rival
 * scoreboard), the derived environment HUD (season · weather · temperature ·
 * clock), and the connection state. The switcher drives the shared active-village
 * selection the god console reads.
 * ---------------------------------------------------------------------------
 */

import { useConnection, useEnv, useVillages } from '../NetworkProvider';
import { useActiveVillage } from '../activeVillage';
import { simTimeFromTick, formatSimTimeOfDay } from '../../../../shared/simClock';
import { seasonFromTick, temperatureFromTick } from '../../../../shared/climate';
import { cx, PART_FACE, SEASON_FACE, WEATHER_FACE, tempEmoji } from './ui';
import type { VillageVM } from '../villageModel';

function VillageTab({
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
      title={`${v.name} — ${v.population} villagers${v.score !== null ? ` · score ${v.score}` : ''}`}
      className={cx(
        'group flex items-center gap-2 rounded-lg border px-2.5 py-1 text-left transition-colors',
        active ? 'border-accent/60 bg-accent/10' : 'border-soft bg-card/60 hover:bg-card-hover',
      )}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/40" style={{ background: accent }} />
      <span className="flex flex-col leading-tight">
        <span className="flex items-center gap-1 text-xs font-semibold text-text">
          {v.isLeader && <span title="Leading">👑</span>}
          <span className="max-w-[9rem] truncate">{v.name}</span>
        </span>
        <span className="text-[10px] text-muted">
          🧍 {v.population}
          {v.fortCount > 0 && <> · 🛡 {v.fortCount}</>}
        </span>
      </span>
      {v.score !== null && (
        <span className="ml-1 rounded-md bg-black/30 px-1.5 py-0.5 text-xs font-bold tabular-nums text-text">
          {v.score}
        </span>
      )}
    </button>
  );
}

export function Topbar({ onResetLayout }: { onResetLayout: () => void }): React.JSX.Element {
  const env = useEnv();
  const villages = useVillages();
  const connected = useConnection();
  const { activeId, setActiveId } = useActiveVillage();

  const t = simTimeFromTick(env.tick);
  const season = seasonFromTick(env.tick);
  const temp = temperatureFromTick(env.tick, env.weather);
  const s = SEASON_FACE[season];
  const w = WEATHER_FACE[env.weather];

  return (
    <header className="fixed inset-x-0 top-0 z-[9999] flex h-[52px] items-center gap-3 border-b border-soft bg-glass-strong px-3 backdrop-blur-md">
      {/* Brand */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-violet text-sm shadow">
          🏘
        </span>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-bold tracking-tight text-text">
            simVillage <span className="text-[10px] font-normal text-faint">v{__APP_VERSION__}</span>
          </span>
          {env.theme ? (
            <span className="max-w-[12rem] truncate text-[10px] text-muted" title={env.setting || env.theme}>
              🏷 {env.theme}
            </span>
          ) : (
            <span className="text-[10px] text-faint">rival worlds</span>
          )}
        </div>
      </div>

      <div className="mx-1 h-7 w-px bg-soft" />

      {/* Village switcher / standings */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {villages.length === 0 ? (
          <span className="text-xs text-faint">awaiting the world…</span>
        ) : (
          villages.map((v, i) => (
            <div key={v.id} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-faint">{villages.length === 2 ? '⚔' : '·'}</span>}
              <VillageTab v={v} active={v.id === activeId} onClick={() => setActiveId(v.id)} />
            </div>
          ))
        )}
      </div>

      {/* Environment HUD */}
      <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
        <span className="hidden items-center gap-1 rounded-md bg-card px-2 py-1 sm:inline-flex" title={`Season — day ${t.day}`}>
          {s.emoji} {s.label}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-card px-2 py-1" title="Current weather">
          {w.emoji} {w.label}
        </span>
        <span className="hidden items-center gap-1 rounded-md bg-card px-2 py-1 md:inline-flex" title="Temperature">
          {tempEmoji(temp)} {temp}°C
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-card px-2 py-1 font-medium text-text">
          {PART_FACE[t.partOfDay]} Day {t.day} · {formatSimTimeOfDay(env.tick)}
        </span>
      </div>

      <div className="mx-0.5 h-7 w-px bg-soft" />

      {/* Controls + connection */}
      <button
        onClick={onResetLayout}
        title="Reset all windows to their default positions"
        className="shrink-0 rounded-md border border-soft bg-card px-2 py-1 text-xs text-muted transition-colors hover:text-text"
      >
        ⟲ Layout
      </button>
      <span
        className={cx(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs',
          connected ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger',
        )}
      >
        <span className={cx('h-2 w-2 rounded-full', connected ? 'bg-ok' : 'bg-danger', !connected && 'animate-pulse')} />
        {connected ? 'live' : 'reconnecting'}
      </span>
    </header>
  );
}
