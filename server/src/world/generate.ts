/**
 * server/src/world/generate.ts
 * ---------------------------------------------------------------------------
 * Standalone map generator. Run it to seed MongoDB with a fresh village WHEN
 * NONE EXISTS yet (the backend also auto-generates on boot, but this lets you
 * (re)generate deliberately, e.g. before a first run or after changing the
 * roster/layout):
 *
 *   npm run generate              # generate only if no world is stored yet
 *   npm run generate -- --force   # overwrite whatever is stored
 *
 * It honours the SAME GENERATE_LLM switch the backend boot does:
 *   - off (default): the hand-authored `generateSeed` + the `villagers.json` roster.
 *   - on: the map, roster and themed bible are generated with the LLM engine (it
 *     must be reachable at LLM_URL) and the roster/bible persisted to runtime state,
 *     exactly as a first boot would — so a later `docker compose up` resumes it.
 * It only touches the `world` document (+ the `generated-world` runtime key in LLM
 * mode); the action/conversation logs are left alone.
 * ---------------------------------------------------------------------------
 */

import { MongoWorldStore } from '../persistence/MongoWorldStore';
import { MongoRuntimeStateStore } from '../persistence/MongoRuntimeStateStore';
import { generateSeed } from './seed';
import { generateWorldWithLLM } from './llmGenerate';
import { loadProfiles, type CharacterProfile } from '../../../agent/src/profile';
import { HttpLLMClient } from '../../../agent/src/llm/HttpLLMClient';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/simvillage';

const GENERATE_LLM = ['1', 'true', 'yes', 'on'].includes(
  (process.env.GENERATE_LLM ?? '').trim().toLowerCase(),
);
const GENERATE_THEME = (process.env.GENERATE_THEME ?? '').trim();
const MAX_GENERATE_VILLAGERS = Math.max(1, Number(process.env.MAX_GENERATE_VILLAGERS ?? 6));
const GENERATE_RETRIES = Math.max(0, Number(process.env.GENERATE_RETRIES ?? 2));
const GENERATED_WORLD_KEY = 'generated-world';

interface GeneratedWorldState {
  profiles: CharacterProfile[];
  bible: string;
  theme: string;
  setting: string;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const store = new MongoWorldStore(MONGO_URL);
  await store.connect();
  const runtimeState = new MongoRuntimeStateStore(MONGO_URL);
  await runtimeState.connect();

  try {
    const existing = await store.loadSeed();
    const hasVillage = !!existing && Array.isArray(existing.villagers) && Array.isArray(existing.buildings);
    if (hasVillage && !force) {
      console.log('[generate] a world already exists — nothing to do (use --force to overwrite).');
      return;
    }

    if (GENERATE_LLM) {
      const llm = new HttpLLMClient({
        timeoutMs: Number(process.env.GENERATE_LLM_TIMEOUT_MS ?? 240_000),
      });
      // Curb a thinking model's deliberation (generation rides the 'plan' lane).
      llm.setEffort('plan', 'low');
      console.log(
        `[generate] generating with the LLM (theme: ${GENERATE_THEME || 'model-invented'}, up to ${MAX_GENERATE_VILLAGERS} villagers)…`,
      );
      const generated = await generateWorldWithLLM(llm, (i) => `villager_${i + 1}`, {
        theme: GENERATE_THEME,
        maxVillagers: MAX_GENERATE_VILLAGERS,
        retries: GENERATE_RETRIES,
      });
      await store.saveSeed(generated.seed);
      await runtimeState.set<GeneratedWorldState>(GENERATED_WORLD_KEY, {
        profiles: generated.profiles,
        bible: generated.bible,
        theme: generated.theme,
        setting: generated.setting,
      });
      console.log(
        `[generate] ${force && hasVillage ? 'overwrote' : 'created'} LLM village "${generated.theme}": ` +
          `${generated.seed.buildings.length} buildings, ${generated.profiles.length} villagers, ${generated.seed.trees.length} trees.`,
      );
      return;
    }

    const villagerIds = loadProfiles().map((p) => p.id);
    const seed = generateSeed({ villagerIds });
    await store.saveSeed(seed);
    console.log(
      `[generate] ${force && hasVillage ? 'overwrote' : 'created'} a village: ` +
        `${seed.buildings.length} buildings, ${seed.villagers.length} villagers, ${seed.trees.length} trees.`,
    );
  } finally {
    await runtimeState.close();
    await store.close();
  }
}

main().catch((err) => {
  console.error('[generate] failed:', err);
  process.exit(1);
});
