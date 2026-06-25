/**
 * agent/src/tools.ts
 * ---------------------------------------------------------------------------
 * Phase 3 — "The Brains". The tool contract.
 *
 * THE HARD BOUNDARY between the mind and the world. The LLM never touches the
 * game engine; the ONLY thing it is allowed to emit is one of the tool calls
 * defined here. This file is the single source of truth for:
 *
 *   1. The strict JSON Schemas the model must satisfy (`AGENT_TOOLS`).
 *   2. The typed, validated result of a tool call (`AgentDecision`).
 *   3. `parseDecision()` — the defensive gate that turns an untrusted
 *      name + input pair into an `AgentDecision`, throwing
 *      `MalformedToolCallError` on anything that doesn't fit.
 *
 * Schemas are provider-neutral (plain JSON Schema) so the same definitions feed
 * the Anthropic SDK's native tool use, an Ollama JSON request, or anything else
 * an `LLMProvider` wants to do with them. `additionalProperties: false` + a full
 * `required` list make them strict.
 * ---------------------------------------------------------------------------
 */

/** A provider-neutral JSON-Schema tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/**
 * The name of the read-only MAP tool. Unlike the action tools it does not move
 * the body or produce an `AgentDecision`; calling it makes `AgentService` hand
 * the mind the village map and ask it to decide again this same turn. Kept as a
 * constant so the service can recognise the call without string-matching.
 */
export const CONSULT_MAP_TOOL = 'consult_map';

/** The names of the new read-only lookup tools (besides the kept {@link CONSULT_MAP_TOOL}). */
export const RECALL_MEMORIES_TOOL = 'recall_memories';
export const BUILDING_GUIDE_TOOL = 'building_guide';
export const CONSTRUCTION_STATUS_TOOL = 'construction_status';
export const CART_STATUS_TOOL = 'cart_status';
export const LOOK_AT_TOOL = 'look_at';

/**
 * The READ-ONLY lookup tools. Calling one has NO effect on the world: it returns
 * information that is fed straight back to the mind, which then keeps going (calling
 * more tools or taking an action) within the SAME turn. This is the agentic loop —
 * look things up, then act on what you learned. Read calls are budget-limited per
 * turn (see `MIND_MAX_READS`) so a mind can't deliberate forever.
 */
export const READ_TOOLS: ToolDefinition[] = [
  {
    name: CONSULT_MAP_TOOL,
    description:
      'Recall the whole village layout: every building, its purpose, its centre tile, ' +
      'and its current stock. Use it to find where a place is before you walk there. ' +
      'A lookup only — it does not move you.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: RECALL_MEMORIES_TOOL,
    description:
      'Search your OWN long-term memory for a topic — a person, a promise, a place, ' +
      'something that happened. Returns the most relevant things you remember. Use it ' +
      'to ground a decision in your past ("what did I agree with Mira?") rather than ' +
      'guessing. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall, in a few words (e.g. "the harvest plan", "Bram").' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: BUILDING_GUIDE_TOOL,
    description:
      'Look up HOW a kind of building works — what it stocks, what it turns into what ' +
      '(e.g. the farm makes food from water), and whether you work it, take from it, or ' +
      'give to it. Use it before working or hauling so you act on a place correctly. ' +
      'Pass a building kind or a building id, or omit it for an overview of the whole ' +
      'village economy. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'A building kind ("greenfield") or a building id ("greenfield_1"). Omit for the whole-economy overview.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: CONSTRUCTION_STATUS_TOOL,
    description:
      'Check what the village is BUILDING: every active construction site, what it will ' +
      'become, the materials it still needs, and where to haul them — plus the cost of ' +
      'each kind of structure you could propose. Use it before propose_build or before ' +
      'hauling stone/wood to a site. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: CART_STATUS_TOOL,
    description:
      'Check the haulage FLEET: every robot-cart you can sense — at the technical depot, ' +
      'ALL of them — with its cargo, its standing order, and whether it is idle, hauling, ' +
      'or stuck waiting (and why, e.g. "the spring has no water"). Use it to spot a stalled ' +
      'cart and re-dispatch it (command_cart), or to see what is already being hauled before ' +
      'you walk a load yourself. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: LOOK_AT_TOOL,
    description:
      'Take a closer LOOK at one specific thing you can sense right now — a neighbour, a ' +
      'building, a cart, or an object — by its id, for its full detail (a building\'s exact ' +
      'stock and what it needs, a cart\'s cargo and order, a neighbour\'s state). Only works ' +
      'for something within your senses this turn. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'The id of the nearby thing to inspect (e.g. "villager_3", "tavern_1", "cart_2").' },
      },
      required: ['target_id'],
      additionalProperties: false,
    },
  },
];

/** The WORLD-CHANGING actions a villager's mind may take. Each commits an intent on the bus. */
export const ACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'reason',
    description:
      'Think privately — no one hears it and it does not move you. It does NOT end your ' +
      'turn: after thinking you must still take a real action (move, speak, work, take, ' +
      'give…) this same turn. Use sparingly, to settle a plan before acting. Prefer just ' +
      'taking the action itself.',
    input_schema: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your private thought, in your own voice.' },
      },
      required: ['thought'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_to',
    description:
      'Walk your body toward a tile (x, y). Use this to wander, approach a ' +
      'neighbour, or reach an object before interacting with it. Coordinates ' +
      'are whole-number grid tiles within the world bounds.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Destination tile X (column).' },
        y: { type: 'integer', description: 'Destination tile Y (row).' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'say',
    description:
      'Say something out loud to whoever is near you. Speech is not aimed at one ' +
      'person — every villager within earshot hears it, so this is how a group talks ' +
      'together. Only worth doing when someone is actually nearby to hear you.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What you say aloud, in your own voice.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'interact_with',
    description:
      'Interact with a nearby object (e.g. a tree) by its id. Only use this ' +
      'for an object you can currently sense.',
    input_schema: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'The id of the object to interact with.' },
      },
      required: ['object_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'work_at',
    description:
      'Work a converter to turn its stocked input into output: the farm turns water ' +
      'into food, the forge turns wood into goods. It needs input in store, so haul ' +
      'some there first if empty. You walk there if needed and keep at it until the ' +
      'output is full or the input runs out.',
    input_schema: {
      type: 'object',
      properties: {
        building_id: { type: 'string', description: 'The id of the farm or forge to work at.' },
      },
      required: ['building_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'take_from',
    description:
      'Load a resource from a building you stand beside into your backpack — water at ' +
      'the spring, wood at the grove, stone at the quarry, food at the farm, goods at ' +
      'the forge, or stores from the town hall. Fills as much as fits.',
    input_schema: {
      type: 'object',
      properties: {
        building_id: { type: 'string', description: 'The id of the building to take from.' },
        resource: {
          type: 'string',
          enum: ['water', 'food', 'wood', 'goods', 'stone'],
          description: 'Which resource to take.',
        },
      },
      required: ['building_id', 'resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_to',
    description:
      'Drop a resource you carry into a building you stand beside — water at the farm, ' +
      'wood at the forge, food/water at the town hall, goods at the tavern, or ' +
      'stone/wood/goods at a building site to raise it. Drops as much as it can hold.',
    input_schema: {
      type: 'object',
      properties: {
        building_id: { type: 'string', description: 'The id of the building to give to.' },
        resource: {
          type: 'string',
          enum: ['water', 'food', 'wood', 'goods', 'stone'],
          description: 'Which carried resource to give.',
        },
      },
      required: ['building_id', 'resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'pray_at',
    description:
      'Pray at the temple you stand beside to petition the watching god — give thanks ' +
      'and ask aloud for what the village needs. The god hears and may answer in its own way.',
    input_schema: {
      type: 'object',
      properties: {
        building_id: { type: 'string', description: 'The id of the temple to pray at.' },
        message: { type: 'string', description: 'Your prayer, in your own voice.' },
      },
      required: ['building_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_plan',
    description:
      'When gathered with others, propose a SHARED plan instead of just chatting: a ' +
      'common goal and the part YOU will take. Others can join with their own roles, ' +
      'turning a knot of neighbours into a coordinated effort. Use it to move a settled ' +
      'conversation from words into doing.',
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The shared aim in one line, e.g. "keep the forge fed and the larder full".',
        },
        kind: {
          type: 'string',
          enum: ['work', 'prayer', 'social'],
          description: 'What sort of plan: work (a chore/crew), prayer (a temple ritual), or social.',
        },
        role: { type: 'string', description: 'The part you yourself will take, in your own words.' },
      },
      required: ['goal', 'kind', 'role'],
      additionalProperties: false,
    },
  },
  {
    name: 'join_plan',
    description:
      'Commit to the shared plan your group is forming (shown to you as "your group ' +
      'is forming a plan"), taking on a role in it. Use this to throw in with what a ' +
      'neighbour has proposed rather than going your own way — then go do your part.',
    input_schema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'The part you will take in the plan, in your own words.' },
      },
      required: ['role'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_build',
    description:
      'Propose RAISING a lasting new structure the village builds together — how the ' +
      'place grows toward a city. Pick: house, well, statue, lamp, depot (a technical ' +
      'station from which ANY robot-cart can be dispatched — build one so the whole ' +
      'haulage fleet is driven from one place), handcart or freight (self-driving carts ' +
      'that haul a resource between two places), or "custom" to invent something the ' +
      'village lacks — a market, wall, granary, shrine — with a "description". Opens a ' +
      'building site at the tile you name; everyone hauls stone (and some wood/goods) to ' +
      'it until done — or set a cart to haul materials to the site. Best when the stores ' +
      'are full and others are with you to help.',
    input_schema: {
      type: 'object',
      properties: {
        structure: {
          type: 'string',
          enum: ['house', 'well', 'statue', 'lamp', 'depot', 'handcart', 'freight', 'custom'],
          description:
            'What to raise: house, well, statue, lamp, depot (cart-control station), ' +
            'handcart, freight (cart), or custom (invent your own — then give a description).',
        },
        name: {
          type: 'string',
          description: 'The name the finished structure will carry, e.g. "The Founders\' Statue".',
        },
        description: {
          type: 'string',
          description:
            'For structure "custom" ONLY: what the invented structure is and what it is ' +
            'for, e.g. "a covered market where folk trade their goods". Omit for the ' +
            'fixed kinds above.',
        },
        x: { type: 'integer', description: 'Tile X to raise it at (it will be nudged to clear ground).' },
        y: { type: 'integer', description: 'Tile Y to raise it at (it will be nudged to clear ground).' },
      },
      required: ['structure', 'name', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_to_agenda',
    description:
      'Jot onto your OWN agenda: kind "note" for an untimed reminder, or kind "event" ' +
      'for something at a set time (day_offset: 0 today, 1 tomorrow; part: morning/' +
      'afternoon/evening/night; optional place_id). Shown to you each turn; you are ' +
      'reminded as an event nears. To plan WITH others, use propose_event.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['note', 'event'],
          description: 'note = an untimed reminder; event = something fixed to a day + part of day.',
        },
        title: { type: 'string', description: 'What it is, in your own voice.' },
        day_offset: {
          type: 'integer',
          description: 'For an event: days from today (0 = today, 1 = tomorrow). Ignored for a note.',
        },
        part: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening', 'night'],
          description: 'For an event: which part of the day it happens in. Ignored for a note.',
        },
        place_id: {
          type: 'string',
          description: 'For an event: the id of the building it happens at, if anywhere in particular.',
        },
      },
      required: ['kind', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_event',
    description:
      'Propose a SHARED gathering to come (a meal, a dawn prayer, a work day) to the ' +
      'neighbours with you. Give when (day_offset, part) and optional place_id. Everyone ' +
      'present is invited and can accept_event to be drawn there when the time comes. ' +
      'Best when actually gathered with others.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the gathering is, in your own voice.' },
        day_offset: {
          type: 'integer',
          description: 'Days from today the event falls on (0 = today, 1 = tomorrow).',
        },
        part: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening', 'night'],
          description: 'Which part of the day the event happens in.',
        },
        place_id: {
          type: 'string',
          description: 'The id of the building it happens at, if anywhere in particular.',
        },
      },
      required: ['title', 'day_offset', 'part'],
      additionalProperties: false,
    },
  },
  {
    name: 'accept_event',
    description:
      'Accept an event you have been invited to (shown to you as "you are invited to …"), ' +
      'committing to attend. It joins your agenda and you will be reminded to make your way ' +
      'there as its time nears. Pass the event id.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The id of the event you are accepting.' },
      },
      required: ['event_id'],
      additionalProperties: false,
    },
  },
];

/**
 * The full tool set a villager's mind is offered: the read-only lookups first, then
 * the world-changing actions. Composed from {@link READ_TOOLS} + {@link ACTION_TOOLS}
 * so there is one source of truth for each half (the loop classifies a call by
 * {@link isReadTool}). The operate-cart tool ({@link COMMAND_CART_TOOL}) is appended
 * by the caller only on turns when a cart is actually commandable.
 */
export const AGENT_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...ACTION_TOOLS];

/** The names of all read-only lookup tools, for classifying a call in the agentic loop. */
export const READ_TOOL_NAMES: readonly string[] = READ_TOOLS.map((t) => t.name);

/** True when a tool call is a read-only lookup (feeds info back) rather than a world action. */
export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.includes(name);
}

/**
 * SOFT action tools: ones that DO commit an intent (a private thought, a note, a
 * plan/event proposal) but are not a PHYSICAL act in the world — they neither move
 * the body nor touch a building. Unlike a physical action, a soft one does NOT end
 * the agentic turn: its result is fed back and the mind keeps going, so a bit of
 * thinking or bookkeeping can't consume the whole turn while the body does nothing
 * (the observed "reason every turn, never move" stall). Budget-capped per turn by
 * the caller (`MIND_MAX_SOFT`) so a mind can't spin on them forever either.
 *
 * Tool name === decision kind for every entry, so the loop can classify by name.
 */
export const SOFT_ACTION_NAMES: readonly string[] = [
  'reason',
  'add_to_agenda',
  'propose_plan',
  'join_plan',
  'propose_event',
  'accept_event',
];

/** True when a tool call commits a soft (non-physical) action that should NOT end the turn. */
export function isSoftAction(name: string): boolean {
  return SOFT_ACTION_NAMES.includes(name);
}

/**
 * The OPERATE-CART tool. Held apart from {@link AGENT_TOOLS} and offered to the mind
 * ONLY on turns when a cart is within reach OR the villager stands at the technical
 * depot (see `AgentService.think`), so it never clutters the choice when there is no
 * cart to command — and the model only sees it when it could actually set one. Its
 * order is the single take→deposit loop the cart then runs autonomously.
 */
export const COMMAND_CART_TOOL: ToolDefinition = {
  name: 'command_cart',
  description:
    'Set the standing order of a cart: it hauls ONE resource between two places on its ' +
    'own, over and over, sparing you the round trip. You must be standing beside the cart ' +
    '— OR at the technical depot, from which you can dispatch ANY cart in the village. ' +
    'Give the cart id, the resource, the building to take FROM, and the building to give ' +
    'TO. The source must stock the resource; the destination must be a store that accepts ' +
    'it OR a construction site that still needs it (so a cart can haul materials to raise ' +
    'a build). A new order replaces the old.',
  input_schema: {
    type: 'object',
    properties: {
      cart_id: { type: 'string', description: 'The id of the cart to command (e.g. "cart_3").' },
      resource: {
        type: 'string',
        enum: ['water', 'food', 'wood', 'goods', 'stone'],
        description: 'Which single resource the cart should haul.',
      },
      from_building_id: {
        type: 'string',
        description: 'The id of the building the cart loads the resource FROM.',
      },
      to_building_id: {
        type: 'string',
        description: 'The id of the building the cart gives the resource TO.',
      },
    },
    required: ['cart_id', 'resource', 'from_building_id', 'to_building_id'],
    additionalProperties: false,
  },
};

/**
 * The validated, typed outcome of a single tool call. Narrow on `.kind`.
 *
 * The TYPE lives in `shared/types.ts` so the wire contract (telemetry envelope,
 * UI inspector) can reference it without importing villager internals; this file
 * owns the PARSER (`parseDecision`) that produces it. Re-exported so existing
 * `import { AgentDecision } from './tools'` call-sites keep working.
 */
export type { AgentDecision } from '../../shared/types';
import type { AgentDecision, AgendaPartOfDay, BuildableId, ResourceKind } from '../../shared/types';
import { isResourceKind, isBuildableId, isAgendaPartOfDay } from '../../shared/types';

/** Thrown when the model's output is not a well-formed, known tool call. */
export class MalformedToolCallError extends Error {
  constructor(
    message: string,
    /** The raw payload that failed validation, for logging. */
    readonly raw: unknown,
  ) {
    super(message);
    this.name = 'MalformedToolCallError';
  }
}

/** Narrow `unknown` to a plain object so we can probe its fields safely. */
function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MalformedToolCallError('tool input is not an object', input);
  }
  return input as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string, raw: unknown): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new MalformedToolCallError(`missing or non-string field "${key}"`, raw);
  }
  return v;
}

function requireResource(obj: Record<string, unknown>, key: string, raw: unknown): ResourceKind {
  const v = obj[key];
  if (!isResourceKind(v)) {
    throw new MalformedToolCallError(`missing or unknown resource field "${key}"`, raw);
  }
  return v;
}

const PLAN_KINDS = ['work', 'prayer', 'social'] as const;
function requirePlanKind(
  obj: Record<string, unknown>,
  key: string,
  raw: unknown,
): 'work' | 'prayer' | 'social' {
  const v = obj[key];
  if (typeof v !== 'string' || !(PLAN_KINDS as readonly string[]).includes(v)) {
    throw new MalformedToolCallError(`missing or unknown plan kind "${key}"`, raw);
  }
  return v as 'work' | 'prayer' | 'social';
}

function requireBuildable(obj: Record<string, unknown>, key: string, raw: unknown): BuildableId {
  const v = obj[key];
  if (!isBuildableId(v)) {
    throw new MalformedToolCallError(`missing or unknown buildable "${key}"`, raw);
  }
  return v;
}

function requireInt(obj: Record<string, unknown>, key: string, raw: unknown): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MalformedToolCallError(`missing or non-numeric field "${key}"`, raw);
  }
  return Math.round(v);
}

/** Read an OPTIONAL non-negative integer field, or undefined when absent. */
function optionalNonNegInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.round(v));
}

/** Read an OPTIONAL non-empty string field, or undefined when absent/blank. */
function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function requirePartOfDay(obj: Record<string, unknown>, key: string, raw: unknown): AgendaPartOfDay {
  const v = obj[key];
  if (!isAgendaPartOfDay(v)) {
    throw new MalformedToolCallError(`missing or unknown part of day "${key}"`, raw);
  }
  return v;
}

/**
 * Turn an untrusted (name, input) pair into a validated `AgentDecision`.
 *
 * Even when the provider guarantees strict schemas (Anthropic's `strict: true`),
 * this stays the last line of defence — a local LLM via Ollama makes no such
 * promise, and a defensive parse means a single bad turn is logged and skipped
 * rather than crashing the mind or publishing garbage onto the bus.
 */
export function parseDecision(name: string, input: unknown): AgentDecision {
  const obj = asRecord(input);
  switch (name) {
    case 'move_to':
      return { kind: 'move_to', x: requireInt(obj, 'x', input), y: requireInt(obj, 'y', input) };
    case 'say':
      return { kind: 'say', message: requireString(obj, 'message', input) };
    case 'reason':
      return { kind: 'reason', thought: requireString(obj, 'thought', input) };
    case 'interact_with':
      return { kind: 'interact_with', objectId: requireString(obj, 'object_id', input) };
    case 'work_at':
      return { kind: 'work_at', buildingId: requireString(obj, 'building_id', input) };
    case 'take_from':
      return {
        kind: 'take_from',
        buildingId: requireString(obj, 'building_id', input),
        resource: requireResource(obj, 'resource', input),
      };
    case 'give_to':
      return {
        kind: 'give_to',
        buildingId: requireString(obj, 'building_id', input),
        resource: requireResource(obj, 'resource', input),
      };
    case 'pray_at':
      return {
        kind: 'pray_at',
        buildingId: requireString(obj, 'building_id', input),
        message: requireString(obj, 'message', input),
      };
    case 'propose_plan':
      return {
        kind: 'propose_plan',
        goal: requireString(obj, 'goal', input),
        planKind: requirePlanKind(obj, 'kind', input),
        role: requireString(obj, 'role', input),
      };
    case 'join_plan':
      return { kind: 'join_plan', role: requireString(obj, 'role', input) };
    case 'propose_build': {
      const decision: AgentDecision = {
        kind: 'propose_build',
        structure: requireBuildable(obj, 'structure', input),
        name: requireString(obj, 'name', input),
        x: requireInt(obj, 'x', input),
        y: requireInt(obj, 'y', input),
      };
      // An invented structure carries its own description; ignored for catalog kinds.
      const description = optionalString(obj, 'description');
      if (description) decision.description = description;
      return decision;
    }
    case 'command_cart':
      return {
        kind: 'command_cart',
        cartId: requireString(obj, 'cart_id', input),
        resource: requireResource(obj, 'resource', input),
        fromBuildingId: requireString(obj, 'from_building_id', input),
        toBuildingId: requireString(obj, 'to_building_id', input),
      };
    case 'add_to_agenda': {
      const itemKind = obj.kind === 'event' ? 'event' : 'note';
      const decision: AgentDecision = {
        kind: 'add_to_agenda',
        itemKind,
        title: requireString(obj, 'title', input),
      };
      if (itemKind === 'event') {
        // A timed item needs a part of day; the day defaults to today when omitted.
        decision.partOfDay = requirePartOfDay(obj, 'part', input);
        decision.dayOffset = optionalNonNegInt(obj, 'day_offset') ?? 0;
        const placeId = optionalString(obj, 'place_id');
        if (placeId) decision.placeId = placeId;
      }
      return decision;
    }
    case 'propose_event': {
      const decision: AgentDecision = {
        kind: 'propose_event',
        title: requireString(obj, 'title', input),
        dayOffset: optionalNonNegInt(obj, 'day_offset') ?? 0,
        partOfDay: requirePartOfDay(obj, 'part', input),
      };
      const placeId = optionalString(obj, 'place_id');
      if (placeId) decision.placeId = placeId;
      return decision;
    }
    case 'accept_event':
      return { kind: 'accept_event', eventId: requireString(obj, 'event_id', input) };
    default:
      throw new MalformedToolCallError(`unknown tool "${name}"`, input);
  }
}
