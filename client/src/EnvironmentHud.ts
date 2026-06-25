/**
 * client/src/EnvironmentHud.ts
 * ---------------------------------------------------------------------------
 * The top-bar ENVIRONMENT HUD — the live, at-a-glance picture of the village's
 * world state: SEASON · WEATHER · TEMPERATURE · TIME.
 *
 * Everything here is DERIVED, never streamed: season and temperature come from
 * the shared, dependency-free `climate` module (a pure function of the engine
 * `tick` + current weather), exactly the same maths the engine and villager
 * minds use, so the HUD can never drift from the world. The component owns its
 * DOM node and is re-rendered both each clock tick and on every weather change.
 * ---------------------------------------------------------------------------
 */

import type { WeatherKind } from '../../shared/types';
import type { Season } from '../../shared/climate';
import type { PartOfDay } from '../../shared/simClock';
import { simTimeFromTick, formatSimTimeOfDay } from '../../shared/simClock';
import { seasonFromTick, temperatureFromTick } from '../../shared/climate';

/** Emoji + human label for each season. */
const SEASON_FACE: Record<Season, { emoji: string; label: string }> = {
  spring: { emoji: '🌸', label: 'Spring' },
  summer: { emoji: '☀️', label: 'Summer' },
  autumn: { emoji: '🍂', label: 'Autumn' },
  winter: { emoji: '❄️', label: 'Winter' },
};

/** Emoji + human label for each weather. */
const WEATHER_FACE: Record<WeatherKind, { emoji: string; label: string }> = {
  clear: { emoji: '🌤️', label: 'Clear' },
  rain: { emoji: '🌧️', label: 'Rain' },
  storm: { emoji: '⛈️', label: 'Storm' },
  fog: { emoji: '🌫️', label: 'Fog' },
  heatwave: { emoji: '🥵', label: 'Heatwave' },
};

/** Emoji for each coarse part of day, so the clock reads day/night at a glance. */
const PART_FACE: Record<PartOfDay, string> = {
  morning: '🌅',
  afternoon: '🏙️',
  evening: '🌇',
  night: '🌙',
};

/**
 * Bucket a temperature (°C) into a severity class, so the chip can be tinted
 * cold-blue → mild-green → hot-red without a per-degree gradient.
 */
function tempClass(celsius: number): string {
  if (celsius <= 4) return 'is-cold';
  if (celsius <= 14) return 'is-cool';
  if (celsius <= 22) return 'is-mild';
  if (celsius <= 30) return 'is-warm';
  return 'is-hot';
}

/** A thermometer emoji whose fill tracks how warm it is. */
function tempEmoji(celsius: number): string {
  if (celsius <= 4) return '🥶';
  if (celsius <= 30) return '🌡️';
  return '🔥';
}

/** Escape text bound for innerHTML / a title attribute (theme/setting are LLM-authored). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class EnvironmentHud {
  private readonly el: HTMLElement;
  private weather: WeatherKind = 'clear';
  private tick = 0;
  /** Flavour of an LLM-generated village; empty for the classic village (chip hidden). */
  private theme = '';
  private setting = '';

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** Latest weather; re-renders with the current tick so the temperature follows it. */
  setWeather(weather: WeatherKind): void {
    this.weather = weather;
    this.render(this.tick);
  }

  /**
   * The generated village's flavour (theme label + a sentence). Shows a 🏷️ chip in
   * the HUD whose tooltip is the setting; an empty theme hides the chip again.
   */
  setTheme(theme: string, setting: string): void {
    this.theme = theme.trim();
    this.setting = setting.trim();
    this.render(this.tick);
  }

  /** Render for an engine tick under the current weather. */
  render(tick: number): void {
    this.tick = tick;
    const t = simTimeFromTick(tick);
    const season = seasonFromTick(tick);
    const temp = temperatureFromTick(tick, this.weather);
    const s = SEASON_FACE[season];
    const w = WEATHER_FACE[this.weather];

    // A leading theme chip, only for an LLM-generated village; its tooltip is the
    // longer setting sentence so the top bar stays compact.
    const themeChip = this.theme
      ? `<span class="env__chip env__theme" title="${escapeHtml(this.setting || this.theme)}">` +
          `<span class="env__emoji">🏷️</span><span class="env__label">${escapeHtml(this.theme)}</span></span>`
      : '';

    this.el.hidden = false;
    this.el.innerHTML =
      themeChip +
      `<span class="env__chip env__season" title="Season — day ${t.day} of the village year">` +
        `<span class="env__emoji">${s.emoji}</span><span class="env__label">${s.label}</span></span>` +
      `<span class="env__chip env__weather" title="Current weather over the village">` +
        `<span class="env__emoji">${w.emoji}</span><span class="env__label">${w.label}</span></span>` +
      `<span class="env__chip env__temp ${tempClass(temp)}" title="Temperature — season + time of day + weather">` +
        `<span class="env__emoji">${tempEmoji(temp)}</span><span class="env__label">${temp}°C</span></span>` +
      `<span class="env__divider"></span>` +
      `<span class="env__clock">` +
        `<span class="clock__day">Day ${t.day}</span>` +
        `<span class="clock__time">${formatSimTimeOfDay(tick)}</span>` +
        `<span class="clock__part">${PART_FACE[t.partOfDay]} ${t.partOfDay}</span>` +
      `</span>`;
  }
}
