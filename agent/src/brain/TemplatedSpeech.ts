/**
 * agent/src/brain/TemplatedSpeech.ts
 * ---------------------------------------------------------------------------
 * v3 P4 — "Keep the feel, drop the LLM" (design §4). Speech for utility villagers.
 *
 * In v2 every villager spoke through its own language model. Under the v3 utility
 * brain ({@link UtilityBrain}) there is no LLM, so the village fell SILENT — bodies
 * worked the chains without a word. This restores the village's voice CHEAPLY: a
 * line is chosen from a small template library by the villager's STATE — what it
 * needs, what it just decided to do, who just came near, the weather — with no
 * model call at all.
 *
 * It honours the same rules the LLM speech did:
 *   - STRICT PROXIMITY — a line is only ever produced when someone is within earshot
 *     (the caller publishes it, and listeners apply the matching guard); talking to
 *     an empty field says nothing.
 *   - SPARSE — a per-villager cooldown keeps speech occasional, not a wall of chatter
 *     every think; a TALKATIVE trait shortens it, a quiet one need not speak at all.
 *   - VARIED — lines rotate within each pool (keyed off the tick) and never repeat
 *     the immediately-previous line, so a cluster doesn't echo one phrase.
 *
 * Pure & transport-free, exactly like the brain: it reads a {@link SpeechContext} and
 * returns one line or null. The only state it holds is a touch of bookkeeping —
 * the last line + when it was said, and who it has already greeted while they stand
 * in earshot — so it is one instance per villager.
 * ---------------------------------------------------------------------------
 */

import type { VillagerNeeds, WeatherKind } from '../../../shared/types';
import type { Perception, PerceivedVillager } from '../sensory';
import type { UtilityChoice } from './UtilityBrain';

/** Everything the speech chooser reads: the body's senses, who it is, and what it just decided. */
export interface SpeechContext {
  /** The villager's current perception (needs, weather, gathering, who is in earshot). */
  perception: Perception;
  /** The villager's stable personality words — a TALKATIVE one speaks more freely. */
  traits: string[];
  /** What the {@link UtilityBrain} chose this turn, so a line can flavour the action. */
  choice: UtilityChoice | null;
  /** Read this villager's warmth toward a neighbour (−100..100), so greetings vary by affinity. */
  affinityOf?: (otherId: string) => number | undefined;
  /** Wall-clock now, for the speech cooldown. */
  nowMs: number;
}

/** A need at or above this 0..100 level is worth grumbling about aloud. */
const NEED_GRUMBLE = 70;
/** Base gap between spoken lines (ms) — speech is occasional, not a running commentary. */
const BASE_COOLDOWN_MS = 18_000;
/** A talkative villager's shorter gap; a quieter one uses the base. */
const TALKATIVE_COOLDOWN_MS = 9_000;

/** Words that mark a villager as chatty (speaks more) vs. reserved (speaks rarely). */
const TALKATIVE_WORDS = /talkative|sociable|gregarious|friendly|warm|cheerful|curious/;
const RESERVED_WORDS = /quiet|reserved|taciturn|solitary|gruff|shy|stoic/;

export class TemplatedSpeech {
  /** Wall-clock ms of the last line spoken, for the cooldown. */
  private lastSpokeAt = 0;
  /** The last line spoken, so we never emit the same phrase twice in a row. */
  private lastLine: string | null = null;
  /** Ids already greeted while they stand within earshot; cleared when they leave it. */
  private readonly greeted = new Set<string>();

  /**
   * Choose a line to say this turn, or null to stay quiet. Returns null whenever there
   * is no one in earshot, the cooldown has not elapsed, or no template applies — so the
   * caller can simply `speakAloud` a non-null result, knowing the proximity + pacing
   * rules are already honoured.
   */
  decide(ctx: SpeechContext): string | null {
    const self = ctx.perception.self;
    if (self.asleep) return null;

    // STRICT PROXIMITY: only those within hearing can be spoken to. Forget anyone we
    // greeted who has since left earshot, so a later reunion is greeted afresh.
    const audience = ctx.perception.nearbyVillagers.filter((v) => v.canHear);
    const earshot = new Set(audience.map((v) => v.id));
    for (const id of this.greeted) if (!earshot.has(id)) this.greeted.delete(id);
    if (audience.length === 0) return null;

    const tick = ctx.perception.tick;
    const reserved = RESERVED_WORDS.test(ctx.traits.join(' ').toLowerCase());
    const cooldown = this.cooldownMs(ctx.traits);
    const sinceSpoke = ctx.nowMs - this.lastSpokeAt;

    // GREETING a fresh face takes priority and needs only HALF the cooldown — meeting
    // someone is the moment most worth a word, so the village feels responsive. A
    // reserved villager still greets (curtly), just nothing more.
    const stranger = audience.find((v) => !this.greeted.has(v.id));
    if (stranger && sinceSpoke >= cooldown / 2) {
      this.greeted.add(stranger.id);
      return this.emit(greetingLine(stranger, ctx.affinityOf?.(stranger.id) ?? 0, tick), ctx.nowMs);
    }

    // Past the greeting, a reserved villager mostly holds its tongue.
    if (sinceSpoke < cooldown) return null;
    if (reserved && !grumbleNeed(self.needs)) return null;

    // A pressing need is the next most natural thing to voice.
    const need = grumbleNeed(self.needs);
    if (need) return this.emit(pick(NEED_LINES[need], tick), ctx.nowMs);

    // Otherwise flavour what we're doing, remark on rough weather, or make small talk
    // when in company — chosen by the tick so a cluster doesn't all say the same thing.
    const action = ctx.choice ? actionLine(ctx.choice, tick) : null;
    const weather = weatherLine(ctx.perception.weather, tick);
    const candidates = [action, weather, self.gathering ? pick(SMALL_TALK, tick) : null].filter(
      (l): l is string => l !== null,
    );
    if (candidates.length === 0) return null;
    return this.emit(candidates[tick % candidates.length]!, ctx.nowMs);
  }

  /** The cooldown for this villager — shorter when talkative, the base otherwise. */
  private cooldownMs(traits: string[]): number {
    return TALKATIVE_WORDS.test(traits.join(' ').toLowerCase()) ? TALKATIVE_COOLDOWN_MS : BASE_COOLDOWN_MS;
  }

  /** Record + return a line, unless it repeats the previous one (then stay quiet). */
  private emit(line: string, nowMs: number): string | null {
    if (!line || line === this.lastLine) return null;
    this.lastSpokeAt = nowMs;
    this.lastLine = line;
    return line;
  }
}

/** The most pressing need worth grumbling about, or null when all are comfortable. */
function grumbleNeed(needs: VillagerNeeds): keyof typeof NEED_LINES | null {
  const ranked: (keyof typeof NEED_LINES)[] = ['thirst', 'hunger', 'fatigue', 'boredom'];
  let worst: keyof typeof NEED_LINES | null = null;
  let worstVal = NEED_GRUMBLE;
  for (const k of ranked) {
    const v = needs[k] ?? 0;
    if (v >= worstVal) {
      worst = k;
      worstVal = v;
    }
  }
  return worst;
}

/** A warmth-graded greeting for a neighbour who just came within earshot. */
function greetingLine(other: PerceivedVillager, affinity: number, tick: number): string {
  const name = firstName(other.name);
  if (affinity >= 35) return pick([`${name}! Good to see you.`, `Ah, ${name} — well met!`, `There you are, ${name}.`], tick);
  if (affinity <= -35) return pick([`${name}.`, `Oh. ${name}.`, `Hm. ${name}.`], tick);
  return pick([`Hello, ${name}.`, `Morning, ${name}.`, `${name} — how goes it?`], tick);
}

/** Flavour the action the brain chose — only for the kinds worth a word. */
function actionLine(choice: UtilityChoice, tick: number): string | null {
  const pool = ACTION_LINES[choice.priority];
  return pool ? pick(pool, tick) : null;
}

/** A remark on rough weather; clear skies pass without comment. */
function weatherLine(weather: WeatherKind, tick: number): string | null {
  const pool = WEATHER_LINES[weather];
  return pool ? pick(pool, tick) : null;
}

/** Deterministic-but-rotating choice from a pool, keyed off the tick so lines vary. */
function pick(pool: readonly string[], tick: number): string {
  return pool[Math.abs(tick) % pool.length]!;
}

/** Just the given name from a display name like "Mira the Blacksmith". */
function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

const NEED_LINES = {
  thirst: ["I'm parched.", 'Need water, badly.', "My throat's like dust."],
  hunger: ["I'm starving.", "My stomach's growling.", 'I could eat a horse.'],
  fatigue: ["I'm dead on my feet.", 'I could sleep standing up.', 'So weary...'],
  boredom: ["I'm bored stiff.", 'Need something to do.', 'Dull day, this.'],
} as const;

/** Lines keyed by the utility priority the brain settled on this turn. */
const ACTION_LINES: Partial<Record<UtilityChoice['priority'], readonly string[]>> = {
  food: ['Back to the fields.', "Food won't grow itself.", 'Tending the crops.'],
  water: ['Off to fetch water.', 'The well calls.'],
  gather: ['Hauling a load.', 'Stocking the shelves.', 'Honest work, this.'],
  build: ["Let's raise it together.", "This'll stand for years.", 'Lend a hand here?'],
  recreation: ['Time for a breather.', 'Off to the tavern, I think.'],
};

const WEATHER_LINES: Partial<Record<WeatherKind, readonly string[]>> = {
  rain: ['Grim skies today.', 'This rain again...'],
  storm: ['Best take shelter soon.', "There's a storm brewing."],
  fog: ['Can barely see a thing.', 'Thick fog this morning.'],
  heatwave: ["It's sweltering out.", 'No air to be had today.'],
};

const SMALL_TALK = [
  'Good company, this.',
  'How are things with you?',
  'Quiet day, all told.',
  'Anything new your way?',
] as const;
