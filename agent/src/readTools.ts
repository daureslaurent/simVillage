/**
 * agent/src/readTools.ts
 * ---------------------------------------------------------------------------
 * The READ-ONLY half of the agentic loop — the lookups a mind can perform
 * mid-turn to ground its next action, without touching the world.
 *
 * Each villager turn is now a small loop: the model may call one of these tools,
 * read the answer that comes back, and decide afresh — "look up the forge, see
 * it's out of wood, go fetch some". This module is the single place those lookups
 * are answered. Everything here is GROUNDED in what the villager could plausibly
 * know: the layout of the town it lives in, its OWN memory, general knowledge of
 * how its buildings work, and the detail of whatever it can sense right now. It
 * never reveals the live state of a place the villager isn't near.
 *
 * The result is a short, human-readable string fed straight back into the
 * transcript as a `tool` message — written for the model to read, in the same
 * plain voice as the rest of the prompt.
 * ---------------------------------------------------------------------------
 */

import type { Perception } from './sensory';
import type { MapEntry } from './sensory';
import type { RecalledMemory } from './memory/MemoryStore';
import type { BuildingKind, ResourceKind } from '../../shared/types';
import {
  BUILDABLES,
  BUILDING_FUNCTIONS,
  buildingGuideLines,
} from '../../shared/buildings';
import {
  CONSULT_MAP_TOOL,
  RECALL_MEMORIES_TOOL,
  BUILDING_GUIDE_TOOL,
  CONSTRUCTION_STATUS_TOOL,
  CART_STATUS_TOOL,
  LOOK_AT_TOOL,
} from './tools';

/** Everything a read tool needs to answer, supplied by the mind for the current turn. */
export interface ReadToolContext {
  /** This turn's local perception — what the villager senses right now. */
  perception: Perception;
  /** The whole-village layout (every building + live stock), as the villager knows its town. */
  villageMap: MapEntry[];
  /** Search the villager's long-term memory, or undefined for an amnesiac mind. */
  recall?: (query: string) => Promise<RecalledMemory[]>;
}

/** How many recalled memories to feed back for a `recall_memories` lookup. */
const RECALL_LIMIT = 5;

/**
 * Run one read-only lookup and return its answer as prose for the model. Unknown
 * tools (should never happen — the loop classifies first) yield a gentle nudge
 * rather than throwing, so a stray call can't break the turn.
 */
export async function executeReadTool(
  name: string,
  input: unknown,
  ctx: ReadToolContext,
): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case CONSULT_MAP_TOOL:
      return describeMap(ctx.villageMap);
    case RECALL_MEMORIES_TOOL:
      return recallMemories(strOf(args.query), ctx);
    case BUILDING_GUIDE_TOOL:
      return buildingGuide(strOf(args.subject), ctx);
    case CONSTRUCTION_STATUS_TOOL:
      return constructionStatus(ctx.villageMap);
    case CART_STATUS_TOOL:
      return cartStatus(ctx.perception);
    case LOOK_AT_TOOL:
      return lookAt(strOf(args.target_id), ctx.perception);
    default:
      return `There is nothing to look up with "${name}".`;
  }
}

// ---------------------------------------------------------------------------
// consult_map
// ---------------------------------------------------------------------------

function describeMap(map: MapEntry[]): string {
  if (map.length === 0) return 'You cannot picture the village layout just now.';
  const lines = map.map((e) => {
    const where = `(${e.position.x}, ${e.position.y})`;
    const stock = stockLine(e.stock, e.capacity);
    return `- ${e.name} [${e.id}] — ${e.function} — at ${where}${stock ? `; ${stock}` : ''}`;
  });
  return `The village, as you know it:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// recall_memories
// ---------------------------------------------------------------------------

async function recallMemories(query: string | undefined, ctx: ReadToolContext): Promise<string> {
  if (!query) return 'You need something to cast your mind back to — name it.';
  if (!ctx.recall) return 'Your memory is hazy; nothing in particular comes back to you.';
  let recalled: RecalledMemory[];
  try {
    recalled = await ctx.recall(query);
  } catch {
    return 'You try to remember, but nothing surfaces just now.';
  }
  if (recalled.length === 0) return `You search your memory for "${query}", but nothing comes to mind.`;
  const lines = recalled.slice(0, RECALL_LIMIT).map((m) => `- ${m.text}`);
  return `Casting your mind back to "${query}", you recall:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// building_guide
// ---------------------------------------------------------------------------

function buildingGuide(subject: string | undefined, ctx: ReadToolContext): string {
  if (!subject) return economyOverview();
  // Resolve a building id to its kind, or treat the subject as a kind directly.
  const byId = ctx.villageMap.find((e) => e.id === subject);
  const kind = (byId?.kind ?? subject) as BuildingKind;
  if (!(kind in BUILDING_FUNCTIONS)) {
    return `You don't know of a building like "${subject}". Try a kind such as "greenfield" or "workshop", or a building id.`;
  }
  return describeKind(kind);
}

function describeKind(kind: BuildingKind): string {
  // The guide prose is shared with the browser's building inspector so a place reads
  // identically wherever it's described (see shared/buildings.ts).
  return buildingGuideLines(kind).join('\n');
}

function economyOverview(): string {
  return [
    'How the village economy works — two short chains, each Source → Converter → Store:',
    '• WATER → FOOD: draw water at the spring (take_from), haul it to the fields (give_to), WORK the fields to make food, store food at the town hall.',
    '• WOOD → GOODS: gather wood at the grove (take_from), haul it to the workshop (give_to), WORK the workshop to make goods, store goods at the tavern.',
    '• BUILD: cut stone at the quarry (take_from); haul stone (and some wood/goods) to a construction site to raise a new structure.',
    'Eat food and drink water (kept at the town hall); enjoy goods at the tavern to shake off boredom; rest at a house; pray at the temple.',
    'Ask building_guide about a specific place for the detail.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// construction_status
// ---------------------------------------------------------------------------

function constructionStatus(map: MapEntry[]): string {
  const sites = map.filter((e) => e.kind === 'construction_site' && e.needs);
  const lines: string[] = [];
  if (sites.length === 0) {
    lines.push('Nothing is being built right now.');
  } else {
    lines.push('Construction underway:');
    for (const s of sites) {
      const needs = Object.entries(s.needs ?? {})
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      const where = `(${s.position.x}, ${s.position.y})`;
      lines.push(`- ${s.name} [${s.id}] at ${where} — ${needs ? `still needs ${needs}; haul it here` : 'materials complete'}`);
    }
  }
  lines.push('');
  lines.push('To propose a NEW structure (propose_build), the costs are:');
  for (const [id, b] of Object.entries(BUILDABLES)) {
    const cost = Object.entries(b.cost)
      .map(([r, n]) => `${n} ${r}`)
      .join(' + ');
    lines.push(`- ${id} (${b.label}): ${cost}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// cart_status
// ---------------------------------------------------------------------------

/**
 * Report the haulage FLEET — every cart the villager can sense this turn, with its
 * cargo, standing order, and what it is doing (idle / hauling / waiting, and why it
 * waits). Grounded in perception: standing at the technical depot (the control
 * station) the villager senses EVERY cart in the village, so this reads the whole
 * fleet; elsewhere it lists only the carts in sight. Lets a mind notice a stalled
 * cart ("waiting: the spring has no water") and re-dispatch it.
 */
function cartStatus(p: Perception): string {
  const carts = p.nearbyCarts;
  if (carts.length === 0) {
    return p.atDepot
      ? 'There are no robot-carts in the village yet — propose_build a handcart or freight cart to start a fleet.'
      : 'You cannot sense any carts from here. Stand at the technical depot to see the whole fleet at once.';
  }
  const lines: string[] = [
    p.atDepot
      ? 'The whole haulage fleet (you are at the depot — you can dispatch any of these with command_cart):'
      : 'Carts you can sense right now:',
  ];
  for (const c of carts) {
    const cargo = c.cargoResource ? `${c.cargoCount}/${c.capacity} ${c.cargoResource}` : 'empty';
    const order = c.order
      ? `hauling ${c.order.resource} ${c.order.fromName} → ${c.order.toName}`
      : 'no standing order';
    const state =
      c.phase === 'waiting' && c.waitReason
        ? `waiting (${c.waitReason})`
        : c.phase === 'idle' && !c.order
          ? 'idle — give it an order'
          : c.phase;
    const reach = c.canCommand ? '' : ` — ${c.distance} tiles off, walk closer or use the depot to command it`;
    lines.push(`- ${c.name} [${c.id}] (${c.tier}): ${cargo}; ${order}; ${state}${reach}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// look_at
// ---------------------------------------------------------------------------

function lookAt(id: string | undefined, p: Perception): string {
  if (!id) return 'Name what you want to look at.';

  const b = p.nearbyBuildings.find((x) => x.id === id);
  if (b) {
    const stock = stockLine(b.stock, b.capacity);
    const needs = b.needs
      ? ` It still needs ${Object.entries(b.needs).filter(([, n]) => (n ?? 0) > 0).map(([r, n]) => `${n} ${r}`).join(', ')} to be raised.`
      : '';
    return `${b.name} (${b.kind.replace(/_/g, ' ')}), ${b.distance} tile(s) off — ${b.function}.${stock ? ` ${stock}.` : ''}${b.empty ? ' It has run dry.' : ''}${needs}`;
  }

  const v = p.nearbyVillagers.find((x) => x.id === id);
  if (v) {
    const sense = v.canHear ? 'within earshot' : v.canSee ? 'in sight but too far to talk to' : 'barely sensed';
    return `${v.name}, ${v.distance} tile(s) away, ${sense}${v.moving ? ', on the move' : ', standing still'}.`;
  }

  const c = p.nearbyCarts.find((x) => x.id === id);
  if (c) {
    const cargo = c.cargoResource ? `carrying ${c.cargoCount}/${c.capacity} ${c.cargoResource}` : 'empty';
    const order = c.order
      ? `hauling ${c.order.resource} from ${c.order.fromName} to ${c.order.toName}`
      : 'with no standing order';
    const wait = c.waitReason ? ` (waiting: ${c.waitReason})` : '';
    return `${c.name} (${c.tier}), ${c.distance} tile(s) off — ${cargo}, ${order}, currently ${c.phase}${wait}.${c.canCommand ? ' You are close enough to set its order.' : ''}`;
  }

  const o = p.nearbyObjects.find((x) => x.id === id);
  if (o) return `A ${o.type} (${o.id}), ${o.distance} tile(s) away.`;

  return `You can't make out anything called "${id}" from where you stand.`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A compact "water 12/50 · food 3/50" stock line, or '' when the place holds nothing. */
function stockLine(stock: Partial<Record<ResourceKind, number>>, capacity: number): string {
  const parts = Object.entries(stock)
    .filter(([, n]) => n !== undefined)
    .map(([r, n]) => `${r} ${Math.round(n as number)}${capacity ? `/${capacity}` : ''}`);
  return parts.length > 0 ? parts.join(' · ') : '';
}

/** Read a non-empty string field, or undefined. */
function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
