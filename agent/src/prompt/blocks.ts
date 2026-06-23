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

import type { BuildingEvent, BuildingKind, GroupPlan, Relationship, ResourceKind, VillagerNeeds } from '../../../shared/types';
import { affinityWord } from '../social/RelationshipBook';
import { BACKPACK_CAPACITY, isResourceKind } from '../../../shared/types';
import { buildingConversion, buildingStockKinds, isSource, SERVICE_REACH } from '../../../shared/buildings';
import { formatSimDateTime, SIM_SECONDS_PER_TICK } from '../../../shared/simClock';
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
function describeStock(b: Pick<PerceivedBuilding, 'stock' | 'capacity' | 'empty'>): string | null {
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
 * The PERSONA block: who this villager is and what it is presently trying to do.
 * Terse and declarative — over-prescriptive "YOU MUST" prompting causes
 * overtriggering; stating the role plainly works better.
 */
export function personaBlock(profile: CharacterProfile): string {
  const lines = [
    `You are ${profile.name}, a villager living in the village described above.`,
    `Your personality: ${profile.traits.join(', ')}.`,
    `Your standing goal: ${profile.goal}`,
  ];
  if (profile.backstory) lines.push(`Background: ${profile.backstory}`);
  return lines.join('\n');
}

/**
 * The ACTION CONTRACT block: the one rule of acting (one tool per turn) and a
 * one-line guide to each tool. The WORLD's rules (needs, sources vs. markets, the
 * day's rhythm) are in the bible, not here — this only covers HOW you act.
 */
export function actionContractBlock(): string {
  return [
    'Each turn you take exactly one action by calling one tool. You sense only what',
    'is within a few tiles of you; act on a villager or object only once it is near.',
    '',
    'Your tools:',
    '- consult_map: recall the whole village layout — every building, what it is for,',
    '  and its centre tile. Use it to head somewhere you cannot currently see (the',
    '  spring, the grove, Greenfield, the Forge, Hall Town, the Inn). It does not move',
    '  you; you then choose your action.',
    '- move_to: walk toward a tile (x, y). Wander, explore, head to a building from',
    '  the map, or approach a neighbour or object before dealing with it.',
    '- say: speak out loud to everyone near you at once — this is how a group talks',
    '  together. Only meaningful when someone is within earshot this turn. Keep it',
    '  brief; if others just spoke, reply to what they actually said; do not greet them',
    '  again as if you had not heard.',
    '- reason: think privately to yourself — no one hears it and it does not move you.',
    '  Use it to decide what to do next, especially when a conversation is going in',
    '  circles: stop talking, reason out your plan, then carry it out on your next turn.',
    '- interact_with: use a nearby object (use its exact id).',
    '- work_at: work a converter — farm Greenfield (water→food) or the Forge (wood→',
    '  goods); you will walk there if needed and keep at it until its output is full',
    '  or its input runs out.',
    '- take_from: load water/food/wood/goods/stone from a building into your backpack (stand next to it).',
    '- give_to: drop a carried resource into a building, or stone/wood into a building site to raise it (stand next to it).',
    '- pray_at: pray at the temple to petition the Supreme God (stand next to it).',
    '  Speak your petition in the prayer — ask aloud for what the village needs; the',
    '  god hears every prayer offered at the temple and may answer by reshaping the world.',
    '- propose_plan: when gathered with others, propose a shared plan — a common goal',
    '  and the part you will take (kind: work, prayer, or social). This turns talk into',
    '  coordinated doing; the others can join. Better than agreeing to a chore aloud yet',
    '  again — propose it, then go do your part.',
    '- join_plan: throw in with the plan your group is forming, taking on a role, then',
    '  go and do it.',
    '- propose_build: rally the village to RAISE something lasting — a house, a well, a',
    '  statue, or a lamp. It opens a building site you and your neighbours haul stone',
    '  (and a little wood/goods) to until it is finished. Best when the stores are full',
    '  and you are with others who can help.',
    '',
    'Stay in character. Choose one tool every turn. Talk is cheap — when a gathering has',
    'agreed on something, turn it into a plan or an action rather than repeating it.',
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
    'Your body right now:',
    `- Hunger: ${needWord(self.needs.hunger)} (${Math.round(self.needs.hunger)}/100) — eat food you carry, or take it from Hall Town; if both are empty, food is grown at Greenfield (the farm), so go take_from there.`,
    `- Thirst: ${needWord(self.needs.thirst)} (${Math.round(self.needs.thirst)}/100) — drink water you carry, or take it from Hall Town or the spring (the spring never runs dry).`,
    `- Fatigue: ${needWord(self.needs.fatigue)} (${Math.round(self.needs.fatigue)}/100) — rest at a house.`,
    `- Boredom: ${needWord(self.needs.boredom)} (${Math.round(self.needs.boredom)}/100) — enjoy goods at the Tavern, or simply spend time among company.`,
    self.backpack.length > 0
      ? `- Backpack (${self.backpack.length}/${BACKPACK_CAPACITY} units of resources): ${summariseBackpack(self.backpack)}. You eat/drink from this first; use give_to to deliver it.`
      : `- Backpack: empty (carries up to ${BACKPACK_CAPACITY} units of water/food; take_from the spring, Greenfield, or Hall Town to fill it).`,
  ];

  const urgent = pressingNeed(self.needs);
  if (urgent) {
    lines.push('', `You feel ${urgent} — pressing enough to tend to now, before it tips into real distress: walk to the right place and relieve it, then get back to your day.`);
  } else {
    lines.push('', 'Your needs are under control — focus on your plan, your work, and the neighbours around you.');
  }
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

/** The PLAN block: what you meant to be doing about now, per this morning's agenda. */
function planBlock(plan: PlanBlock | null, theme: string | null): string[] {
  if (!plan && !theme) return [];
  const lines = ['', 'Your plan for today:'];
  if (theme) lines.push(`- Overall: ${theme}`);
  if (plan) lines.push(`- Right now (${plan.when}): ${plan.intent}`);
  lines.push('Let this guide you, but adapt freely to what is actually happening around you.');
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
    const lines = [
      '',
      `Your group has a shared plan: "${myPlan.goal}". The roles, yours among them: ${roster}.`,
    ];
    if (myPlan.kind === 'prayer') {
      lines.push(
        'This is a prayer gathering — make your way to the Temple and pray_at it with the' +
          ' others; prayer is strongest offered together.',
      );
    } else {
      lines.push('Go and carry out YOUR part now — actions, not more talk. Trust the others to theirs.');
    }
    return lines;
  }
  if (joinable) {
    const roster = joinable.members.map((m) => `${m.villagerName} (${m.role})`).join(', ');
    return [
      '',
      `Your group is forming a plan: "${joinable.goal}" (proposed by ${joinable.proposerName}; so far: ${roster}).` +
        ' You can join_plan with a role and help carry it out, or propose_plan of your own if you have a better idea.',
    ];
  }
  return [];
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
function perceptionBlock(perception: Perception, hub: SocialHub | null, groupWarm = false): string[] {
  const { self, nearbyVillagers, nearbyObjects, nearbyBuildings, nearbyCarts } = perception;
  const lines: string[] = [];

  // Gathering: tell the mind it is part of a group, so it talks to the company AND
  // turns the company into shared work — a gathering is the moment to organise an
  // errand together, not just chat.
  if (self.gathering) {
    const where = self.gathering.place ? ` at the ${self.gathering.place}` : '';
    const who = self.gathering.withNames.join(', ');
    const groupSize = self.gathering.withIds.length + 1;
    lines.push(
      '',
      `You are gathered in a group${where} with: ${who}. This is a chance to talk with` +
        ' them — greet the group, join the conversation, or pursue your goal together.' +
        ' Use say to speak to them all at once.',
    );
    if (groupWarm) {
      // The group has been together a while — the talk is warm. Push past small talk
      // toward doing something together, so a gathering becomes more than idle chatter.
      lines.push(
        'You have been together a while now and the conversation is warm — make it count.' +
          ' Suggest something concrete: an errand to share, a story to tell, or a visit' +
          ' somewhere together. Move the group from talk to doing.',
      );
    }
    if (groupSize >= 3) {
      // A real crowd: nudge toward DIVIDING the work by trade, not all doing one chore.
      lines.push(
        'You are several together now — but many hands work best spread across the chains,' +
          ' not all on one chore. A quick word to divide it up — "I will gather wood, you' +
          ' farm, you keep the cistern full" — then everyone goes to their OWN task. Put it' +
          ' to the group with say if you like, then go do your part.',
      );
    } else {
      // Just the two of you: a quieter prompt to talk or pair up on a task.
      lines.push(
        `It is just you and ${who} here. Strike up a real conversation — or suggest you` +
          ' walk together to somewhere that needs doing and share the load.',
      );
    }
  }

  const withinEarshot = nearbyVillagers.filter((a) => a.canHear);
  const seenOnly = nearbyVillagers.filter((a) => a.canSee && !a.canHear);

  if (withinEarshot.length > 0) {
    lines.push('', 'Villagers within earshot (use say and they will all hear you):');
    for (const a of withinEarshot) {
      lines.push(
        `- ${a.name} at (${a.position.x}, ${a.position.y}), ${a.distance} tile(s) away` +
          `${a.moving ? ', moving' : ', idle'}`,
      );
    }
    // Neighbours are in earshot RIGHT NOW. A word or two is good — but talk is not the
    // job. Trade a brief exchange, then get back to YOUR trade; the village runs on the
    // work, not the chatter. Don't re-greet or re-agree on a plan you have already made.
    lines.push(
      'These neighbours are within earshot now — a good moment for a word or two. If' +
        ' someone just spoke to you, reply to what they actually said. But keep it brief:' +
        ' talk is not your work. Once you have exchanged a few words — or if you have' +
        ' already agreed on a plan — stop talking and GO DO YOUR TRADE (take_from /' +
        ' work_at / give_to / pray_at). Doing the thing is worth far more than saying it' +
        ' again. Save the long talk for the Inn of an evening.',
    );
  }

  if (seenOnly.length > 0) {
    // Visible but too far for your voice to carry (dusk/fog shrink sight, a storm
    // shrinks hearing). You can see them; walk closer before trying to speak.
    lines.push('', 'In sight but too far to hear you (walk closer to talk):');
    for (const a of seenOnly) {
      lines.push(
        `- ${a.name} at (${a.position.x}, ${a.position.y}), ${a.distance} tile(s) away` +
          `${a.moving ? ', moving' : ', idle'}`,
      );
    }
  }

  if (nearbyVillagers.length === 0) {
    lines.push('', 'No other villagers are within sensing range — there is no one to speak to right now.');
    // When alone, keep villagers drawn to the shared hub so they converge and meet,
    // rather than each drifting to its own corner. Far away → head there; already
    // near → LINGER so you are on hand when someone arrives, instead of wandering off.
    if (hub) {
      const toHub = chebyshev(self.position, hub.position);
      if (toHub > 4) {
        lines.push(
          `Head toward ${hub.name} at (${hub.position.x}, ${hub.position.y}) — that is where the` +
            ' village gathers. Walk there now (unless a need is critical): it is the likeliest' +
            ' place to find a neighbour to meet and work alongside.',
        );
      } else {
        lines.push(
          `You are by ${hub.name}, where the village gathers — this is where neighbours meet.` +
            ' Stay here and potter about nearby (draw water, tidy a chore) so you are on hand' +
            ' the moment someone arrives, rather than wandering off alone.',
        );
      }
    }
  }

  if (nearbyBuildings.length > 0) {
    lines.push('', 'Places you can see (id is for work_at/take_from/give_to):');
    for (const b of nearbyBuildings) {
      const purpose = b.function ? ` — ${b.function}` : '';
      const stock = describeStock(b);
      const supply = stock ? ` [${stock}]` : '';
      // Flag a place you have already reached: re-issuing move_to its centre is a
      // wasted step — you can act on it right now. This is what breaks the "walk
      // to the building I'm already standing at, every turn" loop.
      const here = b.distance <= AT_BUILDING_REACH;
      const located = here
        ? 'right next to you — you are HERE, so work_at/take_from/give_to it now WITHOUT moving'
        : `${b.distance} tile(s) away, position (${b.position.x}, ${b.position.y})`;
      lines.push(`- ${b.name} (a ${b.kind}, id: ${b.id})${purpose}, ${located}${supply}`);
    }
  }

  if (nearbyCarts.length > 0) {
    lines.push('', 'Carts you can see (set their run with command_cart when standing beside one):');
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
          ? ` — WAITING: ${c.waitReason}`
          : c.phase === 'idle' && !c.order
            ? ' — standing idle, give it a run'
            : '';
      const located = c.canCommand
        ? 'right next to you — you are HERE, so command_cart it now WITHOUT moving'
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
    'Places in the village (you know where these are even when you cannot see them —' +
      ' move_to a place\'s coordinates to head there, over several steps if it is far):',
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

/** The resource a backpack is mostly carrying (its haul), or null if empty/mixed-empty. */
function dominantResource(backpack: string[]): ResourceKind | null {
  const counts = new Map<ResourceKind, number>();
  for (const r of backpack) if (isResourceKind(r)) counts.set(r, (counts.get(r) ?? 0) + 1);
  let best: ResourceKind | null = null;
  let bestN = 0;
  for (const [r, n] of counts) if (n > bestN) ((best = r), (bestN = n));
  return best;
}

/**
 * Where a carried resource should be DELIVERED. The economy is a chain (water →
 * Greenfield → Hall Town), so prefer a converter that consumes this resource as its
 * input (water → Greenfield, the bottleneck); otherwise the store most short of it.
 * Never the spring (you draw from it, never give to it). Null when nowhere has room.
 */
function deliveryTargetFor(resource: ResourceKind, map: MapEntry[]): MapEntry | null {
  const candidates = map.filter((e) => {
    const kind = e.kind as BuildingKind;
    if (isSource(kind)) return false; // a source (spring, grove) is drawn from, never delivered to
    if (!buildingStockKinds(kind).includes(resource)) return false;
    return (e.stock[resource] ?? 0) < e.capacity; // has room to receive
  });
  if (candidates.length === 0) return null;
  const converter = candidates.find((e) => buildingConversion(e.kind as BuildingKind)?.input === resource);
  if (converter) return converter;
  // Otherwise the emptiest store — the one most in need of this resource.
  return candidates
    .slice()
    .sort((a, b) => (a.stock[resource] ?? 0) / a.capacity - (b.stock[resource] ?? 0) / b.capacity)[0];
}

/**
 * The COMMITMENT block: a hard nudge to stop talking and act. Emitted only when the
 * mind has stalled in conversation (AgentService's commitment guard) — it overrides
 * the perception block's usual "prefer to keep talking" lean for this one turn, and
 * pairs with `say` being withheld from the tools. When the villager carries a
 * deliverable haul we name the actual destination AND its coordinates, so the forced
 * move is a real step toward Greenfield/Hall Town rather than an aimless shuffle.
 */
function commitmentBlock(perception: Perception, map: MapEntry[]): string[] {
  const backpack = perception.self.backpack;
  const resource = dominantResource(backpack);
  const target = resource && backpack.length >= BACKPACK_CAPACITY - 1 ? deliveryTargetFor(resource, map) : null;

  const open = 'You have spent several turns agreeing on a plan without acting on it. Stop talking and DO it now:';
  if (target) {
    const stock = describeStock(target);
    return [
      '',
      `${open} you are carrying ${summariseBackpack(backpack)} — take it to ${target.name} at` +
        ` (${target.position.x}, ${target.position.y})${stock ? `, which holds [${stock}]` : ''}.` +
        ` move_to those coordinates now, then give_to ${target.id} when you arrive. Do not speak this turn — move.`,
    ];
  }
  return [
    '',
    `${open} go take the next concrete step yourself — head to one of the places listed above` +
      ' (move_to its coordinates) and take_from / work_at / give_to it. Take a real step this turn — do not speak.',
  ];
}

/** Inputs to a per-turn user message, beyond the perception itself. */
export interface TurnContext {
  recentSpeech?: HeardUtterance[];
  /** The plan block governing this part of day, if any. */
  planBlock?: PlanBlock | null;
  /** The day's overall theme, if a plan exists. */
  planTheme?: string | null;
  /** The village's shared gathering place, used to steer a lone villager toward company. */
  socialHub?: SocialHub | null;
  /** Append the commitment directive (stop talking, act on the haul) for this turn. */
  commitToAction?: boolean;
  /**
   * The whole-village layout (every building with its centre tile + stock), so the
   * mind always knows where places are without first calling consult_map. Used for
   * the known-places block and to address the commitment nudge at a real destination.
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
  /**
   * True once the villager has kept the same company across several turns — the
   * conversation has warmed up, so the prompt nudges toward suggesting something
   * (an errand together, a story, a visit) rather than trading more greetings.
   */
  groupWarm?: boolean;
  /** The shared plan this villager is already a member of, if any (its part to do). */
  groupPlan?: GroupPlan | null;
  /** A plan its current company is forming that it could join, if any. */
  joinablePlan?: GroupPlan | null;
}

/** Compose the full per-turn USER message from its blocks. */
export function buildPerceptionMessage(perception: Perception, ctx: TurnContext = {}): string {
  const { self } = perception;
  const lines = [
    ...bodyBlock(perception),
    ...planBlock(ctx.planBlock ?? null, ctx.planTheme ?? null),
    // The shared agenda, right under the personal plan: what the group is doing
    // together takes precedence over drifting off alone.
    ...groupPlanBlock(ctx.groupPlan ?? null, ctx.joinablePlan ?? null),
    // The running exchange comes before the raw perception: it is the most
    // action-relevant thing this turn, and is what lets a dialogue form.
    ...conversationBlock(ctx.recentSpeech ?? []),
    // The village reference (all known places + coordinates) sits just before the
    // live perception: "everywhere I could go" then "what is actually around me now".
    ...knownPlacesBlock(ctx.villageMap ?? [], self),
    // Recent history of the places in reach, so the mind coordinates over it.
    ...buildingActivityBlock(perception.nearbyBuildings, ctx.buildingActivity ?? {}, perception.tick),
    ...perceptionBlock(perception, ctx.socialHub ?? null, ctx.groupWarm ?? false),
    // A note on last turn's fumble (if any), just before the call-to-action so it is
    // fresh in mind when the model chooses.
    ...feedbackBlock(ctx.lastSkippedReason ?? null),
  ];
  lines.push(
    '',
    'Decide your single next action and call one tool. If you are already standing at the place' +
      ' you want (a building marked HERE), act on it — work_at / take_from / give_to / say —' +
      ' rather than walking to it again. To go somewhere new, move_to a tile that is NOT your' +
      ` current position (${self.position.x}, ${self.position.y}).`,
  );
  // The commitment directive comes LAST so it is the most recent instruction the
  // model reads — overriding the perception block's usual "prefer to keep talking"
  // lean on the turn we need the villager to act on its haul instead.
  if (ctx.commitToAction) lines.push(...commitmentBlock(perception, ctx.villageMap ?? []));
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
