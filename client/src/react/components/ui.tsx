/**
 * client/src/react/components/ui.tsx
 * ---------------------------------------------------------------------------
 * Small shared UI atoms + formatting helpers for the React HUD. Styling is
 * Tailwind utilities over the dusk-theme tokens declared in client/src/index.css
 * (bg-glass, text-muted, border-soft, the accent colours).
 * ---------------------------------------------------------------------------
 */

import type { ReactNode } from 'react';
import type { ResourceKind, WeatherKind } from '../../../../shared/types';
import type { Season } from '../../../../shared/climate';
import type { PartOfDay } from '../../../../shared/simClock';

/** Join class names, dropping falsy ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Compact ms → "820ms" / "12.4s". */
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact token count → "934" / "12.3k" / "4.1M". */
export function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** host:port without scheme, for endpoint chips. */
export function shortHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export const SEASON_FACE: Record<Season, { emoji: string; label: string }> = {
  spring: { emoji: '🌸', label: 'Spring' },
  summer: { emoji: '☀️', label: 'Summer' },
  autumn: { emoji: '🍂', label: 'Autumn' },
  winter: { emoji: '❄️', label: 'Winter' },
};

export const WEATHER_FACE: Record<WeatherKind, { emoji: string; label: string }> = {
  clear: { emoji: '🌤️', label: 'Clear' },
  rain: { emoji: '🌧️', label: 'Rain' },
  storm: { emoji: '⛈️', label: 'Storm' },
  fog: { emoji: '🌫️', label: 'Fog' },
  heatwave: { emoji: '🥵', label: 'Heatwave' },
};

export const PART_FACE: Record<PartOfDay, string> = {
  morning: '🌅',
  afternoon: '🏙️',
  evening: '🌇',
  night: '🌙',
};

export const RESOURCE_ICON: Record<ResourceKind, string> = {
  water: '💧',
  food: '🌾',
  wood: '🪵',
  goods: '📦',
  stone: '🪨',
};

/** Tint a temperature chip cold → hot. */
export function tempEmoji(celsius: number): string {
  if (celsius <= 4) return '🥶';
  if (celsius <= 30) return '🌡️';
  return '🔥';
}

/** A labelled 0..100 meter bar, tinted by `tone`. */
export function Meter({
  value,
  tone = 'accent',
  className,
}: {
  value: number;
  tone?: 'accent' | 'ok' | 'warn' | 'danger' | 'violet' | 'gold' | 'teal';
  className?: string;
}): React.JSX.Element {
  const bg: Record<string, string> = {
    accent: 'bg-accent',
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    violet: 'bg-violet',
    gold: 'bg-gold',
    teal: 'bg-teal',
  };
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-black/30', className)}>
      <div
        className={cx('h-full rounded-full transition-[width] duration-500', bg[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/** A small rounded chip. */
export function Chip({
  children,
  title,
  className,
  onClick,
  active,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
  onClick?: () => void;
  active?: boolean;
}): React.JSX.Element {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      title={title}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        onClick && 'cursor-pointer transition-colors',
        active
          ? 'border-accent/60 bg-accent/15 text-text'
          : 'border-soft bg-card text-muted hover:text-text',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** An empty-state line for a panel section. */
export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-1 py-3 text-center text-xs text-faint">{children}</div>;
}
