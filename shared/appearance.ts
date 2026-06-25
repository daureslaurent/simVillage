/**
 * shared/appearance.ts
 * ---------------------------------------------------------------------------
 * VILLAGER LOOKS — the procedural-sprite vocabulary.
 *
 * Every villager carries a small set of PARTS (a body silhouette, an outfit
 * colour, a head/hair, a hat, a held tool) that the client layers into a little
 * figure on the canvas, so no two villagers look alike. The parts are a fixed,
 * enumerated vocabulary on purpose: the world generator asks the (often local)
 * LLM to pick from these lists, which a small model can satisfy reliably, and
 * the client only ever has to know how to draw this finite set.
 *
 * This module is the single source of truth shared by the server (generation +
 * seeding) and the client (rendering): the option lists, a DETERMINISTIC
 * fallback (`deriveAppearance`) so every villager — classic seed, dynamic
 * spawn, or an old save — always has a coherent look, and a defensive
 * validator (`coerceAppearance`) that repairs whatever the model returns.
 * ---------------------------------------------------------------------------
 */

/** The body silhouette — the at-a-glance shape that reads even when zoomed out. */
export type BodyShape = 'round' | 'square' | 'tall' | 'stout';
/** Hair on the head, drawn in {@link VillagerAppearance.hairColor}. */
export type HairStyle = 'bald' | 'short' | 'long' | 'bun' | 'spiky';
/** Headwear, drawn over the hair. */
export type HatStyle = 'none' | 'straw' | 'cap' | 'hood' | 'crown' | 'wreath' | 'horns';
/** A small tool/prop held to the figure's side — a hint at the villager's role. */
export type AccentStyle = 'none' | 'staff' | 'hoe' | 'hammer' | 'book' | 'lantern' | 'basket';

export const BODY_SHAPES: readonly BodyShape[] = ['round', 'square', 'tall', 'stout'];
export const HAIR_STYLES: readonly HairStyle[] = ['bald', 'short', 'long', 'bun', 'spiky'];
export const HAT_STYLES: readonly HatStyle[] = ['none', 'straw', 'cap', 'hood', 'crown', 'wreath', 'horns'];
export const ACCENT_STYLES: readonly AccentStyle[] = ['none', 'staff', 'hoe', 'hammer', 'book', 'lantern', 'basket'];

/**
 * The full look of one villager: a few enumerated parts plus three colours.
 * `bodyColor` doubles as the villager's map {@link colour} so the figure and the
 * legacy coloured dot agree. Pure serialisable data — it rides the `Villager`
 * entity to the browser and persists in the world snapshot.
 */
export interface VillagerAppearance {
  body: BodyShape;
  /** The outfit / primary colour. Also used as the villager's render colour. */
  bodyColor: string;
  /** Skin tone of the head. */
  skin: string;
  hair: HairStyle;
  hairColor: string;
  hat: HatStyle;
  accent: AccentStyle;
}

/** A spread of cheerful, distinct outfit colours used when none is supplied. */
const OUTFIT_COLORS = [
  '#ff4d4d', '#4dafff', '#ffd24d', '#9b5dff', '#4dffa1', '#ff9f4d',
  '#ff6fb5', '#37c9c2', '#7ed957', '#c14b8a', '#5a7dff', '#e0823d',
];
/** Plausible skin tones, light to dark. */
const SKIN_TONES = ['#ffd9b3', '#f1c8a4', '#e0a878', '#c68642', '#a86b3c', '#8d5524'];
/** Natural-ish (and a couple of fanciful) hair colours. */
const HAIR_COLORS = ['#2b2b2b', '#3a2f2a', '#5a3a1a', '#8b5a2b', '#d9b382', '#b0b0b0', '#c14b2a'];

/** A tiny, stable FNV-1a string hash, so a given id always yields the same look. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** True for a usable CSS hex colour (#rgb or #rrggbb). */
function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

/**
 * A complete, coherent look derived purely from a seed string (the villager id),
 * optionally honouring a pre-chosen `baseColor` so the figure matches an existing
 * map colour. Stable across runs — the same id always looks the same — so it is a
 * safe fallback for villagers the LLM never described (classic seed, dynamic
 * spawns, old saves).
 */
export function deriveAppearance(seed: string, baseColor?: string): VillagerAppearance {
  const h = hash(seed);
  const at = <T>(arr: readonly T[], salt: number): T => arr[((h ^ Math.imul(salt, 0x9e3779b1)) >>> 0) % arr.length]!;
  return {
    body: at(BODY_SHAPES, 1),
    bodyColor: isHex(baseColor) ? baseColor!.trim() : at(OUTFIT_COLORS, 2),
    skin: at(SKIN_TONES, 3),
    hair: at(HAIR_STYLES, 4),
    hairColor: at(HAIR_COLORS, 5),
    hat: at(HAT_STYLES, 6),
    accent: at(ACCENT_STYLES, 7),
  };
}

/** Coerce one enum field: the raw value if it is in `allowed`, else the fallback. */
function oneOf<T>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly unknown[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Validate and REPAIR a model-produced appearance into a guaranteed-valid one.
 * Every field is checked against its vocabulary (or the hex-colour shape) and any
 * missing/garbled value falls back to the deterministic look for `fallbackSeed`,
 * so the result is always complete and renderable no matter what the model wrote.
 */
export function coerceAppearance(
  raw: unknown,
  fallbackSeed: string,
  baseColor?: string,
): VillagerAppearance {
  const d = deriveAppearance(fallbackSeed, baseColor);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    body: oneOf(o.body, BODY_SHAPES, d.body),
    bodyColor: isHex(o.bodyColor) ? (o.bodyColor as string).trim() : d.bodyColor,
    skin: isHex(o.skin) ? (o.skin as string).trim() : d.skin,
    hair: oneOf(o.hair, HAIR_STYLES, d.hair),
    hairColor: isHex(o.hairColor) ? (o.hairColor as string).trim() : d.hairColor,
    hat: oneOf(o.hat, HAT_STYLES, d.hat),
    accent: oneOf(o.accent, ACCENT_STYLES, d.accent),
  };
}
