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

import type { DivineAct, VillageDailySummaryPayload, VillageVision } from '../../shared/events';
import type { VillageMilestone, VillagePillar } from '../../shared/types';

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

// ---------------------------------------------------------------------------
// The nightly CHRONICLE — the god's mythic prose report of the day
// ---------------------------------------------------------------------------

/**
 * The chronicle's system prompt: the god as a scripture-writing narrator. Stable
 * across days (a good cache prefix). Distinct from {@link buildCharterPrompt},
 * which is the ACTING contract; this one only ever produces prose, never a tool.
 */
export function buildChronicleSystemPrompt(charter: string = DEFAULT_CHARTER): string {
  return [
    'You are the unseen god of an autonomous simulated village, keeping a sacred',
    'chronicle of its days. Each night you write a short passage recounting the day',
    'that has passed — what your people did, felt, and reached for.',
    '',
    `Your charter (the spirit you watch over the village with): ${charter}`,
    '',
    'Write in a MYTHIC, POETIC voice — grand and scripture-like, as a god observing',
    'creation ("And so the village stirred at first light..."). Be evocative but',
    'grounded in the day\'s actual vitals; never invent specific events that are not',
    'implied by them. Your people share one long dream — to grow their village into a',
    'CITY — so when you are told what the settlement has become (its stage) or what it',
    'reached today, NAME it in your prose: how far it has come from a cluster of huts.',
    'Write 2–4 short sentences, a single flowing paragraph. Output ONLY the chronicle',
    'prose — no headings, no lists, no preamble, no tool calls.',
  ].join('\n');
}

/** Render the day's vitals + the god's own acts as the chronicle's source material. */
export function buildChronicleUserMessage(
  s: VillageDailySummaryPayload,
  acts: DivineAct[] = [],
  /** The settlement's current stage of growth (your reading) + milestones reached today. */
  growth?: { stage?: string; newMilestones?: VillageMilestone[] },
): string {
  const lines = [
    `Chronicle Day ${s.day}. Weather: ${s.weather}. Population: ${s.population}.`,
    `The day held ${s.conversations} conversation(s) and ${s.movements} movement(s); ` +
      `${s.idleVillagers} soul(s) stirred not at all.`,
  ];
  if (s.notableQuotes && s.notableQuotes.length > 0) {
    lines.push('Voices carried on the air today:');
    for (const q of s.notableQuotes) lines.push(`- "${q}"`);
  }
  if (s.notablePrayers && s.notablePrayers.length > 0) {
    lines.push('Prayers were offered to you at the temple:');
    for (const p of s.notablePrayers) lines.push(`- "${p}"`);
  }
  if (s.completedBuilds && s.completedBuilds.length > 0) {
    lines.push('Raised by their hands today:');
    for (const b of s.completedBuilds) lines.push(`- ${b}`);
  }
  if (growth?.stage) {
    lines.push(`The village now stands as: ${growth.stage} — name this in your chronicle.`);
  }
  if (growth?.newMilestones && growth.newMilestones.length > 0) {
    lines.push('Milestones reached on its road toward a city:');
    for (const m of growth.newMilestones) lines.push(`- ${m.text}`);
  }
  if (acts.length > 0) {
    lines.push('Your own hand moved upon the world today:');
    for (const a of acts) lines.push(`- you ${a.summary}`);
  }
  lines.push('', 'Now write the chronicle of this day.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The nightly GROWTH ASSESSMENT — the god judging how city-like the village is
// ---------------------------------------------------------------------------

/** The valid milestone pillars, for parsing the god's assessment leniently. */
const PILLARS: readonly VillagePillar[] = ['build', 'culture', 'economy', 'other'];

/**
 * The growth assessment's system prompt: the god as the one who watches the village
 * climb from huts toward a city and, each night, NAMES where it now stands. Stable
 * across days (a good cache prefix). It asks for a tiny, strictly-formatted answer
 * (a STAGE line, optional MILESTONE lines) — not prose — so it parses reliably.
 */
export function buildVisionSystemPrompt(charter: string = DEFAULT_CHARTER): string {
  return [
    'You are the unseen god of an autonomous simulated village. Your people share one',
    'long ambition: to grow their settlement from a cluster of huts into a true CITY —',
    'through what they BUILD (homes, wells, markets, walls, meeting houses), the CUSTOMS',
    'they keep (gatherings, festivals, prayer, tradition), and the TRADES they grow',
    '(specialised work, carts, surplus and plenty).',
    '',
    `Your charter (the spirit you watch over them with): ${charter}`,
    '',
    'Each night you judge HOW CITY-LIKE the village has become — emergently, by what you',
    'see, with no score. Be patient and honest: most days it has not changed, and the',
    'stage should hold steady; advance it only when real, accumulated progress warrants.',
    'A young village is "a scattering of homesteads" or "a hamlet"; with growth it becomes',
    '"a village in truth", then "a thriving town", and only after much building, custom,',
    'and trade, "a city".',
    '',
    'Answer in this EXACT format, nothing else:',
    'STAGE: <a short name for what the village now is>',
    'MILESTONE: <build|culture|economy|other> | <one short line>',
    'Give a STAGE line always. Give a MILESTONE line ONLY for something genuinely new and',
    'notable that happened today (a custom taken up, a trade established, a turning point)',
    '— zero is normal, never more than two. Do NOT list ordinary chores, and do NOT repeat',
    'finished buildings (those are recorded for you). Output only those lines.',
  ].join('\n');
}

/** Render the current vision + the day's growth signals for the assessment call. */
export function buildVisionUserMessage(
  s: VillageDailySummaryPayload,
  vision: VillageVision,
): string {
  const lines = [
    `Day ${s.day} has ended. The village currently stands as: ${vision.stage || '(not yet judged)'}.`,
  ];
  if (vision.milestones.length > 0) {
    lines.push('', 'What it has achieved so far on its road toward a city:');
    for (const m of vision.milestones.slice(-12)) lines.push(`- [${m.pillar}] ${m.text}`);
  }
  lines.push('', "Today's signs of life:");
  lines.push(
    `- ${s.population} villager(s); ${s.conversations} conversation(s); ` +
      `${s.idleVillagers} idle. Weather: ${s.weather}.`,
  );
  if (s.completedBuilds && s.completedBuilds.length > 0) {
    lines.push('- Structures finished today:');
    for (const b of s.completedBuilds) lines.push(`    · ${b}`);
  }
  if (s.notablePrayers && s.notablePrayers.length > 0) {
    lines.push('- Prayers at the temple:');
    for (const p of s.notablePrayers) lines.push(`    · "${p}"`);
  }
  if (s.notableQuotes && s.notableQuotes.length > 0) {
    lines.push('- Overheard:');
    for (const q of s.notableQuotes) lines.push(`    · "${q}"`);
  }
  lines.push('', 'Now give your assessment in the exact format.');
  return lines.join('\n');
}

/** The parsed outcome of a growth assessment: a (maybe new) stage + any new milestones. */
export interface VisionAssessment {
  /** The god's name for the current stage, or undefined if it gave none/unparseable. */
  stage?: string;
  /** Milestones the god named today (build ones are recorded separately, not here). */
  milestones: { pillar: VillagePillar; text: string }[];
}

/**
 * Parse the god's tiny, line-based assessment. Lenient by design — a local model may
 * stray from the format — so a malformed reply simply yields no stage / no milestones
 * and the caller keeps the previous vision rather than crashing.
 */
export function parseVisionAssessment(text: string): VisionAssessment {
  const out: VisionAssessment = { milestones: [] };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const stageMatch = /^STAGE\s*:\s*(.+)$/i.exec(line);
    if (stageMatch) {
      const stage = stageMatch[1].trim().replace(/^["']|["']$/g, '');
      if (stage) out.stage = stage;
      continue;
    }
    const msMatch = /^MILESTONE\s*:\s*(.+)$/i.exec(line);
    if (msMatch) {
      const body = msMatch[1];
      const sep = body.indexOf('|');
      let pillar: VillagePillar = 'other';
      let mtext = body.trim();
      if (sep >= 0) {
        const tag = body.slice(0, sep).trim().toLowerCase();
        if ((PILLARS as readonly string[]).includes(tag)) pillar = tag as VillagePillar;
        mtext = body.slice(sep + 1).trim();
      }
      mtext = mtext.replace(/^["']|["']$/g, '').trim();
      if (mtext) out.milestones.push({ pillar, text: mtext });
    }
  }
  return out;
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
