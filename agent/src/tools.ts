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

/** The actions a villager's mind may take, plus the read-only map lookup. */
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: CONSULT_MAP_TOOL,
    description:
      'Recall the layout of the whole village: every building with its name, ' +
      'what it is for, and the tile at its centre. Use this when you want to ' +
      'head somewhere you cannot currently see (e.g. "go to the tavern"). It ' +
      'does not move you — you will get the map and then choose your real action.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'reason',
    description:
      'Think privately to yourself — work out what to do, weigh your options, or ' +
      'make sense of what just happened. No one else hears this; it does not move ' +
      'you or speak aloud. Use it to plan before acting, and especially when talk ' +
      'has gone in circles and it is time to stop talking and decide. You take your ' +
      'real action on your next turn.',
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
      'Work at a converter to turn its stocked input into output: Greenfield (the ' +
      'farm) turns water into food, and Emberfall Forge (the workshop) turns wood ' +
      'into goods. The place needs input in its stores to convert, so haul some there ' +
      'first if it is empty. Pass the building id; you will walk there if needed and ' +
      'keep working until its output store is full or the input runs out. (Sources — ' +
      'the spring and the grove — are free to draw from with take_from, and Hall Town ' +
      'and the Tavern are stocked by hauling to them — none of those are "worked".)',
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
      'Take a resource from a nearby building into your backpack — draw water at the ' +
      'spring, gather wood at the grove, cut stone at the quarry, collect food at ' +
      'Greenfield or goods at the Forge, or pick up stores from Hall Town — so you can ' +
      'carry it where it is needed. You must be standing next to the building; you pick ' +
      'up as much as fits in your backpack.',
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
      'Give a resource you are carrying to a nearby building — drop water at ' +
      'Greenfield so it can grow food, wood at the Forge so it can craft goods, food ' +
      'and water at Hall Town so the village can eat and drink, goods at the Tavern ' +
      'so folk can enjoy them, or stone and wood at a building site to raise it. You ' +
      'must be standing next to the building and carrying that resource; you drop as ' +
      'much as the building can hold (or still needs).',
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
      'Pray at the temple to petition the watching god — ask for help, give thanks, ' +
      'or plead in hard times. You must be standing next to the temple. Your prayers ' +
      'are heard and weighed by the god, who may answer in its own way.',
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
      'When you are gathered with others, propose a SHARED plan instead of just ' +
      'chatting: a common goal for the group, and the part YOU will take in it. The ' +
      'others nearby will hear it and can join with their own roles, so a knot of ' +
      'neighbours turns into a coordinated effort — a work crew along the chains, a ' +
      'group walking to the Temple to pray together, or a gathering at the Inn. Use ' +
      'this to move a warm conversation from words into doing.',
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
      'Propose RAISING a new structure the whole village builds together — a lasting ' +
      'mark on the place, not just another chore. Choose what to raise: a "house" (a ' +
      'new home to rest in), a "well" (fresh water where it is needed), a "statue" (a ' +
      'proud monument that gladdens everyone near it), a "lamp" (a warm light that ' +
      'cheers its corner), a "handcart" (a small self-driving cart that hauls one ' +
      'resource between two places on its own), or a "freight" cart (a big one that ' +
      'moves heavy loads). It opens a building site at the spot you name; you and your ' +
      'neighbours then cut stone at the quarry (and gather wood or goods — a cart is ' +
      'built from wood and goods) and give_to the site until it is finished. A finished ' +
      'cart rolls out ready for someone to set its run with command_cart. Best proposed ' +
      'when gathered with others who can help — it becomes a shared village goal anyone can join.',
    input_schema: {
      type: 'object',
      properties: {
        structure: {
          type: 'string',
          enum: ['house', 'well', 'statue', 'lamp', 'handcart', 'freight'],
          description: 'What to raise: house, well, statue, lamp, handcart, or freight (cart).',
        },
        name: {
          type: 'string',
          description: 'The name the finished structure will carry, e.g. "The Founders\' Statue".',
        },
        x: { type: 'integer', description: 'Tile X to raise it at (it will be nudged to clear ground).' },
        y: { type: 'integer', description: 'Tile Y to raise it at (it will be nudged to clear ground).' },
      },
      required: ['structure', 'name', 'x', 'y'],
      additionalProperties: false,
    },
  },
];

/**
 * The OPERATE-CART tool. Held apart from {@link AGENT_TOOLS} and offered to the mind
 * ONLY on turns when a cart is within reach (see `AgentService.think`), so it never
 * clutters the choice when there is no cart to command — and the model only ever sees
 * it when standing beside one it could actually set. Its order is the single
 * take→deposit loop the cart then runs autonomously.
 */
export const COMMAND_CART_TOOL: ToolDefinition = {
  name: 'command_cart',
  description:
    'Set (or change) the standing order of a cart you are standing right next to. A ' +
    'cart hauls ONE resource between two places, over and over, ON ITS OWN: it drives ' +
    'to the place it takes FROM, loads up, drives to the place it gives TO, unloads, ' +
    'and repeats — sparing you the round trip. Give the cart id (shown when a cart is ' +
    'near you), the resource to haul, the building to take it FROM, and the building to ' +
    'give it TO. The source must stock that resource and the destination must accept it. ' +
    'If it waits, the source has run dry or the destination is full — it carries on once ' +
    'that clears. You must be beside the cart; setting a new order replaces the old one ' +
    'and empties whatever it was carrying.',
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
import type { AgentDecision, BuildableId, ResourceKind } from '../../shared/types';
import { isResourceKind, isBuildableId } from '../../shared/types';

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
    case 'propose_build':
      return {
        kind: 'propose_build',
        structure: requireBuildable(obj, 'structure', input),
        name: requireString(obj, 'name', input),
        x: requireInt(obj, 'x', input),
        y: requireInt(obj, 'y', input),
      };
    case 'command_cart':
      return {
        kind: 'command_cart',
        cartId: requireString(obj, 'cart_id', input),
        resource: requireResource(obj, 'resource', input),
        fromBuildingId: requireString(obj, 'from_building_id', input),
        toBuildingId: requireString(obj, 'to_building_id', input),
      };
    default:
      throw new MalformedToolCallError(`unknown tool "${name}"`, input);
  }
}
