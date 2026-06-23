/**
 * server/src/world/generate.ts
 * ---------------------------------------------------------------------------
 * Standalone map generator. Run it to seed MongoDB with a fresh village WHEN
 * NONE EXISTS yet (the backend also auto-generates on boot, but this lets you
 * (re)generate deliberately, e.g. before a first run or after changing the
 * roster/layout):
 *
 *   npm run generate           # generate only if no world is stored yet
 *   npm run generate -- --force   # overwrite whatever is stored
 *
 * It reuses the same `generateSeed` + roster the backend uses, so the world it
 * writes is identical in shape to what boot would produce. It only touches the
 * `world` document; the action/conversation logs are left alone.
 * ---------------------------------------------------------------------------
 */

import { MongoWorldStore } from '../persistence/MongoWorldStore';
import { generateSeed } from './seed';
import { loadProfiles } from '../../../agent/src/profile';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/simvillage';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const store = new MongoWorldStore(MONGO_URL);
  await store.connect();

  try {
    const existing = await store.loadSeed();
    const hasVillage = !!existing && Array.isArray(existing.villagers) && Array.isArray(existing.buildings);
    if (hasVillage && !force) {
      console.log('[generate] a world already exists — nothing to do (use --force to overwrite).');
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
    await store.close();
  }
}

main().catch((err) => {
  console.error('[generate] failed:', err);
  process.exit(1);
});
