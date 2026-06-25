/**
 * agent/src/prompt/blocks.ts
 * ---------------------------------------------------------------------------
 * The PROMPT BLOCKS — pure, provider-free builders for each piece of a villager's
 * LLM request. Each function turns one slice of state into one labelled section of
 * prose; the {@link PromptAssembler} composes them into the final system + user
 * messages. Splitting the prompt into named blocks (persona, action contract,
 * body, plan, conversation, perception) is what makes the prompt design legible
 * and tunable — you can see, and change, exactly what the model is told and in
 * what order, instead of editing one giant string.
 *
 * Division of labour across the two prompt halves:
 *   SYSTEM (stable, cache-friendly) = shared world bible + persona + action
 *     contract. The bible and contract are identical across all minds; only the
 *     persona varies — so the long, shared prefix caches well.
 *   USER (volatile, rebuilt each turn) = the in-world time, this body's needs,
 *     today's plan, the running conversation, and what is sensed right now.
 *
 * The world's RULES (needs, sources vs. markets, the rhythm of a day) live in the
 * bible (`agent/villagers.md`), NOT here — this file only describes the tools the
 * mind may call and renders the live situation. Keeping mechanics in the bible
 * means one editable source of truth, not prose duplicated across markdown + code.
 * ---------------------------------------------------------------------------
 */

import type { AgendaEvent, AgendaNote, BuildingEvent, GroupPlan, Relationship, ResourceKind, VillageVision, VillagerNeeds } from '../../../shared/types';
import { affinityWord } from '../social/RelationshipBook';
import { BACKPACK_CAPACITY } from '../../../shared/types';
import { SERVICE_REACH } from '../../../shared/buildings';
import { formatSimDateTime, simTimeFromTick, SIM_SECONDS_PER_TICK } from '../../../shared/simClock';
import type { CharacterProfile } from '../profile';
import type { MapEntry, PerceivedBuilding, Perception } from '../sensory';
import type { PlanBlock } from '../planning/DailyPlanner';
import type { Vec2 } from '../../../shared/types';

/**
 * How close (Chebyshev tiles) a building must be for the villager to count as
 * STANDING AT it — able to work_at / take_from / give_to without moving. Mirrors
 * the engine's `SERVICE_REACH` (the shared single source of truth): a building
 * within this distance is already reached, so issuing a fresh `move_to` its centre
 * tile is a wasted, no-op step.
 */
export const AT_BUILDING_REACH = SERVICE_REACH;

/** The village's shared gathering place — where lone villagers head to find company. */
export interface SocialHub {
  name: string;
  position: Vec2;
}

/**
 * One utterance this villager has recently heard within earshot — spoken directly
 * to it or overheard from a neighbour. Held in a short-term buffer by
 * `AgentService` and rendered into the per-turn prompt so the mind can actually
 * carry a conversation, rather than re-greeting blind every turn.
 */
export interface HeardUtterance {
  speakerId: string;
  /** The speaker's display name, so the running chat reads in names not ids. */
  speakerName: string;
  message: string;
  tick: number;
  /** Wall-clock ms the line was heard, used to age it out of the buffer. */
  heardAt: number;
  /** True when WE said it — kept in the buffer so we see our own side of the exchange. */
  self?: boolean;
}

/** A need at/above this reads as "critical" — the top label, real distress. */
const CRITICAL_NEED_THRESHOLD = 85;

/**
 * How high (0..100) a need must climb before it is allowed to INTERRUPT a
 * villager's work or conversation. Set at the "high" boundary so a villager tends a
 * need while it is merely high — going to relieve it before it tips into real
 * distress mid-conversation — rather than collapsing first. Day-to-day life still
 * takes precedence below this.
 */
const URGENT_NEED_THRESHOLD = 65;

/** A plain-language word for a 0..100 need level, so the model isn't reading raw numbers. */
function needWord(value: number): string {
  if (value >= CRITICAL_NEED_THRESHOLD) return 'critical';
  if (value >= URGENT_NEED_THRESHOLD) return 'high';
  if (value >= 40) return 'moderate';
  if (value >= 20) return 'mild';
  return 'fine';
}

/**
 * The single most pressing need phrased as a feeling, or null when none has yet
 * crossed {@link URGENT_NEED_THRESHOLD}; below that the villager carries on with life.
 */
function pressingNeed(needs: VillagerNeeds): string | null {
  const ranked: [keyof VillagerNeeds, string][] = [
    ['thirst', 'very thirsty'],
    ['hunger', 'very hungry'],
    ['fatigue', 'exhausted'],
    ['boredom', 'restless and dull'],
  ];
  let worst: { feeling: string; value: number } | null = null;
  for (const [key, feeling] of ranked) {
    const value = needs[key];
    if (value >= URGENT_NEED_THRESHOLD && (!worst || value > worst.value)) worst = { feeling, value };
  }
  return worst?.feeling ?? null;
}

/**
 * Render a building's resource stock as a compact phrase — e.g. "water 0/50
 * (EMPTY — needs refilling), food 31/50". Returns null for a building with no
 * resource economy, so the caller can omit a stock clause for those.
 */
function describeStock(
  b: Pick<PerceivedBuilding, 'stock' | 'capacity' | 'empty' | 'needs'>,
): string | null {
  // A construction site reads as a checklist of materials still to haul in, not as a
  // store — so the mind sees exactly what to bring (or dispatch a cart for) to raise it.
  if (b.needs) {
    const kinds = Object.keys(b.needs) as ResourceKind[];
    if (kinds.length === 0) return null;
    return kinds
      .map((r) => {
        const have = Math.round(b.stock[r] ?? 0);
        const need = b.needs![r] ?? 0;
        return have >= need ? `${r} ${have}/${need} ✓` : `needs ${need - have} more ${r} (${have}/${need})`;
      })
      .join(', ');
  }
  const kinds = Object.keys(b.stock) as ResourceKind[];
  if (kinds.length === 0) return null;
  const parts = kinds.map((r) => {
    const value = Math.round(b.stock[r] ?? 0);
    const flag = value <= 0 ? ' (EMPTY — needs refilling)' : '';
    return `${r} ${value}/${b.capacity}${flag}`;
  });
  return parts.join(', ');
}

/** Group a backpack (one array entry per unit) into "food ×3, water ×1" for the prompt. */
function summariseBackpack(backpack: string[]): string {
  const counts = new Map<string, number>();
  for (const r of backpack) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([r, n]) => `${r} ×${n}`).join(', ');
}

// ===========================================================================
// SYSTEM blocks (stable across turns)
// ===========================================================================

/**
 * The PERSONA block: who this villager is. This is the SPINE of an emergent
 * villager — behaviour is meant to flow from character, goal and memory reacting
 * to what is around it, NOT from the turn prompt telling it what to do. So this
 * block grants agency plainly: you are this person, you live as you see fit. Terse
 * and declarative — over-prescriptive "YOU MUST" prompting causes overtriggering.
 */
export function personaBlock(profile: CharacterProfile): string {
  const lines = [
    `You are ${profile.name}, a villager who lives in the village described above.`,
    `Your character: ${profile.traits.join(', ')}.`,
    `What you want: ${profile.goal}`,
  ];
  if (profile.backstory) lines.push(`Your past: ${profile.backstory}`);
  lines.push(
    '',
    'You are your own person. No one tells you what to do each moment — you decide,',
    'in character, from what you want and what is happening around you. Live this life',
    'as you see fit.',
  );
  return lines.join('\n');
}

/**
 * The ACTION CONTRACT block: the bare MECHANICS of acting — not what to do. Each
 * tool carries its own description (sent with the schemas), so this only states the
 * rules of the interface and leaves the CHOICE entirely to the villager. Deliberately
 * free of "you should": the behaviour is meant to emerge from character + situation,
 * not from a priority list handed down here.
 */
export function actionContractBlock(): string {
  return [
    'You act in the world by calling exactly ONE tool each turn. You sense only what is',
    'within a few tiles of you, and can act on a place, neighbour, or object only once it',
    'is near. The tools available to you, with their arguments, are listed for you.',
    'What you do with them is your own choice.',
  ].join('\n');
}

/**
 * Compose the full SYSTEM prompt from its blocks: the shared world bible first
 * (identical across every mind — the cache-friendly prefix), then this villager's
 * persona, then the action contract. With no bible configured the village still
 * runs persona-only.
 */
export function buildSystemPrompt(profile: CharacterProfile, bible = ''): string {
  const parts: string[] = [];
  if (bible) parts.push(bible, '', '---', '');
  parts.push(personaBlock(profile), '', actionContractBlock());
  return parts.join('\n');
}

/**
 * Fold retrieved memories into the system prompt. The persona/contract half stays
 * the stable cache prefix; recalled memories are appended after it because they
 * change every turn. With no memories this returns the system prompt unchanged.
 */
export function composeSystemWithMemories(system: string, memories: string[]): string {
  if (memories.length === 0) return system;
  return [
    system,
    '',
    'Relevant things you remember (most relevant first) — draw on these when they',
    'matter, but do not mention them mechanically:',
    ...memories.map((m) => `- ${m}`),
  ].join('\n');
}

/**
 * The PEOPLE-YOU-KNOW block: how this villager regards the neighbours it has come
 * to know, distilled from its nightly reflections. This is what makes opinions
 * actually steer behaviour — who you seek out, who you trust with a chore, whose
 * word you take. Appended to the system prompt (it changes only nightly). Empty
 * when the villager has formed no ties yet.
 */
export function relationshipsBlock(relationships: Relationship[]): string {
  if (relationships.length === 0) return '';
  const lines = [
    '',
    'People you know, and what you have come to make of them (let this colour how you',
    'treat them — seek out those you are fond of, keep your distance from those you are not):',
  ];
  for (const r of relationships) {
    const opinion = r.opinion ? ` — ${r.opinion}` : '';
    lines.push(`- ${r.otherName}: you are ${affinityWord(r.affinity)} them (${r.affinity})${opinion}`);
  }
  return lines.join('\n');
}

// ===========================================================================
// USER blocks (rebuilt every turn)
// ===========================================================================

/** A short, in-character phrase for the village weather, for the body block. */
function weatherPhrase(weather: Perception['weather']): string {
  switch (weather) {
    case 'rain':
      return 'Rain is falling — the fields drink it up and the cisterns fill.';
    case 'storm':
      return 'A storm breaks overhead — driving rain, and tiring to be out in.';
    case 'fog':
      return 'A thick fog hangs over the village, dimming the day.';
    case 'heatwave':
      return 'The air is hot and dry; thirst comes on fast.';
    case 'clear':
    default:
      return 'The skies are clear.';
  }
}

/**
 * A line on how far the villager can sense RIGHT NOW. Night and fog shorten the
 * view; a storm muffles voices. We only spell it out when reach is notably cut,
 * so the mind grasps why it cannot see/hear as far as usual and acts on it
 * (walk closer to talk, don't expect to spot a distant neighbour).
 */
function sensingPhrase(perception: Perception): string {
  const { sightRadius: sight, hearingRadius: hearing } = perception;
  const dim = sight <= 4;
  const muffled = hearing <= 4;
  if (dim && muffled) {
    return `You can barely make things out — you see about ${sight} tiles and your voice carries only ${hearing}. Keep close to others.`;
  }
  if (dim) {
    return `Your view is short right now — you can see only about ${sight} tiles. Someone could be near without your spotting them.`;
  }
  if (muffled) {
    return `The din swallows your voice — it carries only about ${hearing} tiles, so get close before you speak.`;
  }
  return `You can see about ${sight} tiles and be heard about ${hearing}.`;
}

/** The BODY block: where you are, what you're doing, your needs, your backpack. */
function bodyBlock(perception: Perception): string[] {
  const { self, tick } = perception;
  const lines = [
    `It is ${formatSimDateTime(tick)}. ${weatherPhrase(perception.weather)} You are at (${self.position.x}, ${self.position.y}).`,
    sensingPhrase(perception),
    `You are ${self.idle ? 'standing still' : 'currently walking somewhere'} (${self.status}).`,
    '',
    `Your needs (0–100): hunger ${needWord(self.needs.hunger)} (${Math.round(self.needs.hunger)}), thirst ${needWord(self.needs.thirst)} (${Math.round(self.needs.thirst)}), fatigue ${needWord(self.needs.fatigue)} (${Math.round(self.needs.fatigue)}), boredom ${needWord(self.needs.boredom)} (${Math.round(self.needs.boredom)}).`,
    self.backpack.length > 0
      ? `Backpack (${self.backpack.length}/${BACKPACK_CAPACITY}): ${summariseBackpack(self.backpack)}. You eat/drink from this first; give_to to deliver it.`
      : `Backpack: empty (holds ${BACKPACK_CAPACITY}; take_from a source to fill it).`,
  ];

  const urgent = pressingNeed(self.needs);
  if (urgent) lines.push('', `You feel ${urgent}.`);
  return lines;
}

/**
 * The FEEDBACK block: a short note when last turn's action could not be carried out,
 * so the mind self-corrects instead of repeating the same fumble. Empty when the
 * previous turn went through cleanly.
 */
function feedbackBlock(reason: string | null): string[] {
  if (!reason) return [];
  return ['', `[Last turn could not be carried out: ${reason}. Choose a different, useful action this turn.]`];
}

/**
 * The VILLAGE-VISION block: the settlement's shared, long-horizon ambition — to grow
 * from a cluster of huts into a true city — together with where it stands now (the
 * god's named stage) and the milestones reached so far. This is what keeps the
 * COLLECTIVE end-goal in front of every mind day after day, so the small daily chores
 * add up to something: when the village is at ease, the mind is nudged to build,
 * found a custom, or start a trade that grows the place. The standing ambition line is
 * always shown; the live stage and milestones appear once the god has judged them.
 */
function villageVisionBlock(vision: VillageVision | null): string[] {
  const lines = [
    '',
    'The village\'s shared dream is to grow from a cluster of huts into a city.',
  ];
  if (vision) {
    if (vision.stage) lines.push(`What it has become so far: ${vision.stage}.`);
    const recent = vision.milestones.slice(-5);
    if (recent.length > 0) {
      lines.push('Milestones on the road here (most recent last):');
      for (const m of recent) lines.push(`- ${m.text}`);
    }
  }
  return lines;
}

/** The PLAN block: what you meant to be doing about now, per this morning's agenda. */
function planBlock(plan: PlanBlock | null, theme: string | null): string[] {
  if (!plan && !theme) return [];
  const lines = ['', 'What you had in mind for today (your own plan — follow it or not):'];
  if (theme) lines.push(`- Overall: ${theme}`);
  if (plan) lines.push(`- Around now (${plan.when}): ${plan.intent}`);
  return lines;
}

/**
 * The GROUP-PLAN block: the shared agenda this villager's gathering has formed (or
 * is forming). When the villager already has a part, it is reminded to carry it
 * out; when its company is forming a plan it could join, it is offered the choice
 * to throw in or propose its own. This is what turns a knot of neighbours into a
 * coordinated effort instead of repeated greetings.
 */
function groupPlanBlock(myPlan: GroupPlan | null, joinable: GroupPlan | null): string[] {
  if (myPlan) {
    const roster = myPlan.members.map((m) => `${m.villagerName} (${m.role})`).join(', ');
    return [
      '',
      `Your group has a shared plan: "${myPlan.goal}" (${myPlan.kind}). The roles, yours among them: ${roster}.`,
    ];
  }
  if (joinable) {
    const roster = joinable.members.map((m) => `${m.villagerName} (${m.role})`).join(', ');
    return [
      '',
      `Your group is forming a plan: "${joinable.goal}" (proposed by ${joinable.proposerName}; so far: ${roster}).` +
        ' You could join_plan with a role, or not.',
    ];
  }
  return [];
}

/**
 * How close (in ticks) a scheduled event must be for the mind to be told it is
 * happening "now or very soon" and steered to its place. ~60 ticks is roughly three
 * in-world hours — near enough to set out for, far enough not to drop everything early.
 */
const AGENDA_SOON_TICKS = 60;

/** A loose, in-character "when" for an event, e.g. "tomorrow morning" / "today evening". */
function whenLabel(event: AgendaEvent, nowTick: number): string {
  const dd = event.day - simTimeFromTick(nowTick).day;
  const day = dd <= 0 ? 'today' : dd === 1 ? 'tomorrow' : `in ${dd} days`;
  return `${day} ${event.partOfDay}`;
}

/**
 * The AGENDA block: this villager's own book of intentions — the events it is
 * committed to (soonest first, with a strong nudge to head to one whose time is at
 * hand), the events it has been invited to but not yet accepted, and its untimed
 * notes. This is what turns a passing idea into something the mind actually keeps and
 * acts on across the day, rather than forgetting it the moment the turn ends.
 */
function agendaBlock(
  events: AgendaEvent[],
  invited: AgendaEvent[],
  notes: AgendaNote[],
  nowTick: number,
): string[] {
  if (events.length === 0 && invited.length === 0 && notes.length === 0) return [];
  const lines = ['', 'Your agenda — what you mean to do and where you are expected:'];

  for (const e of events) {
    const place = e.placeName ? ` at the ${e.placeName}` : '';
    const company =
      e.shared && e.participants.length > 1
        ? ` (attending: ${e.participants.map((m) => m.villagerName).join(', ')})`
        : '';
    const soon = e.scheduledTick - nowTick;
    let line = `- ${whenLabel(e, nowTick)}${place}: ${e.title}${company}`;
    if (soon <= AGENDA_SOON_TICKS) {
      line += e.placeId ? ` — its time is now (at the ${e.placeName ?? 'place'}, id: ${e.placeId}).` : ' — its time is now.';
    }
    lines.push(line);
  }

  for (const e of invited) {
    const place = e.placeName ? ` at the ${e.placeName}` : '';
    lines.push(
      `- (invited) ${whenLabel(e, nowTick)}${place}: ${e.title} — ${e.organizerName} asks you to come` +
        ` (accept_event id "${e.id}" to join).`,
    );
  }

  for (const n of notes) lines.push(`- note to self: ${n.title}`);
  return lines;
}

/** The CONVERSATION block: the running group chat, so a shared dialogue can form. */
function conversationBlock(recentSpeech: HeardUtterance[]): string[] {
  if (recentSpeech.length === 0) return [];
  const lines = ['', 'Recent talk nearby (oldest first — anyone within earshot can hear and join in):'];
  for (const u of recentSpeech) {
    if (u.self) lines.push(`- You said: "${u.message}"`);
    else lines.push(`- ${u.speakerName} said: "${u.message}"`);
  }
  return lines;
}

/** Chebyshev (king-move) distance between two tiles. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** The PERCEPTION block: the villagers, places, and objects sensed this turn. */
function perceptionBlock(perception: Perception, hub: SocialHub | null): string[] {
  const { self, nearbyVillagers, nearbyObjects, nearbyBuildings, nearbyCarts, atDepot } =
    perception;
  const lines: string[] = [];

  // Gathering: tell the mind it is part of a group, so it talks to the company AND
  // turns the company into shared work — a gathering is the moment to organise an
  // errand together, not just chat.
  if (self.gathering) {
    const where = self.gathering.place ? ` at the ${self.gathering.place}` : '';
    const who = self.gathering.withNames.join(', ');
    lines.push(
      '',
      `You are gathered${where} with: ${who} (say is heard by them all at once).`,
    );
  }

  const withinEarshot = nearbyVillagers.filter((a) => a.canHear);
  const seenOnly = nearbyVillagers.filter((a) => a.canSee && !a.canHear);

  if (withinEarshot.length > 0) {
    lines.push('', 'Villagers within earshot (they hear what you say):');
    for (const a of withinEarshot) {
      lines.push(
        `- ${a.name} at (${a.position.x}, ${a.position.y}), ${a.distance} tile(s) away` +
          `${a.moving ? ', moving' : ', idle'}`,
      );
    }
  }

  if (seenOnly.length > 0) {
    // Visible but too far for your voice to carry (dusk/fog shrink sight, a storm
    // shrinks hearing) — purely factual; what to do about it is the villager's call.
    lines.push('', 'In sight but too far to hear you:');
    for (const a of seenOnly) {
      lines.push(
        `- ${a.name} at (${a.position.x}, ${a.position.y}), ${a.distance} tile(s) away` +
          `${a.moving ? ', moving' : ', idle'}`,
      );
    }
  }

  if (nearbyVillagers.length === 0) {
    // Purely factual: no one is near. Whether to seek company, work, or wander is the
    // villager's own call — we name the hub only as a fact about where folk gather.
    lines.push('', 'No one is within sensing range.');
    if (hub) lines.push(`(${hub.name}, at (${hub.position.x}, ${hub.position.y}), is where the village tends to gather.)`);
  }

  if (nearbyBuildings.length > 0) {
    lines.push('', 'Places you can see (id is for work_at/take_from/give_to):');
    for (const b of nearbyBuildings) {
      const purpose = b.function ? ` — ${b.function}` : '';
      const stock = describeStock(b);
      const supply = stock ? ` [${stock}]` : '';
      // Flag a place already reached, factually: you stand at it (no move needed to
      // act on it). State, not instruction — what you do there is your choice.
      const here = b.distance <= AT_BUILDING_REACH;
      const located = here
        ? 'right beside you — you are standing at it (no need to move to act on it)'
        : `${b.distance} tile(s) away, position (${b.position.x}, ${b.position.y})`;
      lines.push(`- ${b.name} (a ${b.kind}, id: ${b.id})${purpose}, ${located}${supply}`);
    }
  }

  if (nearbyCarts.length > 0) {
    // At the depot a villager dispatches the WHOLE fleet from one spot; otherwise it
    // can only command a cart it is standing beside.
    lines.push(
      '',
      atDepot
        ? 'Carts you can dispatch from the depot (set any one with command_cart — no need to walk to it):'
        : 'Carts you can see:',
    );
    for (const c of nearbyCarts) {
      const load =
        c.cargoCount > 0
          ? `carrying ${c.cargoCount}/${c.capacity} ${c.cargoResource}`
          : `empty (holds ${c.capacity})`;
      const order = c.order
        ? `hauling ${c.order.resource}: ${c.order.fromName} → ${c.order.toName}`
        : 'no order yet';
      const state =
        c.phase === 'waiting' && c.waitReason
          ? ` — waiting: ${c.waitReason}`
          : c.phase === 'idle' && !c.order
            ? ' — idle, no order'
            : '';
      const located = atDepot
        ? `at (${c.position.x}, ${c.position.y}) — dispatchable from here`
        : c.canCommand
          ? 'right beside you (no need to move to command it)'
          : `${c.distance} tile(s) away, position (${c.position.x}, ${c.position.y})`;
      lines.push(`- ${c.name} (a ${c.tier} cart, id: ${c.id}), ${located} [${load}; ${order}${state}]`);
    }
  }

  if (nearbyObjects.length > 0) {
    lines.push('', 'Objects you can sense:');
    for (const o of nearbyObjects) {
      lines.push(`- ${o.id} (${o.type}) at (${o.position.x}, ${o.position.y}), ${o.distance} tile(s) away`);
    }
  }
  return lines;
}

/**
 * The KNOWN-PLACES block: the whole village laid out with each building's centre
 * tile and current stock, given EVERY turn regardless of sense range. A villager
 * knows the town it lives in — so it should never be told to "walk to Greenfield"
 * with no idea where Greenfield is. This is what lets the mind `move_to` a place it
 * cannot currently see WITHOUT first spending a turn on `consult_map` (which it
 * rarely chose to do — the root of villagers shuffling in place instead of hauling).
 */
function knownPlacesBlock(map: MapEntry[], self: Perception['self']): string[] {
  if (map.length === 0) return [];
  const lines = [
    '',
    'Places in the village (you know where these are even when you cannot see them):',
  ];
  for (const e of map) {
    const dist = chebyshev(self.position, e.position);
    const purpose = e.function ? ` — ${e.function}` : '';
    const stock = describeStock(e);
    const supply = stock ? ` [${stock}]` : '';
    lines.push(
      `- ${e.name} (a ${e.kind}, id: ${e.id})${purpose}, at (${e.position.x}, ${e.position.y}),` +
        ` ~${dist} tile(s) away${supply}`,
    );
  }
  return lines;
}

/** A rough "X ago" for how long back an event happened, from a sim-tick delta. */
function agoLabel(deltaTicks: number): string {
  const seconds = Math.max(0, deltaTicks) * SIM_SECONDS_PER_TICK;
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Turn one structured building event into a short human line for the prompt. */
function narrateBuildingEvent(e: BuildingEvent): string {
  const who = e.actorName ? e.actorName.split(/\s+/)[0] : 'someone';
  switch (e.kind) {
    case 'take':
      return `${who} took ${e.amount} ${e.resource}`;
    case 'give':
      return `${who} brought ${e.amount} ${e.resource}`;
    case 'work_started':
      return `${who} started working here`;
    case 'work_finished':
      return `${who} ${e.note ?? 'finished working'}`;
    case 'work_refused':
      return `${who} could not work — ${e.note ?? 'nothing to do'}`;
    case 'depleted':
      return `ran out of ${e.resource}`;
    case 'filled':
      return `${e.resource} store is full`;
    case 'site_opened':
      return `${who} began a building project${e.note ? ` (${e.note})` : ''}`;
    case 'completed':
      return `${who} finished building this${e.note ? ` — ${e.note}` : ''}`;
  }
}

/**
 * The BUILDING ACTIVITY block: the recent history of the places we can sense right
 * now, so the mind coordinates over what's been done (don't re-haul water a
 * neighbour just brought; see WHY a work attempt was refused; notice a farm that's
 * been dry a while). Only the last few events per building, newest last.
 */
function buildingActivityBlock(
  nearby: PerceivedBuilding[],
  activity: Record<string, BuildingEvent[]>,
  nowTick: number,
): string[] {
  const lines: string[] = [];
  for (const b of nearby) {
    const events = activity[b.id];
    if (!events || events.length === 0) continue;
    if (lines.length === 0) lines.push('', 'Recent activity at places you can sense:');
    lines.push(`- ${b.name}:`);
    for (const e of events.slice(-5)) {
      lines.push(`    ${agoLabel(nowTick - e.tick)} — ${narrateBuildingEvent(e)}`);
    }
  }
  return lines;
}

/** Inputs to a per-turn user message, beyond the perception itself. */
export interface TurnContext {
  recentSpeech?: HeardUtterance[];
  /** The village's shared vision (ambition + named stage + milestones), if known. */
  villageVision?: VillageVision | null;
  /** The plan block governing this part of day, if any. */
  planBlock?: PlanBlock | null;
  /** The day's overall theme, if a plan exists. */
  planTheme?: string | null;
  /** The village's shared gathering place, named (as a fact) when the villager is alone. */
  socialHub?: SocialHub | null;
  /**
   * The whole-village layout (every building with its centre tile + stock), so the
   * mind always knows where places are without first calling consult_map. Used for
   * the known-places block.
   */
  villageMap?: MapEntry[];
  /**
   * Recent activity of the buildings the villager can sense, keyed by building id —
   * so the mind reasons over what's been done at a place (and why a work attempt was
   * refused). Only nearby buildings with events appear.
   */
  buildingActivity?: Record<string, BuildingEvent[]>;
  /**
   * Why last turn's chosen action could not be carried out (no one in earshot, a
   * redundant move, a malformed call), if anything — rendered as a short note so the
   * mind corrects course this turn rather than repeating the same fumble blind.
   */
  lastSkippedReason?: string | null;
  /** The shared plan this villager is already a member of, if any (its part to do). */
  groupPlan?: GroupPlan | null;
  /** A plan its current company is forming that it could join, if any. */
  joinablePlan?: GroupPlan | null;
  /** Scheduled events this villager is attending (personal or shared), soonest first. */
  agendaEvents?: AgendaEvent[];
  /** Events this villager has been invited to but not yet accepted, soonest first. */
  agendaInvited?: AgendaEvent[];
  /** This villager's untimed agenda notes, newest first. */
  agendaNotes?: AgendaNote[];
  /**
   * Salient things that happened AROUND this villager since it last acted —
   * accumulated across the many world ticks between thoughts (a neighbour it
   * passed, someone coming within earshot, arriving somewhere, a need turning
   * urgent). Lets a mind react to what it would otherwise have missed by only
   * seeing a single snapshot at think-time. Newest last.
   */
  recentEvents?: string[];
}

/**
 * What changed around the villager between its last thought and this one, as a
 * short bulleted recap. Empty when nothing notable happened (the block is omitted).
 */
function recentEventsBlock(events: string[]): string[] {
  if (events.length === 0) return [];
  const lines = ['', 'Since you last acted, around you:'];
  for (const e of events.slice(-8)) lines.push(`- ${e}`);
  return lines;
}

/** Compose the full per-turn USER message from its blocks. */
export function buildPerceptionMessage(perception: Perception, ctx: TurnContext = {}): string {
  const { self } = perception;
  const lines = [
    ...bodyBlock(perception),
    // The shared long-horizon ambition (grow into a city) + how far the village has
    // come, just under the body so the collective goal frames the day's plan below it.
    ...villageVisionBlock(ctx.villageVision ?? null),
    ...planBlock(ctx.planBlock ?? null, ctx.planTheme ?? null),
    // The shared agenda, right under the personal plan: what the group is doing
    // together takes precedence over drifting off alone.
    ...groupPlanBlock(ctx.groupPlan ?? null, ctx.joinablePlan ?? null),
    // This villager's own agenda — kept commitments, invitations, and notes — so a
    // scheduled event actually pulls it there when the hour comes.
    ...agendaBlock(
      ctx.agendaEvents ?? [],
      ctx.agendaInvited ?? [],
      ctx.agendaNotes ?? [],
      perception.tick,
    ),
    // What happened around us since the last thought (encounters, arrivals, needs
    // turning urgent) — placed just above the live conversation so the mind reacts
    // to events it would otherwise have missed between snapshots.
    ...recentEventsBlock(ctx.recentEvents ?? []),
    // The running exchange comes before the raw perception: it is the most
    // action-relevant thing this turn, and is what lets a dialogue form.
    ...conversationBlock(ctx.recentSpeech ?? []),
    // The village reference (all known places + coordinates) sits just before the
    // live perception: "everywhere I could go" then "what is actually around me now".
    ...knownPlacesBlock(ctx.villageMap ?? [], self),
    // Recent history of the places in reach, so the mind coordinates over it.
    ...buildingActivityBlock(perception.nearbyBuildings, ctx.buildingActivity ?? {}, perception.tick),
    ...perceptionBlock(perception, ctx.socialHub ?? null),
    // A neutral note on why last turn's action did not land (if any), so the mind has
    // the fact and can decide afresh — not an instruction on what to do instead.
    ...feedbackBlock(ctx.lastSkippedReason ?? null),
  ];
  // A bare, neutral close that explains the agentic LOOP without steering the
  // choice: look things up if you need to, then act — possibly more than once —
  // and stop when you are done. No priorities, no "you should"; the choice is the
  // villager's, which is the whole point of an emergent sim.
  lines.push(
    '',
    'It is your move. You may first LOOK THINGS UP with the read-only tools ' +
      '(consult_map, recall_memories, building_guide, construction_status, cart_status, look_at) — ' +
      'their answers come back to you and cost no time in the world. Then ACT by calling ' +
      'an action tool; you may take more than one action in a row if it makes sense (e.g. ' +
      'take a resource, then work). When you have nothing more to do this moment, simply ' +
      'stop calling tools.',
  );
  return lines.join('\n');
}

/**
 * A terse, embeddable description of "what is happening to me right now", used as
 * the similarity-search query for memory recall. Focuses on the salient actors so
 * the query vector lands near memories about those actors.
 */
export function buildSituationQuery(perception: Perception): string {
  const { self, nearbyVillagers, nearbyObjects, nearbyBuildings } = perception;
  const urgent = pressingNeed(self.needs);
  const need = urgent ? `I am ${urgent}. ` : '';
  if (nearbyVillagers.length === 0 && nearbyObjects.length === 0 && nearbyBuildings.length === 0) {
    return `${need}I am alone, wandering the village with nothing nearby.`;
  }
  const parts: string[] = [];
  for (const a of nearbyVillagers) {
    parts.push(`${a.name} is ${a.distance} tile(s) away and ${a.moving ? 'approaching' : 'standing near'} me`);
  }
  for (const b of nearbyBuildings) {
    parts.push(`the ${b.name} (${b.kind}) is ${b.distance} tile(s) away`);
  }
  for (const o of nearbyObjects) {
    parts.push(`there is a ${o.type} (${o.id}) ${o.distance} tile(s) away`);
  }
  return need + parts.join('; ') + '.';
}

/**
 * The result handed back to a mind that called `consult_map`: the whole village
 * as compact JSON (name, function, kind, centre position), then a nudge to choose
 * a real action. Rendered as JSON on purpose — reference data the model can read
 * positions straight out of for a `move_to`.
 */
export function buildVillageMapMessage(entries: MapEntry[]): string {
  if (entries.length === 0) {
    return 'You picture the village, but you cannot recall any landmarks. Choose your next action.';
  }
  const json = entries.map((e) => {
    const stock = describeStock(e);
    return {
      id: e.id,
      name: e.name,
      function: e.function,
      kind: e.kind,
      position: e.position,
      ...(stock ? { stock } : {}),
    };
  });
  return [
    'You recall the village layout (JSON — `id` is for work_at/take_from/give_to,',
    '`position` is the tile to walk to; `stock` shows a place\'s resources, "EMPTY"',
    'means it has run dry and needs resources hauled in):',
    JSON.stringify(json, null, 2),
    '',
    'Now decide your single next action and call one tool (e.g. move_to one of these positions).',
  ].join('\n');
}
