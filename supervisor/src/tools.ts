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
import type { WeatherKind } from '../../shared/types';

const WEATHERS: readonly WeatherKind[] = ['clear', 'rain', 'storm', 'fog', 'heatwave'];

/** The three — and only three — macro actions the God-Villager may take. */
export const GOD_TOOLS: ToolDefinition[] = [
  {
    name: 'spawn_entity',
    description:
      'Introduce a new entity into the world at a tile (x, y). Spawn a "tree" ' +
      'to reshape terrain, or an "villager" to add a newcomer the villagers will ' +
      'discover. Use sparingly, to create a challenge or an opportunity.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['villager', 'tree'], description: 'What to spawn.' },
        x: { type: 'integer', description: 'Destination tile X (column).' },
        y: { type: 'integer', description: 'Destination tile Y (row).' },
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

/** The validated, typed outcome of a single god-tool call. Narrow on `.kind`. */
export type GodDecision =
  | { kind: 'spawn_entity'; entityType: 'villager' | 'tree'; x: number; y: number }
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

/**
 * Turn an untrusted (name, input) pair into a validated `GodDecision`. Even with
 * a strict-tool provider this stays the last line of defence — a local model
 * makes no such promise — so a single bad turn is logged and skipped rather than
 * publishing garbage onto the bus.
 */
export function parseGodDecision(name: string, input: unknown): GodDecision {
  const obj = asRecord(input);
  switch (name) {
    case 'spawn_entity': {
      const type = requireString(obj, 'type', input);
      if (type !== 'villager' && type !== 'tree') {
        throw new MalformedToolCallError(`spawn_entity: unknown type "${type}"`, input);
      }
      return {
        kind: 'spawn_entity',
        entityType: type,
        x: requireInt(obj, 'x', input),
        y: requireInt(obj, 'y', input),
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
