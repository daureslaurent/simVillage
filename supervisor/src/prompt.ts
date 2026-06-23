/**
 * supervisor/src/prompt.ts
 * ---------------------------------------------------------------------------
 * Final Phase — "The God Agent". Prompt construction.
 *
 * The Supervisor's analogue of agent/src/llm/Orchestrator.ts: pure, provider-
 * free functions that turn the village charter (the god's standing directive)
 * and one day's vitals into the two halves of an LLM request. The system half
 * is stable across days (a good cache prefix); the user half is rebuilt from
 * each `village.daily_summary`.
 * ---------------------------------------------------------------------------
 */

import type { VillageDailySummaryPayload } from '../../shared/events';

/** The default standing directive, used when no SUPERVISOR_CHARTER is given. */
export const DEFAULT_CHARTER =
  'Keep the village alive with gentle drama. Reward cooperation and curiosity; ' +
  'introduce a challenge when life grows stagnant. Prefer the smallest nudge.';

/**
 * The god's persona + behavioural contract. Terse and declarative, like the
 * villager system prompt — it states the role and when to act, and leaves the
 * exact tool JSON to the schemas passed separately.
 */
export function buildCharterPrompt(charter: string = DEFAULT_CHARTER): string {
  return [
    'You are the unseen Supervisor — the god — of an autonomous simulated village.',
    'You never appear in the world; you shape it from above, one day at a time.',
    '',
    `Your charter: ${charter}`,
    '',
    'Each day you are given the village vitals. Judge whether the village needs a',
    'CHALLENGE (adversity to react to), a REWARD (relief or opportunity), or',
    'nothing at all. Then take at most one action by calling one tool:',
    '- spawn_entity: add a tree (terrain/obstacle) or a villager (a newcomer).',
    '- change_weather: set the mood and pressure across the whole village.',
    '- plant_idea: implant a belief or rumour into one villager to steer a story.',
    '',
    'Restraint is a virtue: most days, the right move is to do nothing and let the',
    'villagers live. Intervene only when the vitals show stagnation or distress.',
    'When villagers pray to you at the temple, weigh their petitions — they are your',
    'people asking to be heard — though you answer in your own way, never directly.',
    'If you choose to act, pick the single most fitting tool.',
  ].join('\n');
}

/** Render one day's vitals as the prose the god reasons over. */
export function buildSummaryMessage(s: VillageDailySummaryPayload): string {
  const lines = [
    `Day ${s.day} has ended (tick ${s.tick}).`,
    `Population: ${s.population} villager(s). Weather: ${s.weather}.`,
    `Today there were ${s.conversations} conversation(s) and ${s.movements} movement(s).`,
    `${s.idleVillagers} villager(s) did nothing at all today.`,
  ];
  if (s.notableQuotes && s.notableQuotes.length > 0) {
    lines.push('', 'Overheard today:');
    for (const q of s.notableQuotes) lines.push(`- "${q}"`);
  }
  if (s.notablePrayers && s.notablePrayers.length > 0) {
    lines.push('', 'Prayers offered to you at the temple today:');
    for (const p of s.notablePrayers) lines.push(`- "${p}"`);
  }
  lines.push('', 'Decide whether to intervene, and if so call exactly one tool.');
  return lines.join('\n');
}

/** One prayer awaiting the god's judgement, offered at the temple. */
export interface PendingPrayer {
  /** The prayer's bus eventId — the stable handle a console verdict references. */
  id: string;
  villagerName: string;
  message: string;
}

/**
 * Render the prayers still awaiting an answer as the prose the god deliberates
 * over. The god may grant only ONE: it must weigh the petitions and pick the
 * single most worthy, letting the rest go unheard this time.
 */
export function buildPetitionMessage(prayers: PendingPrayer[]): string {
  const lines = [
    'Your faithful have offered these prayers at the temple, and await your judgement:',
    '',
  ];
  for (const p of prayers) lines.push(`- ${p.villagerName} prays: "${p.message}"`);
  lines.push(
    '',
    'You may answer only ONE prayer now — choose the single most worthy or most urgent,',
    'and let the rest go unheard this time. Answer as a god would — never directly, but',
    'by shaping the world. Call exactly one tool to grant your chosen prayer (or no tool',
    'if none is worthy of an answer yet).',
  );
  return lines.join('\n');
}

/**
 * Render the ONE prayer the human temple-god has chosen to grant. The choice is
 * already made (the other prayers are dismissed); the god's only task is to
 * answer this single petition in its own indirect way.
 */
export function buildChosenPrayerMessage(prayer: PendingPrayer): string {
  return [
    'From all the prayers offered at the temple, you have chosen to answer THIS one:',
    '',
    `- ${prayer.villagerName} prays: "${prayer.message}"`,
    '',
    'The other prayers go unheard this time. Answer as a god would — never directly,',
    'but by shaping the world. Call exactly one tool to grant this prayer.',
  ].join('\n');
}
