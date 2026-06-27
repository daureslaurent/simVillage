/**
 * agent/src/profile.ts
 * ---------------------------------------------------------------------------
 * Phase 3 — "The Brains". The Character Profile.
 *
 * A profile is the *static* identity of a villager: who they are and what they
 * want. It is the persona half of the LLM prompt — paired each turn with the
 * *dynamic* `Perception` (what they sense right now). Keeping the two apart is
 * deliberate: the profile is stable across turns (good for prompt caching and
 * for a coherent character), while perception churns every tick.
 *
 * `goal` and `status` are mutable at runtime — the mind may revise its own goal
 * and narrate its status as it acts — but everything is plain serializable data
 * so a profile can equally come from this file, an env var, or (later) Mongo.
 *
 * Personas come, in priority order, from: an explicit `VILLAGER_PROFILES` env
 * blob, a roster JSON file (default `agent/villagers.json`, override with
 * `VILLAGER_ROSTER_FILE`), then the flat `VILLAGER_*` vars, then a bland default.
 * The roster file is the easy way to give each villager a real character.
 * ---------------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { VillagerAppearance } from '../../shared/appearance';

/** The static identity + current intent of a single villager. */
export interface CharacterProfile {
  /** Must equal the villager's id in the world (e.g. "villager_1"). */
  id: string;
  /** Display name, e.g. "Bram the Baker". */
  name: string;
  /** A short, stable personality, e.g. ["curious", "cautious", "talkative"]. */
  traits: string[];
  /** What the villager is presently trying to achieve. May be revised at runtime. */
  goal: string;
  /** A one-line description of what they're doing now, e.g. "idling by the well". */
  status: string;
  /** Optional flavour the model can draw on; omitted if empty. */
  backstory?: string;
  /**
   * Which village this villager belongs to (v3 rival-village seam). Lets the mind heed only
   * its OWN god's steer from the first tick. Optional + defaulting to the single-village id
   * in the brain; set on a rival roster.
   */
  villageId?: string;
  /**
   * The villager's procedural LOOK, generated alongside the persona on an LLM
   * world build so each inhabitant is visually distinct. Carried here so it lives
   * with the rest of the identity; the seed copies it onto the villager body.
   */
  appearance?: VillagerAppearance;
}

/** A sensible default villager, used when no env-supplied profile is given. */
export function defaultProfile(id: string): CharacterProfile {
  return {
    id,
    name: `Villager ${id}`,
    traits: ['curious', 'friendly', 'industrious'],
    goal: 'Explore the village and get to know your neighbours.',
    status: 'newly arrived, looking around',
  };
}

/**
 * Build a profile from the environment, falling back to {@link defaultProfile}.
 * `VILLAGER_PROFILE` (a JSON object) wins outright if present and valid; otherwise
 * the individual `VILLAGER_NAME` / `VILLAGER_TRAITS` / `VILLAGER_GOAL` vars layer on top
 * of the default. `VILLAGER_TRAITS` is a comma-separated list.
 */
export function loadProfile(id: string, env: NodeJS.ProcessEnv = process.env): CharacterProfile {
  const base = defaultProfile(id);

  if (env.VILLAGER_PROFILE) {
    try {
      const parsed = JSON.parse(env.VILLAGER_PROFILE) as Partial<CharacterProfile>;
      // `id` always comes from the world wiring, never from the profile blob.
      return { ...base, ...parsed, id };
    } catch {
      console.warn('[villager] VILLAGER_PROFILE is not valid JSON; ignoring it');
    }
  }

  return {
    ...base,
    name: env.VILLAGER_NAME ?? base.name,
    traits: env.VILLAGER_TRAITS
      ? env.VILLAGER_TRAITS.split(',').map((t) => t.trim()).filter(Boolean)
      : base.traits,
    goal: env.VILLAGER_GOAL ?? base.goal,
    ...(env.VILLAGER_BACKSTORY ? { backstory: env.VILLAGER_BACKSTORY } : {}),
  };
}

/**
 * Resolve which villager bodies this process should give minds to. Explicit
 * `VILLAGER_IDS` (comma-separated) wins; otherwise `villager_1 .. villager_N`
 * where N is `VILLAGER_COUNT` (default 5, matching the world seed). The ids must
 * line up with the bodies the engine actually spawned, or a mind drives nothing.
 */
export function loadRosterIds(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.VILLAGER_IDS) {
    const ids = env.VILLAGER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  const count = Math.max(1, Number(env.VILLAGER_COUNT ?? 5));
  return Array.from({ length: count }, (_, i) => `villager_${i + 1}`);
}

/** Where the roster file lives: `VILLAGER_ROSTER_FILE`, else `agent/villagers.json`. */
function rosterFilePath(env: NodeJS.ProcessEnv): string {
  if (env.VILLAGER_ROSTER_FILE) return resolve(env.VILLAGER_ROSTER_FILE);
  const here = dirname(fileURLToPath(import.meta.url)); // .../agent/src
  return resolve(here, '..', 'villagers.json'); // .../agent/villagers.json
}

/**
 * Read the roster file: a JSON array of profiles, each at least an `id`. Missing
 * fields fall back to {@link defaultProfile}. Returns null when the file is
 * absent or invalid (so callers can fall back to env-driven profiles); a missing
 * default file is silent, but a bad explicit `VILLAGER_ROSTER_FILE` warns.
 */
export function loadRosterFile(env: NodeJS.ProcessEnv = process.env): CharacterProfile[] | null {
  const path = rosterFilePath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    if (env.VILLAGER_ROSTER_FILE) console.warn(`[villager] roster file not found: ${path}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Array<Partial<CharacterProfile> & { id?: string }>;
    if (!Array.isArray(parsed)) throw new Error('roster must be a JSON array');
    const profiles = parsed
      .filter((p): p is Partial<CharacterProfile> & { id: string } => typeof p?.id === 'string')
      .map((p) => ({ ...defaultProfile(p.id), ...p, id: p.id }));
    return profiles.length > 0 ? profiles : null;
  } catch {
    console.warn(`[villager] roster file ${path} is not valid JSON; ignoring it`);
    return null;
  }
}

/** Parse the optional `VILLAGER_PROFILES` env blob (id -> partial profile). */
function parseProfilesEnv(env: NodeJS.ProcessEnv): Record<string, Partial<CharacterProfile>> {
  if (!env.VILLAGER_PROFILES) return {};
  try {
    return JSON.parse(env.VILLAGER_PROFILES) as Record<string, Partial<CharacterProfile>>;
  } catch {
    console.warn('[villager] VILLAGER_PROFILES is not valid JSON; ignoring it');
    return {};
  }
}

/**
 * Build a profile for every villager in the roster. Source priority:
 *   1. the roster FILE (`agent/villagers.json` or `VILLAGER_ROSTER_FILE`) — the
 *      simplest way to give each villager a distinct character; it also defines
 *      WHICH villagers exist (their ids).
 *   2. otherwise, the env-driven roster (`VILLAGER_IDS`/`VILLAGER_COUNT`) with
 *      flat `VILLAGER_*` vars, exactly as before.
 * In either case a `VILLAGER_PROFILES` env blob can override individual entries
 * by id (handy for a quick one-off tweak without editing the file).
 */
export function loadProfiles(env: NodeJS.ProcessEnv = process.env): CharacterProfile[] {
  const overrides = parseProfilesEnv(env);
  const applyOverride = (p: CharacterProfile): CharacterProfile =>
    overrides[p.id] ? { ...p, ...overrides[p.id], id: p.id } : p;

  const fromFile = loadRosterFile(env);
  if (fromFile) return fromFile.map(applyOverride);

  return loadRosterIds(env).map((id) => {
    const override = overrides[id];
    // `id` always comes from the roster wiring, never from the override blob.
    return override ? { ...defaultProfile(id), ...override, id } : loadProfile(id, env);
  });
}
