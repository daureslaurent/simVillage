/**
 * supervisor/src/tools.ts
 * ---------------------------------------------------------------------------
 * Final Phase — "The God Agent". The macro-tool contract.
 *
 * The HARD BOUNDARY between the Supervisor's mind and the simulation. Exactly
 * like a villager (see agent/src/tools.ts), the God-Villager never touches the
 * engine or a vector DB directly — its only outlet is one of these three
 * validated tool calls, republished as a `supervisor.*` envelope:
 *
 *   spawn_entity(type, x, y)            -> engine: introduce a tree / a newcomer
 *   change_weather(type)               -> engine: set village-wide weather
 *   plant_idea(villager_id, synthetic..)  -> a villager: implant a synthetic memory
 *
 * Schemas are provider-neutral JSON Schema so the same shared LLMProvider drives
 * both the villagers and their god. `parseGodDecision()` is the defensive gate
 * that turns an untrusted (name, input) pair into a typed `GodDecision`, mirror-
 * ing the villager parser and re-checking every `enum` at runtime.
 * ---------------------------------------------------------------------------
 */

import type { ToolDefinition } from '../../agent/src/tools';
import { MalformedToolCallError } from '../../agent/src/tools';
import type { WeatherKind, Priority, OrderTask, OrderTarget, OrderParams, ResourceKind, SpawnableType } from '../../shared/types';
import { PRIORITIES, ORDER_TASKS, RESOURCE_KINDS } from '../../shared/types';

const WEATHERS: readonly WeatherKind[] = ['clear', 'rain', 'storm', 'fog', 'heatwave'];

/**
 * The god's READ-ONLY investigation tools. Calling one has NO effect on the world: it
 * returns information the god reads back into its deliberation, then keeps going (looking
 * up more, or acting on what it learned) within the SAME deliberation. This is the agentic
 * loop — INVESTIGATE before you act — that turns the god from "steer blind off the daily
 * digest" into a reasoning agent. Some are answered from the god's own held state (memory,
 * vision, policy, pending prayers); the rest query the live village read-model over the bus.
 */
export const GOD_READ_TOOLS: ToolDefinition[] = [
  {
    name: 'recall_memory',
    description:
      'Search your OWN long memory of this village for a topic — a past crisis, what you ' +
      'tried before, a recurring pattern. Returns the most relevant things you remember plus ' +
      'your standing strategic lesson. Use it to ground a decision in what has worked here ' +
      'before. A lookup only — it changes nothing.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall, in a few words (e.g. "hunger", "the restless season").' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_plan',
    description:
      'Review where the village stands on its long road to a city: its current STAGE, the ' +
      'milestones it has reached, and the standing PRIORITIES (policy weights) you are ' +
      'currently steering it with. Use it to see what you are already doing before you change ' +
      'it. A lookup only.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'list_prayers',
    description:
      'List every prayer your faithful have offered at the temple and that still awaits your ' +
      'judgement. Use it to weigh what your people are asking for before you act. A lookup only.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'list_villagers',
    description:
      'Survey your people RIGHT NOW: every villager with their needs (hunger/thirst/fatigue/' +
      'boredom), what they are doing, and whether they are idle or asleep. Use it to find who ' +
      'is suffering or wasted before you steer or order. A lookup only.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'inspect_villager',
    description:
      'Take a closer LOOK at one villager by id — their exact needs, what they are doing, what ' +
      'they carry, where they stand, whether they sleep. Use it to understand one soul before ' +
      'you whisper to them (plant_idea) or single them out in an order. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {
        villager_id: { type: 'string', description: 'The id of the villager to inspect (e.g. "villager_3").' },
      },
      required: ['villager_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_buildings',
    description:
      'Survey the village structures RIGHT NOW: each building, its kind, and its current stock ' +
      '(and which are running low). Pass a kind ("greenfield") to narrow it, or omit for all. ' +
      'Use it to see where stores sit before you raise food/gather or order a haul. A lookup only.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'A building kind to filter by (e.g. "spring", "hall_town"). Omit for every building.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'scan_rival',
    description:
      'Peer across the valley at the RIVAL village, as far as the fog of war allows — their ' +
      'rough size, how many structures, and roughly where their settlement lies. Use it before ' +
      'deciding whether to send a raiding party. Returns nothing if you have no rival. A lookup only.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

/** The macro actions the God-Villager may take. `set_priorities` is the standing policy
 *  lever (the everyday steer); the other three are the rarer dramatic interventions. */
export const GOD_ACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'set_priorities',
    description:
      'Set the village POLICY — the standing priorities every villager works to. This is ' +
      'your MAIN, everyday lever: it steers what the village spends its effort on without ' +
      'micromanaging anyone. Give a weight from 0 (ignore) to 1 (focus hard) for any of: ' +
      "food, water, rest, recreation, build, gather, defense, expand. Villagers' own " +
      'survival always comes first; these weights bias their DISCRETIONARY work. Raise ' +
      '`food` when stores run low, `build`/`gather` to grow the settlement, `recreation` ' +
      'when morale (boredom) is high. Adjust gently and explain your reasoning.',
    input_schema: {
      type: 'object',
      properties: {
        weights: {
          type: 'object',
          description: 'Priority -> weight (0..1). Include only the priorities you want to set.',
          properties: Object.fromEntries(
            PRIORITIES.map((p) => [p, { type: 'number', minimum: 0, maximum: 1 }]),
          ),
          additionalProperties: false,
        },
        rationale: {
          type: 'string',
          description: 'One sentence on why you set the village to these priorities.',
        },
      },
      required: ['weights'],
      additionalProperties: false,
    },
  },
  {
    name: 'issue_order',
    description:
      'Push specific villagers at a specific task for a while — the targeted override on ' +
      'top of the standing priorities. Use it for a focused, temporary effort: rush a ' +
      'build, haul a resource somewhere, gather wood, gather at a place. Orders are SOFT ' +
      '(a villager still tends to its own survival) and EXPIRE after `ttlTicks`, after ' +
      'which the village relaxes back to your priorities. Target by villager ids or a role ' +
      '(trait keyword); omit the target to direct the whole village. Prefer set_priorities ' +
      'for steady steering and reserve orders for a deliberate, short-lived push.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description: 'Who obeys. Omit entirely to direct everyone.',
          properties: {
            villagerIds: { type: 'array', items: { type: 'string' } },
            role: { type: 'string', description: 'A trait/role keyword, e.g. "builder".' },
            count: { type: 'integer', minimum: 1, description: 'Advisory: how many should obey.' },
          },
          additionalProperties: false,
        },
        task: { type: 'string', enum: [...ORDER_TASKS], description: 'What to do.' },
        params: {
          type: 'object',
          description: 'Specifics: a building, a resource, and/or a tile.',
          properties: {
            buildingId: { type: 'string' },
            resource: { type: 'string', enum: [...RESOURCE_KINDS] },
            x: { type: 'integer' },
            y: { type: 'integer' },
          },
          additionalProperties: false,
        },
        ttlTicks: { type: 'integer', minimum: 1, description: 'How many ticks the order lasts.' },
        rationale: { type: 'string', description: 'One sentence on why you issue this order.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'spawn_entity',
    description:
      'Introduce a new entity into the world at a tile (x, y). Spawn a "tree" to ' +
      'reshape terrain, a "villager" newcomer, or — to wage the war on your rival — a ' +
      'FORTIFICATION on your own ground: "wall" / "gate" (lay a wall as a LINE with ' +
      '`length` and `orientation`; a long wall opens a gate in its middle so your folk ' +
      'can pass), "watchtower" (spot raids early), "barracks" (rally defenders), ' +
      '"war_camp" (your raiders hit harder) or "siege_ram" (place it against a rival ' +
      'wall to batter a breach). Buildings carry life and can be destroyed. Use sparingly.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['villager', 'tree', 'wall', 'gate', 'watchtower', 'barracks', 'war_camp', 'siege_ram'],
          description: 'What to spawn.',
        },
        x: { type: 'integer', description: 'Destination tile X (column).' },
        y: { type: 'integer', description: 'Destination tile Y (row).' },
        length: {
          type: 'integer',
          description: 'For a wall/gate: how many tiles long to lay the line from (x, y). Ignored otherwise.',
        },
        orientation: {
          type: 'string',
          enum: ['h', 'v'],
          description: "For a wall line: 'h' runs east along +x, 'v' runs south along +y.",
        },
      },
      required: ['type', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'change_weather',
    description:
      'Set the village-wide weather. Weather has real effects: rain and storms ' +
      'water the crops (food grows faster) and fill the cisterns, but a storm is ' +
      'exhausting and a heatwave parches; fog dims growth. Use rain to relieve a ' +
      'food or water shortage, a storm or heatwave as a challenge, clear skies as calm.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [...WEATHERS],
          description: 'The new weather.',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'plant_idea',
    description:
      "Implant a synthetic memory into one villager's mind as if they had truly " +
      'experienced it. Write it in their first-person voice. Use this to nudge a ' +
      'story forward — a sudden conviction, a half-remembered rumour, a fear.',
    input_schema: {
      type: 'object',
      properties: {
        villager_id: { type: 'string', description: 'The id of the villager to influence.' },
        synthetic_memory: {
          type: 'string',
          description: 'The memory, first-person, e.g. "I am certain the old well is poisoned."',
        },
      },
      required: ['villager_id', 'synthetic_memory'],
      additionalProperties: false,
    },
  },
];

/**
 * The full tool set the god is offered: the read-only investigations FIRST, then the
 * world-changing acts — so a reasoning god looks before it leaps. The deliberation loop
 * classifies each call by name ({@link isReadGodTool}): a read feeds info back without
 * touching the world or the drama cool-off; an act goes through the gated `act()` path.
 */
export const GOD_TOOLS: ToolDefinition[] = [...GOD_READ_TOOLS, ...GOD_ACTION_TOOLS];

/** The names of all read-only god lookups, for classifying a call in the agentic loop. */
export const GOD_READ_TOOL_NAMES: readonly string[] = GOD_READ_TOOLS.map((t) => t.name);

/** True when a god-tool call is a read-only investigation rather than a world-changing act. */
export function isReadGodTool(name: string): boolean {
  return GOD_READ_TOOL_NAMES.includes(name);
}

/** The validated, typed outcome of a single god-tool call. Narrow on `.kind`. */
export type GodDecision =
  | { kind: 'recall_memory'; query: string }
  | { kind: 'review_plan' }
  | { kind: 'list_prayers' }
  | { kind: 'list_villagers' }
  | { kind: 'inspect_villager'; villagerId: string }
  | { kind: 'list_buildings'; buildingKind?: string }
  | { kind: 'scan_rival' }
  | { kind: 'set_priorities'; weights: Partial<Record<Priority, number>>; rationale: string }
  | {
      kind: 'issue_order';
      target: OrderTarget;
      task: OrderTask;
      params: OrderParams;
      ttlTicks?: number;
      rationale: string;
    }
  | { kind: 'spawn_entity'; entityType: SpawnableType; x: number; y: number; length?: number; orientation?: 'h' | 'v' }
  | { kind: 'change_weather'; weather: WeatherKind }
  | { kind: 'plant_idea'; villagerId: string; memory: string };

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

function requireInt(obj: Record<string, unknown>, key: string, raw: unknown): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MalformedToolCallError(`missing or non-numeric field "${key}"`, raw);
  }
  return Math.round(v);
}

/** Validate the optional `target` of an order, dropping anything malformed (→ everyone). */
function parseOrderTarget(raw: unknown, input: unknown): OrderTarget {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedToolCallError('issue_order: "target" must be an object', input);
  }
  const obj = raw as Record<string, unknown>;
  const target: OrderTarget = {};
  if (Array.isArray(obj.villagerIds)) {
    const ids = obj.villagerIds.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length > 0) target.villagerIds = ids;
  }
  if (typeof obj.role === 'string' && obj.role.length > 0) target.role = obj.role;
  if (typeof obj.count === 'number' && Number.isFinite(obj.count) && obj.count >= 1) {
    target.count = Math.floor(obj.count);
  }
  return target;
}

/** Validate the optional `params` of an order, keeping only well-formed fields. */
function parseOrderParams(raw: unknown, input: unknown): OrderParams {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedToolCallError('issue_order: "params" must be an object', input);
  }
  const obj = raw as Record<string, unknown>;
  const params: OrderParams = {};
  if (typeof obj.buildingId === 'string' && obj.buildingId.length > 0) params.buildingId = obj.buildingId;
  if (typeof obj.resource === 'string' && (RESOURCE_KINDS as readonly string[]).includes(obj.resource)) {
    params.resource = obj.resource as ResourceKind;
  }
  if (typeof obj.x === 'number' && Number.isFinite(obj.x)) params.x = Math.round(obj.x);
  if (typeof obj.y === 'number' && Number.isFinite(obj.y)) params.y = Math.round(obj.y);
  return params;
}

/**
 * Turn an untrusted (name, input) pair into a validated `GodDecision`. Even with
 * a strict-tool provider this stays the last line of defence — a local model
 * makes no such promise — so a single bad turn is logged and skipped rather than
 * publishing garbage onto the bus.
 */
export function parseGodDecision(name: string, input: unknown): GodDecision {
  const obj = asRecord(input);
  switch (name) {
    // -- read-only investigations: parse their (small) args, no world effect --
    case 'recall_memory':
      return { kind: 'recall_memory', query: requireString(obj, 'query', input) };
    case 'review_plan':
      return { kind: 'review_plan' };
    case 'list_prayers':
      return { kind: 'list_prayers' };
    case 'list_villagers':
      return { kind: 'list_villagers' };
    case 'inspect_villager':
      return { kind: 'inspect_villager', villagerId: requireString(obj, 'villager_id', input) };
    case 'list_buildings': {
      const k = obj.kind;
      return { kind: 'list_buildings', ...(typeof k === 'string' && k.length > 0 ? { buildingKind: k } : {}) };
    }
    case 'scan_rival':
      return { kind: 'scan_rival' };
    case 'set_priorities': {
      const rawWeights = obj.weights;
      if (typeof rawWeights !== 'object' || rawWeights === null || Array.isArray(rawWeights)) {
        throw new MalformedToolCallError('set_priorities: "weights" must be an object', input);
      }
      const weights: Partial<Record<Priority, number>> = {};
      for (const p of PRIORITIES) {
        const v = (rawWeights as Record<string, unknown>)[p];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new MalformedToolCallError(`set_priorities: weight for "${p}" is not a number`, input);
        }
        weights[p] = Math.max(0, Math.min(1, v)); // clamp to the 0..1 contract
      }
      if (Object.keys(weights).length === 0) {
        throw new MalformedToolCallError('set_priorities: no valid priority weights given', input);
      }
      const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
      return { kind: 'set_priorities', weights, rationale };
    }
    case 'issue_order': {
      const task = requireString(obj, 'task', input) as OrderTask;
      if (!(ORDER_TASKS as readonly string[]).includes(task)) {
        throw new MalformedToolCallError(`issue_order: unknown task "${task}"`, input);
      }
      const target = parseOrderTarget(obj.target, input);
      const params = parseOrderParams(obj.params, input);
      const ttlTicks =
        typeof obj.ttlTicks === 'number' && Number.isFinite(obj.ttlTicks) && obj.ttlTicks >= 1
          ? Math.floor(obj.ttlTicks)
          : undefined;
      const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
      return { kind: 'issue_order', target, task, params, ...(ttlTicks ? { ttlTicks } : {}), rationale };
    }
    case 'spawn_entity': {
      const type = requireString(obj, 'type', input);
      const allowed: SpawnableType[] = ['villager', 'tree', 'wall', 'gate', 'watchtower', 'barracks', 'war_camp', 'siege_ram'];
      if (!allowed.includes(type as SpawnableType)) {
        throw new MalformedToolCallError(`spawn_entity: unknown type "${type}"`, input);
      }
      const length = typeof obj.length === 'number' && Number.isFinite(obj.length) ? Math.round(obj.length) : undefined;
      const orientation = obj.orientation === 'h' || obj.orientation === 'v' ? obj.orientation : undefined;
      return {
        kind: 'spawn_entity',
        entityType: type as SpawnableType,
        x: requireInt(obj, 'x', input),
        y: requireInt(obj, 'y', input),
        ...(length !== undefined ? { length } : {}),
        ...(orientation !== undefined ? { orientation } : {}),
      };
    }
    case 'change_weather': {
      const type = requireString(obj, 'type', input);
      if (!WEATHERS.includes(type as WeatherKind)) {
        throw new MalformedToolCallError(`change_weather: unknown type "${type}"`, input);
      }
      return { kind: 'change_weather', weather: type as WeatherKind };
    }
    case 'plant_idea':
      return {
        kind: 'plant_idea',
        villagerId: requireString(obj, 'villager_id', input),
        memory: requireString(obj, 'synthetic_memory', input),
      };
    default:
      throw new MalformedToolCallError(`unknown god-tool "${name}"`, input);
  }
}
