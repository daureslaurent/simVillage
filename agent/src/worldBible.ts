/**
 * agent/src/worldBible.ts
 * ---------------------------------------------------------------------------
 * The shared WORLD BIBLE — the common ground every villager is given.
 *
 * `agent/villagers.md` describes the world all minds share: how life works here,
 * the places, the manners, the rhythm of a day. It is authored prose, not code,
 * so the simulation's "setting" can be tuned without touching TypeScript — and it
 * is handed UNCHANGED to every villager, which makes it the natural, identical
 * prefix of every system prompt (good for prompt caching, and for a village whose
 * inhabitants genuinely share a world).
 *
 * Loading is best-effort: a missing or unreadable bible degrades the minds to a
 * persona-only prompt rather than failing to boot. The text is read once and the
 * result cached, so spinning up N villagers reads the file once, not N times.
 * ---------------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Where the bible lives: `VILLAGER_BIBLE_FILE`, else `agent/villagers.md`. */
function bibleFilePath(env: NodeJS.ProcessEnv): string {
  if (env.VILLAGER_BIBLE_FILE) return resolve(env.VILLAGER_BIBLE_FILE);
  const here = dirname(fileURLToPath(import.meta.url)); // .../agent/src
  return resolve(here, '..', 'villagers.md'); // .../agent/villagers.md
}

/** Memoized bible text, so N minds read the file at most once. `null` = not yet loaded. */
let cached: string | null = null;

/**
 * The shared world bible as a single string, or '' when no bible is configured or
 * the file cannot be read. Read once and cached; pass `force` to re-read (tests).
 */
export function loadWorldBible(env: NodeJS.ProcessEnv = process.env, force = false): string {
  if (cached !== null && !force) return cached;
  const path = bibleFilePath(env);
  try {
    cached = readFileSync(path, 'utf8').trim();
    console.log(`[bible] loaded shared world bible from ${path} (${cached.length} chars)`);
  } catch {
    // An explicit, mis-pointed override is worth a warning; a simply-absent
    // default file just means "run persona-only", which is fine.
    if (env.VILLAGER_BIBLE_FILE) console.warn(`[bible] world bible not found: ${path}`);
    cached = '';
  }
  return cached;
}
