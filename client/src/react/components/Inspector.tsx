/**
 * client/src/react/components/Inspector.tsx
 * ---------------------------------------------------------------------------
 * The MAP INSPECTOR — shows live data for whatever the operator clicked on the
 * map (a villager or a building). The selection lives in the store (set by the
 * Renderer's click hooks); the live entity is read fresh from `net.getState()`
 * on a short poll, so needs/stock/position update as the world ticks.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useState } from 'react';
import type { Building, ResourceKind, Villager, VillagerNeeds } from '../../../../shared/types';
import { BACKPACK_CAPACITY } from '../../../../shared/types';
import { buildingMaxLife, isFortification, VILLAGER_MAX_LIFE } from '../../../../shared/fortifications';
import { useSelection, useStore } from '../NetworkProvider';
import { Empty, Meter, RESOURCE_ICON } from './ui';

const NEED_META: { key: keyof VillagerNeeds; label: string; icon: string }[] = [
  { key: 'hunger', label: 'Hunger', icon: '🍖' },
  { key: 'thirst', label: 'Thirst', icon: '💧' },
  { key: 'fatigue', label: 'Fatigue', icon: '😴' },
  { key: 'boredom', label: 'Boredom', icon: '🥱' },
];

/** A need bar: higher is WORSE, so it greens when low and reddens as it climbs. */
function NeedBar({ label, icon, value }: { label: string; icon: string; value: number }): React.JSX.Element {
  const tone = value >= 75 ? 'danger' : value >= 50 ? 'warn' : 'ok';
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-muted">
        {icon} {label}
      </span>
      <Meter value={value} tone={tone} className="flex-1" />
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-faint">{Math.round(value)}</span>
    </div>
  );
}

/** A labelled row of small facts. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-16 shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-words text-muted">{children}</span>
    </div>
  );
}

function VillagerView({ v }: { v: Villager }): React.JSX.Element {
  const backpack = v.backpack ?? [];
  const counts = backpack.reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
  const life = v.life ?? v.maxLife ?? VILLAGER_MAX_LIFE;
  const maxLife = v.maxLife ?? VILLAGER_MAX_LIFE;
  const hurt = v.life !== undefined && v.life < maxLife;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm ring-1 ring-black/40" style={{ background: v.color }}>
          🧍
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text">{v.name || v.id}</div>
          <div className="text-[11px] text-muted">{v.status}</div>
        </div>
        <div className="ml-auto flex flex-col items-end gap-0.5">
          {v.asleep && <span className="rounded bg-violet/15 px-1 text-[10px] text-violet">💤 asleep</span>}
          {v.downed && <span className="rounded bg-danger/15 px-1 text-[10px] text-danger">⚑ downed</span>}
        </div>
      </div>

      <div className="space-y-1.5 rounded-lg bg-card/40 p-2">
        {NEED_META.map((n) => (
          <NeedBar key={n.key} label={n.label} icon={n.icon} value={v.needs[n.key]} />
        ))}
      </div>

      {hurt && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11px] text-muted">❤️ Life</span>
          <Meter value={(life / maxLife) * 100} tone={life / maxLife < 0.34 ? 'danger' : 'ok'} className="flex-1" />
          <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-faint">
            {Math.round(life)}/{maxLife}
          </span>
        </div>
      )}

      <div className="space-y-1">
        <Field label="Backpack">
          {backpack.length === 0 ? (
            <span className="text-faint">empty</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {Object.entries(counts).map(([k, n]) => (
                <span key={k} className="rounded bg-card px-1">
                  {RESOURCE_ICON[k as ResourceKind] ?? '•'} {n}
                </span>
              ))}
              <span className="text-faint">
                {backpack.length}/{BACKPACK_CAPACITY}
              </span>
            </span>
          )}
        </Field>
        {v.task && <Field label="Task">{v.task.kind}</Field>}
        <Field label="Position">
          ({Math.round(v.position.x)}, {Math.round(v.position.y)})
        </Field>
        <Field label="Village">{v.villageId ?? 'village_0'}</Field>
      </div>
    </div>
  );
}

function BuildingView({ b }: { b: Building }): React.JSX.Element {
  const stock = Object.entries(b.stock) as [ResourceKind, number][];
  const fort = isFortification(b.kind);
  const maxLife = b.maxLife ?? buildingMaxLife(b.kind);
  const life = b.life ?? maxLife;
  const damaged = b.life !== undefined && b.life < maxLife;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm ring-1 ring-black/40" style={{ background: b.color }}>
          {fort ? '🛡' : '🏠'}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text">{b.name || b.id}</div>
          <div className="text-[11px] capitalize text-muted">{b.kind.replace(/_/g, ' ')}</div>
        </div>
      </div>

      <div className="rounded-lg bg-card/40 p-2 text-[11px] italic text-muted">{b.function}</div>

      {b.construction ? (
        <div className="space-y-1.5">
          <Field label="Building">{b.construction.targetName} — under construction</Field>
          {(Object.entries(b.construction.required) as [ResourceKind, number][]).map(([k, need]) => {
            const have = b.stock[k] ?? 0;
            return (
              <div key={k} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-muted">
                  {RESOURCE_ICON[k]} {k}
                </span>
                <Meter value={(have / need) * 100} tone="gold" className="flex-1" />
                <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-faint">
                  {have}/{need}
                </span>
              </div>
            );
          })}
        </div>
      ) : stock.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Stock</div>
          {stock.map(([k, n]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px] text-muted">
                {RESOURCE_ICON[k]} {k}
              </span>
              <Meter value={b.capacity > 0 ? (n / b.capacity) * 100 : 0} tone="teal" className="flex-1" />
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-faint">
                {n}
                {b.capacity > 0 && `/${b.capacity}`}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-faint">No resource economy.</div>
      )}

      {(damaged || fort) && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11px] text-muted">❤️ Life</span>
          <Meter value={(life / maxLife) * 100} tone={life / maxLife < 0.34 ? 'danger' : 'ok'} className="flex-1" />
          <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-faint">
            {Math.round(life)}/{maxLife}
          </span>
        </div>
      )}
      {b.kind === 'gate' && (
        <Field label="Gate">{b.open ? '🔓 open (passable)' : '🔒 held'}</Field>
      )}
      {b.siegeProgress !== undefined && b.siegeProgress > 0 && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11px] text-danger">⚔ Siege</span>
          <Meter value={b.siegeProgress * 100} tone="danger" className="flex-1" />
        </div>
      )}
      <Field label="Village">{b.villageId ?? 'village_0'}</Field>
    </div>
  );
}

export function Inspector(): React.JSX.Element {
  const selection = useSelection();
  const store = useStore();
  const [, tick] = useState(0);

  // Poll the live world view while something is selected, so the panel tracks ticks.
  useEffect(() => {
    if (!selection) return;
    const h = setInterval(() => tick((n) => n + 1), 400);
    return () => clearInterval(h);
  }, [selection]);

  if (!selection) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-xs text-faint">
        Click a villager or building on the map to inspect it.
      </div>
    );
  }

  const { villager, building } = store.inspected();
  return (
    <div className="h-full overflow-y-auto p-2.5 text-xs">
      {villager ? (
        <VillagerView v={villager} />
      ) : building ? (
        <BuildingView b={building} />
      ) : (
        <Empty>That entity is no longer here.</Empty>
      )}
    </div>
  );
}
