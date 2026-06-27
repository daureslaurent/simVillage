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
import type { CompetitionIntensity, DigestEvent, VillageMilestone, VillagePillar, VillagePolicy, WorldDigestVitals } from '../../shared/types';
import { PRIORITIES } from '../../shared/types';

/**
 * The RAID STANCE line folded into the charter for each competition intensity — a soft
 * nudge on how readily this god sends a raiding party against the rival across the valley.
 * Only meaningful in a two-village world; harmless otherwise (there is no one to raid).
 */
const INTENSITY_STANCE: Record<CompetitionIntensity, string> = {
  peaceful:
    'Your stance toward the rival village is PEACEFUL: prefer to out-build and out-grow them, ' +
    'not raid them. Raid only as a last resort when your people are truly desperate.',
  balanced:
    'Your stance toward the rival village is BALANCED: raid when there is a clear advantage or ' +
    'a wrong to answer, but do not seek conflict for its own sake.',
  aggressive:
    'Your stance toward the rival village is AGGRESSIVE: press them hard — raid often to seize ' +
    'their stores and keep them on the back foot, while still keeping your own people alive.',
};

/** The default standing directive, used when no SUPERVISOR_CHARTER is given. */
export const DEFAULT_CHARTER =
  'Keep the village alive with gentle drama. Reward cooperation and curiosity; ' +
  'introduce a challenge when life grows stagnant. Prefer the smallest nudge.';

/**
 * The god's persona + behavioural contract. Terse and declarative, like the
 * villager system prompt — it states the role and when to act, and leaves the
 * exact tool JSON to the schemas passed separately.
 */
export function buildCharterPrompt(charter: string = DEFAULT_CHARTER, intensity?: CompetitionIntensity): string {
  return [
    'You are the unseen Supervisor — the god — of an autonomous simulated village.',
    'You never appear in the world; you shape it from above.',
    '',
    `Your charter: ${charter}`,
    ...(intensity ? ['', INTENSITY_STANCE[intensity]] : []),
    '',
    'You are an AGENT. Work in a loop: THINK about what the vitals in front of you mean,',
    'INVESTIGATE with your lookup tools to gather the facts you are missing, reason about',
    'what you find, and only THEN act. Looking costs nothing; acting is weighty. Never steer',
    'blind — when something is unclear (who is suffering? where are the stores? what did I try',
    'before?), look it up first. When you have seen enough, take at most one or two actions,',
    'then stop (call no tool) to end your deliberation.',
    '',
    'INVESTIGATION tools (read-only — they change nothing, they inform you):',
    '- list_villagers: every villager now, with needs + what they are doing (find the suffering).',
    '- inspect_villager(villager_id): one villager in full, before you whisper to or single them out.',
    '- list_buildings(kind?): the structures and their current stock (see where stores really sit).',
    '- scan_rival: the rival across the valley, as far as the fog allows (before you raid).',
    '- review_plan: your village\'s stage, milestones, and the priorities you are already steering with.',
    '- list_prayers: every petition still awaiting your judgement.',
    '- recall_memory(query): what you have learned about this village before.',
    '',
    'ACTION tools (these shape the world — use deliberately):',
    '- set_priorities: your MAIN, everyday lever — the standing weights (0..1) that bias what',
    '  the whole village spends effort on (food, water, build, gather, recreation…). Low stores',
    '  → raise food/gather; a growing settlement → raise build; restless people → raise recreation.',
    '- issue_order: a TARGETED, temporary push — send specific villagers (or everyone) to a task',
    '  (build, gather, haul, work, guard, move, socialize) for a while. It expires; villagers still',
    '  tend their own survival. Use it for a focused, short-lived effort.',
    '- spawn_entity: add a tree, a villager newcomer, OR a FORTIFICATION to wage the war on',
    '  your rival. On your OWN ground raise "wall" (give `length` + `orientation` "h"/"v" to lay',
    '  a rampart; a long wall opens a "gate" in its middle so your folk pass), "watchtower" (spot',
    '  raids early), "barracks" (your defenders fight harder), "war_camp" (your raiders hit',
    '  harder) — and place a "siege_ram" against a RIVAL wall to batter a breach. Buildings and',
    '  villagers carry life; ring your settlement with walls to blunt raids, then breach theirs.',
    '- change_weather: set the mood and pressure across the whole village.',
    '- plant_idea: implant a belief or rumour into one villager to steer a story.',
    '',
    'Most deliberations end in a single set_priorities tuned to fit what you saw — that alone',
    'steers the village. The other three action tools are DRAMA: use them sparingly, only when',
    'the situation shows stagnation or distress that a shift in priorities cannot answer. When',
    'villagers pray to you, weigh their petitions — your people asking to be heard — though you',
    'answer in your own way, never directly.',
  ].join('\n');
}

/** How the god is told to act this day (drama gated by the intervention cool-off). */
export interface SummaryContext {
  /** The village's current standing policy, so the god tunes from where it is. */
  policy?: VillagePolicy;
  /** False while the god is cooling off from a recent dramatic act — only policy may change. */
  dramaAllowed?: boolean;
}

/** One line of the village's current standing priorities, or a note that none are set. */
function formatPolicy(policy?: VillagePolicy): string {
  const w = policy?.weights ?? {};
  const set = PRIORITIES.filter((p) => w[p] !== undefined);
  if (set.length === 0) return 'Current priorities: none set yet (the village runs neutral).';
  return 'Current priorities: ' + set.map((p) => `${p} ${w[p]!.toFixed(2)}`).join(', ') + '.';
}

/** Render the aggregate WORLD DIGEST vitals (needs/stocks/buildings) as prose for the god. */
function formatDigest(d?: WorldDigestVitals): string[] {
  if (!d) return [];
  const lines = ['', 'Village vitals (averaged across your people):'];
  lines.push(
    `- Needs (avg/worst, 0 calm…100 dire): hunger ${d.needs.hunger.avg}/${d.needs.hunger.max}, ` +
      `thirst ${d.needs.thirst.avg}/${d.needs.thirst.max}, fatigue ${d.needs.fatigue.avg}/${d.needs.fatigue.max}, ` +
      `boredom ${d.needs.boredom.avg}/${d.needs.boredom.max}.`,
  );
  // Fatigue is SELF-MANAGED: villagers sleep on their own when it nears 100, so it needs no
  // steering. Don't gut build/gather to chase rest — keep weighting work by what the village
  // is actually short of (food/water low → raise those; stores deep → raise build/gather).
  lines.push('  (Fatigue resolves itself in sleep — do not zero out work to "rest"; steer by stocks.)');
  const stocks = Object.entries(d.stocks).map(([r, n]) => `${r} ${n}`);
  lines.push(`- Stores: ${stocks.length > 0 ? stocks.join(', ') : 'empty'}.`);
  const low = d.buildings.filter((b) => b.lowStock > 0).map((b) => `${b.lowStock}× ${b.kind}`);
  if (low.length > 0) lines.push(`- Running low: ${low.join(', ')}.`);
  // v3 P5 (design §10) — what you can see of the RIVAL across the valley (fog-of-war): their
  // rough size + where their settlement lies. You may send a raiding party with
  // issue_order task "raid" and x/y set to their location to seize their stores.
  if (d.rival) {
    const where = d.rival.center ? ` near (${d.rival.center.x}, ${d.rival.center.y})` : '';
    lines.push(
      `- Rival "${d.rival.villageId}": ${d.rival.activity}${where}. ` +
        `To raid them, issue_order task "raid" with x/y set to their location.`,
    );
  }
  return lines;
}

/** Render one day's vitals + the standing policy as the prose the god reasons over. */
export function buildSummaryMessage(s: VillageDailySummaryPayload, ctx: SummaryContext = {}): string {
  const lines = [
    `Day ${s.day} has ended (tick ${s.tick}).`,
    `Population: ${s.population} villager(s). Weather: ${s.weather}.`,
    `Today there were ${s.conversations} conversation(s) and ${s.movements} movement(s).`,
    `${s.idleVillagers} villager(s) did nothing at all today.`,
    formatPolicy(ctx.policy),
  ];
  lines.push(...formatDigest(s.digest));
  if (s.events && s.events.length > 0) {
    lines.push('', 'Notable happenings today:');
    for (const e of s.events) lines.push(`- ${digestEventIcon(e.salience)} ${e.text}`);
  }
  if (s.notableQuotes && s.notableQuotes.length > 0) {
    lines.push('', 'Overheard today:');
    for (const q of s.notableQuotes) lines.push(`- "${q}"`);
  }
  if (s.notablePrayers && s.notablePrayers.length > 0) {
    lines.push('', 'Prayers offered to you at the temple today:');
    for (const p of s.notablePrayers) lines.push(`- "${p}"`);
  }
  lines.push('');
  if (ctx.dramaAllowed === false) {
    lines.push(
      'You acted dramatically recently and are still at rest — today you may ONLY call',
      'set_priorities to tune the village. Adjust the weights to fit these vitals (or, if',
      'they are already right, call no tool).',
    );
  } else {
    lines.push(
      'Tune the priorities to fit these vitals with set_priorities, and only stage drama',
      '(spawn_entity / change_weather / plant_idea) if something truly warrants it. Call the',
      'one tool that fits — or none if the village is well and the priorities already suit.',
    );
  }
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

/** A small severity marker for a world event, so the prompt reads the urgency at a glance. */
function digestEventIcon(salience: DigestEvent['salience']): string {
  return salience === 'crisis' ? '‼' : salience === 'warning' ? '!' : '·';
}

/**
 * Render a HIGH-SALIENCE alert into the prompt for an out-of-cadence deliberation
 * (design §8). The god is woken mid-day by a crisis; give it the crisis itself, the
 * last day's vitals/policy for context, and a tight instruction to answer THIS — with a
 * priority shift, or drama if it truly warrants. Falls back to the bare alert when no
 * summary has been seen yet (very early in a run).
 */
export function buildAlertMessage(
  event: DigestEvent,
  lastSummary: VillageDailySummaryPayload | undefined,
  ctx: SummaryContext = {},
): string {
  const lines = [
    `A crisis stirs the village mid-day: ${event.text}`,
    '',
  ];
  if (lastSummary) {
    lines.push('Where things stood at last reckoning:', formatPolicy(ctx.policy), ...formatDigest(lastSummary.digest), '');
  }
  lines.push(
    'Answer this now. Shift the standing priorities with set_priorities to meet it, and',
    'stage drama (spawn_entity / change_weather / plant_idea) only if a shift cannot. Call',
    'the one tool that fits — or none if the village will weather it unaided.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// v3 P4 — the god's LONG-TERM MEMORY: recall past days + distil a strategy
// ---------------------------------------------------------------------------

/**
 * Render the god's recalled experience as a block to prepend to a deliberation. It
 * leads with the standing STRATEGIC LESSON (the through-line the god carries day to
 * day), then the most similar PAST DAYS — so the macro-mind reasons from what has
 * worked here before, not just the day in front of it. Empty string when the god has
 * no memories yet (a fresh village), so the prompt reads exactly as it did pre-P4.
 */
export function buildSupervisorMemoryBlock(
  recalled: { text: string }[],
  strategy: string | null,
): string {
  if (!strategy && recalled.length === 0) return '';
  const lines = ['From your long memory of this village:'];
  if (strategy) lines.push(`- Your standing lesson: ${strategy}`);
  if (recalled.length > 0) {
    lines.push('- Days like this one, and what you did:');
    for (const r of recalled) lines.push(`    · ${r.text}`);
  }
  lines.push('Weigh this experience, but judge today on its own vitals below.', '');
  return lines.join('\n');
}

/**
 * Narrate one day's deliberation for storage in long-term memory: the situation the
 * god faced (the day's vitals + policy) and what it decided (the acts it took). Kept
 * compact and factual — this is the episodic record a future day recalls by similarity.
 */
export function buildDeliberationRecord(
  s: VillageDailySummaryPayload,
  acts: DivineAct[],
  policy?: VillagePolicy,
): string {
  const lines = [`Day ${s.day} (${s.weather}):`];
  const d = s.digest;
  if (d) {
    lines.push(
      `needs hunger ${d.needs.hunger.avg}/${d.needs.hunger.max}, thirst ${d.needs.thirst.avg}/${d.needs.thirst.max}, ` +
        `fatigue ${d.needs.fatigue.avg}/${d.needs.fatigue.max}, boredom ${d.needs.boredom.avg}/${d.needs.boredom.max}.`,
    );
    const stocks = Object.entries(d.stocks).map(([r, n]) => `${r} ${n}`);
    lines.push(`Stores: ${stocks.length > 0 ? stocks.join(', ') : 'empty'}.`);
  }
  lines.push(`${s.idleVillagers} idle of ${s.population}.`);
  const w = policy?.weights ?? {};
  const set = PRIORITIES.filter((p) => w[p] !== undefined);
  if (set.length > 0) {
    lines.push('Priorities now: ' + set.map((p) => `${p} ${w[p]!.toFixed(2)}`).join(', ') + '.');
  }
  if (acts.length > 0) {
    lines.push('I ' + acts.map((a) => a.summary).join('; ') + '.');
  } else {
    lines.push('I left the village to its own devices.');
  }
  return lines.join(' ');
}

/**
 * The strategy-reflection system prompt: the god looking back over a stretch of days
 * to distil what tends to WORK for this particular village. Asks for one short lesson,
 * not prose — a usable heuristic it can carry into tomorrow's deliberation.
 */
export function buildStrategyReflectionSystem(charter: string = DEFAULT_CHARTER): string {
  return [
    'You are the unseen god of an autonomous simulated village, thinking back over the',
    'recent days to learn how best to steer this particular people.',
    '',
    `Your charter (the spirit you watch over them with): ${charter}`,
    '',
    'You are given a log of recent days — what the village needed and how you answered',
    'with priorities and the odd act. Distil from it a SINGLE standing lesson: a concrete,',
    'reusable heuristic for steering THIS village (e.g. "this village drifts into hunger;',
    'keep food weighted high" or "raising recreation calms the restless faster than drama").',
    'Write one or two sentences, plain and practical, in your own voice. Output ONLY the',
    'lesson — no preamble, no lists, no tool calls.',
  ].join('\n');
}

/** Render the recent deliberation records as the material for a strategy reflection. */
export function buildStrategyReflectionUser(records: string[]): string {
  return [
    'Your recent days, oldest first:',
    ...records,
    '',
    'Now write the single standing lesson you draw from them.',
  ].join('\n');
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
