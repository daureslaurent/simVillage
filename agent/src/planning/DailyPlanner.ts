/**
 * agent/src/planning/DailyPlanner.ts
 * ---------------------------------------------------------------------------
 * The DAILY AGENDA — a villager's rough plan for the day.
 *
 * A purely reactive mind (perceive → pick one tool) wanders: each turn is chosen
 * in isolation, so the day has no shape. This is the cheap, generative-agents-
 * style fix: once each morning a villager steps back and sketches a loose agenda
 * — what it means to do in the morning, at midday, in the afternoon, the evening —
 * grounded in WHO it is (persona + standing goal) and the world it lives in (the
 * shared bible). That agenda is then injected into every per-turn prompt as gentle
 * guidance, so the hundreds of small reactive decisions add up to a coherent day.
 *
 * It is NOT a script. The plan never moves the body or emits an action; the mind
 * still chooses one tool per turn from what it actually senses, free to abandon
 * the plan when a neighbour, an event, or a pressing need calls for it. The plan
 * is the current the villager swims in, not a rail it runs on.
 *
 * Cost: exactly one extra LLM completion per villager per simulated DAY (on the
 * same `/complete` seam the nightly reflection already uses) — negligible next to
 * the per-turn decision traffic.
 * ---------------------------------------------------------------------------
 */

import type { Synthesizer } from '../memory/Synthesizer';
import type { CharacterProfile } from '../profile';
import type { Relationship } from '../../../shared/types';
import { affinityWord } from '../social/RelationshipBook';
import { simTimeFromTick, type PartOfDay } from '../../../shared/simClock';

/** One block of the day: a coarse phase and what the villager means to do in it. */
export interface PlanBlock {
  /** Which coarse phase of the day this block governs. */
  when: PartOfDay;
  /** A short, first-person intention, e.g. "open the bakery and bake the morning bread". */
  intent: string;
}

/** A villager's loose agenda for one in-world day. */
export interface DayPlan {
  /** The in-world day number (1-based) this plan is for. */
  day: number;
  /** A one-line theme for the day, in the villager's own voice. */
  theme: string;
  /** The per-phase intentions, in day order. */
  blocks: PlanBlock[];
}

/** The phases we ask a villager to plan for, in order. Night is for sleeping. */
const PLANNED_PHASES: PartOfDay[] = ['morning', 'afternoon', 'evening'];

export interface DailyPlannerOptions {
  /** The villager whose day this is — persona + standing goal frame the plan. */
  profile: CharacterProfile;
  /** The shared world bible, so the plan is grounded in how this world actually works. */
  bible: string;
  /** Optional: yesterday's reflection / belief, to carry intent across days. */
  recentBelief?: () => string | null;
  /**
   * Optional: the village's shared gathering place. When given, the agenda is
   * asked to fold in time to eat and talk there — a predictable window when all
   * villagers converge on the same spot, which is what lets conversations form
   * instead of everyone idling at their own workplace out of earshot.
   */
  hub?: () => { name: string } | null;
  /**
   * Optional: this villager's current view of its neighbours. When given, the
   * morning agenda is nudged to fold in the people it cares about — seeking out a
   * friend, mending a rift, or simply sharing a chore — so relationships shape the
   * day rather than sitting inert in the prompt.
   */
  relationships?: () => Relationship[];
}

/**
 * Holds a villager's current {@link DayPlan} and refreshes it once per in-world
 * day. Drive it by calling {@link onTick} from wherever the mind already sees the
 * world clock; read the live guidance for a turn with {@link blockFor}.
 */
export class DailyPlanner {
  /** The plan in force, or null until the first one is generated. */
  private plan: DayPlan | null = null;
  /** The day number we have already planned (or begun planning), to plan each day once. */
  private plannedDay = -1;
  /** Guards against overlapping plan generations if one runs long. */
  private planning = false;

  constructor(
    private readonly synthesizer: Synthesizer,
    private readonly options: DailyPlannerOptions,
  ) {}

  /**
   * Feed the current world tick. The first time a new day is seen, kick off a
   * fresh agenda (fire-and-forget — a slow plan must never block the think loop).
   * Cheap to call every tick: it short-circuits unless the day has rolled over.
   */
  onTick(tick: number): void {
    if (this.planning) return;
    const day = simTimeFromTick(tick).day;
    if (day <= this.plannedDay) return; // already planned (or planning) today
    this.plannedDay = day;
    void this.regenerate(day);
  }

  /**
   * Drop the current plan so the next {@link onTick} re-plans this same day. Used
   * when something upends the villager's intentions mid-day — a planted idea, a
   * reflection that rewrote the goal — so the agenda catches up rather than
   * steering by a stale purpose until tomorrow.
   */
  invalidate(): void {
    this.plan = null;
    this.plannedDay = -1;
  }

  /** The current full plan, or null if none has been formed yet. */
  current(): DayPlan | null {
    return this.plan;
  }

  /**
   * The plan block governing the given tick's part of day, or null when there is
   * no plan yet or the phase is night (sleep). This is what the prompt injects as
   * "what you mean to be doing right now".
   */
  blockFor(tick: number): PlanBlock | null {
    if (!this.plan) return null;
    const phase = simTimeFromTick(tick).partOfDay;
    return this.plan.blocks.find((b) => b.when === phase) ?? null;
  }

  // -------------------------------------------------------------------------

  private async regenerate(day: number): Promise<void> {
    this.planning = true;
    try {
      const raw = (
        await this.synthesizer.synthesize({
          system: PLAN_SYSTEM(this.options.profile, this.options.bible),
          agent: this.options.profile.name ?? this.options.profile.id,
          purpose: 'plan',
          user: PLAN_PROMPT(
            this.options.recentBelief?.() ?? null,
            this.options.hub?.()?.name ?? null,
            this.options.relationships?.() ?? [],
          ),
        })
      ).trim();
      const plan = parsePlan(raw, day);
      if (plan.blocks.length > 0) {
        this.plan = plan;
        console.log(
          `[planner:${this.options.profile.id}] day ${day} plan: ${plan.theme} ` +
            `(${plan.blocks.map((b) => b.when).join(', ')})`,
        );
      }
    } catch (err) {
      // A failed plan just leaves yesterday's (or none) in place; the mind stays
      // reactive for the day rather than crashing. Try again next day.
      console.warn(`[planner:${this.options.profile.id}] failed to plan day ${day}:`, errMsg(err));
    } finally {
      this.planning = false;
    }
  }
}

/** System framing for the plan completion — persona + the shared world. */
function PLAN_SYSTEM(profile: CharacterProfile, bible: string): string {
  const lines = bible ? [bible, '', '---', ''] : [];
  lines.push(
    `You are ${profile.name}, a villager (${profile.traits.join(', ')}).`,
    `Your standing goal: ${profile.goal}`,
  );
  if (profile.backstory) lines.push(`Background: ${profile.backstory}`);
  lines.push(
    '',
    'It is the start of a new day. Think, as yourself, about how you mean to spend',
    'it — a loose plan, not a rigid schedule, grounded in who you are, your goal,',
    'and how this village works.',
  );
  return lines.join('\n');
}

/** The user half of the plan prompt: the labelled-line format we parse back. */
function PLAN_PROMPT(
  recentBelief: string | null,
  hubName: string | null,
  relationships: Relationship[],
): string {
  const lines: string[] = [];
  if (recentBelief) {
    lines.push(`Last night you reflected: ${recentBelief}`, '');
  }
  // The handful of people this villager feels most strongly about, so the day can
  // be shaped around them — seeking out a friend, working alongside one you trust.
  const strong = relationships.filter((r) => Math.abs(r.affinity) >= 25).slice(0, 3);
  if (strong.length > 0) {
    const who = strong.map((r) => `${r.otherName} (you are ${affinityWord(r.affinity)} them)`).join('; ');
    lines.push(
      `People on your mind: ${who}. Let how you feel about them colour your day — seek` +
        ' out those you care for to work or share a meal, and keep your peace with the rest.',
      '',
    );
  }
  if (hubName) {
    lines.push(
      `The village gathers at ${hubName}. Plan to be there around midday to eat and` +
        ' trade news, and again in the evening to visit — that is where you see your' +
        ' neighbours. Build at least one of those social windows into your day.',
      '',
    );
  }
  lines.push(
    'Sketch your plan for today. Write ONLY these labelled lines, each on its own line:',
    'THEME: a one-line intention for the whole day, in your own voice.',
    'MORNING: what you mean to do in the morning.',
    'AFTERNOON: what you mean to do in the afternoon.',
    'EVENING: what you mean to do in the evening.',
    '',
    'Keep each line short and concrete, in the first person. Output nothing but',
    'these four labelled lines.',
  );
  return lines.join('\n');
}

/**
 * Parse the labelled-line plan into a {@link DayPlan}, tolerantly: any of THEME /
 * MORNING / AFTERNOON / EVENING, in any order, with `:` or `-` separators. Lines
 * the model didn't fill are simply absent from `blocks`. If nothing parses, the
 * result has an empty `blocks` array and the caller keeps the previous plan.
 */
export function parsePlan(raw: string, day: number): DayPlan {
  let theme = '';
  const byPhase = new Map<PartOfDay, string>();

  const LINE = /^\s*(theme|morning|afternoon|evening)\s*[:\-–]\s*(.+?)\s*$/i;
  for (const line of raw.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    const body = m[2]!.trim();
    if (!body) continue;
    if (tag === 'theme') {
      if (!theme) theme = body; // first THEME wins
    } else {
      byPhase.set(tag as PartOfDay, body);
    }
  }

  const blocks: PlanBlock[] = PLANNED_PHASES.filter((p) => byPhase.has(p)).map((when) => ({
    when,
    intent: byPhase.get(when)!,
  }));

  return { day, theme: theme || 'Get through the day and keep the village running.', blocks };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
