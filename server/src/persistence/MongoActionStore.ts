/**
 * server/src/persistence/MongoActionStore.ts
 * ---------------------------------------------------------------------------
 * MongoDB-backed `ActionStore`. Every villager action is one document in the
 * `villager_actions` collection, appended as it happens:
 *
 *   - `record`         -> inserts one action (decision + full LLM context).
 *   - `listByVillager` -> reads a villager's recent actions, newest first,
 *                         for the left-dock roster history view.
 *
 * A compound index on `{ villagerId, tick }` keeps the per-villager listing fast
 * as the log grows. Only this file imports the `mongodb` driver.
 *
 * Two storage economies keep the log from growing heavy and without bound — both
 * invisible above the `ActionStore` seam (callers still hand over / receive whole
 * `VillagerActionRecord`s with a full `prompt.system`):
 *
 *   1. SYSTEM-PROMPT DEDUP. A villager's system prompt is ~17 KB and almost all
 *      of it — the world bible, persona, action contract and (day-stable) people-
 *      it-knows block — is identical turn after turn; only a small tail (the per-
 *      turn recalled memories and the reasoning-effort directive) changes. Storing
 *      it verbatim every turn duplicated that 17 KB ~140×/villager/day. Instead the
 *      stable PREFIX is content-hashed and kept ONCE in `system_prompts`; each
 *      action stores just the hash and its own short tail, and the full prompt is
 *      reassembled on read. A TTL on `system_prompts` (refreshed on every use)
 *      reclaims prefixes no live action references any more.
 *
 *   2. PER-VILLAGER CAP. The log is pruned on insert to the most-recent
 *      {@link MAX_ACTIONS_PER_VILLAGER} actions per villager, so a long-running
 *      village can't grow it without limit (mirroring the capped conversation log).
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'crypto';

import { MongoClient, type Collection, type Db } from 'mongodb';

import type { VillagerActionRecord } from '../../../shared/types';
import type { ActionStore } from './ActionStore';

/** How many actions a single villager listing returns by default. */
const DEFAULT_LIMIT = 200;

/** How many actions to retain per villager; older ones are pruned on insert. */
const MAX_ACTIONS_PER_VILLAGER = 500;

/** Days a deduped system prefix lingers after its last use before TTL-reaping. */
const SYSTEM_PROMPT_TTL_DAYS = 30;

/**
 * The exact line {@link composeSystemWithMemories} (agent/src/prompt/blocks.ts)
 * uses to introduce the per-turn recalled-memories block. We split the stored
 * system prompt here: everything BEFORE it is the day-stable, dedupable prefix;
 * the memory block and the trailing reasoning-effort directive are the per-turn
 * tail. If that line ever changes, the split simply finds nothing and the whole
 * prompt is treated as the (still-correct, just less-deduped) prefix.
 */
const MEMORY_BLOCK_MARKER =
  '\n\nRelevant things you remember (most relevant first) — draw on these when they';

/**
 * Stored shape: the wire record with a real Date for indexing/sorting, and with
 * the bulky `prompt.system` replaced by a reference to the deduped prefix plus the
 * action's own per-turn tail. `listByVillager` reassembles `prompt` from these.
 */
interface ActionDocument extends Omit<VillagerActionRecord, 'recordedAt' | 'prompt'> {
  recordedAt: Date;
  /** The per-turn user prompt, kept inline (it never repeats). */
  user: string;
  /** Content hash of the day-stable system prefix, kept in `system_prompts`. */
  systemHash: string;
  /** The per-turn system tail (recalled memories + effort directive), or ''. */
  systemTail: string;
}

/** One deduped, day-stable system prefix, shared by many actions. */
interface SystemPromptDocument {
  _id: string; // sha256 of `text`
  text: string;
  /** Last time an action referenced this prefix; drives the TTL reaper. */
  lastUsedAt: Date;
}

export class MongoActionStore implements ActionStore {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<ActionDocument> | null = null;
  private systemPrompts: Collection<SystemPromptDocument> | null = null;

  constructor(
    private readonly url: string,
    private readonly dbName = 'simvillage',
  ) {
    this.client = new MongoClient(this.url);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<ActionDocument>('villager_actions');
    this.systemPrompts = this.db.collection<SystemPromptDocument>('system_prompts');
    // Idempotent: createIndex is a no-op if the index already exists.
    await this.collection.createIndex({ villagerId: 1, tick: -1 });
    // Reap deduped prefixes a month after their last use (refreshed on each use).
    await this.systemPrompts.createIndex(
      { lastUsedAt: 1 },
      { expireAfterSeconds: SYSTEM_PROMPT_TTL_DAYS * 24 * 60 * 60 },
    );
    console.log(`[mongo] action log ready (${this.dbName}.villager_actions)`);
  }

  async record(action: VillagerActionRecord): Promise<void> {
    const { prefix, tail } = splitSystemPrompt(action.prompt.system);
    const systemHash = sha256(prefix);

    // Keep the shared prefix (insert once) and bump its TTL clock either way.
    await this.requireSystemPrompts().updateOne(
      { _id: systemHash },
      { $setOnInsert: { text: prefix }, $set: { lastUsedAt: new Date() } },
      { upsert: true },
    );

    const { prompt, recordedAt, ...rest } = action;
    await this.requireCollection().insertOne({
      ...rest,
      user: prompt.user,
      systemHash,
      systemTail: tail,
      recordedAt: new Date(recordedAt),
    });

    await this.pruneVillager(action.villagerId);
  }

  async listByVillager(villagerId: string, limit = DEFAULT_LIMIT): Promise<VillagerActionRecord[]> {
    const docs = await this.requireCollection()
      .find({ villagerId })
      .sort({ tick: -1 })
      .limit(limit)
      .toArray();

    // Resolve every referenced prefix in one round-trip, then reassemble `prompt`.
    // (Legacy docs predating the dedup carry no hash; they're skipped here and
    // pass their inline `prompt` straight through below.)
    const hashes = [...new Set(docs.map((d) => d.systemHash).filter(Boolean))];
    const prefixes = new Map<string, string>();
    if (hashes.length > 0) {
      const blobs = await this.requireSystemPrompts()
        .find({ _id: { $in: hashes } })
        .toArray();
      for (const b of blobs) prefixes.set(b._id, b.text);
      // Reading old actions counts as use — keep their prefixes from TTL-reaping.
      await this.requireSystemPrompts().updateMany(
        { _id: { $in: hashes } },
        { $set: { lastUsedAt: new Date() } },
      );
    }

    return docs.map(({ _id, recordedAt, user, systemHash, systemTail, ...rest }) => {
      void _id;
      // Legacy docs (pre-dedup) still carry an inline `prompt` in `rest`; keep it.
      const legacy = (rest as { prompt?: { system: string; user: string } }).prompt;
      const prompt = legacy ?? {
        system: (prefixes.get(systemHash) ?? '(system prompt expired from cache)') + (systemTail ?? ''),
        user: user ?? '',
      };
      return { ...rest, prompt, recordedAt: recordedAt.toISOString() };
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Trim this villager's log to the most-recent {@link MAX_ACTIONS_PER_VILLAGER}. */
  private async pruneVillager(villagerId: string): Promise<void> {
    const col = this.requireCollection();
    // The tick just past the retention window: anything older is dropped. (A
    // villager acts at most once per tick, so tick uniquely orders its log.)
    const boundary = await col
      .find({ villagerId })
      .sort({ tick: -1 })
      .skip(MAX_ACTIONS_PER_VILLAGER)
      .limit(1)
      .project<{ tick: number }>({ tick: 1 })
      .next();
    if (boundary) {
      await col.deleteMany({ villagerId, tick: { $lte: boundary.tick } });
    }
  }

  private requireCollection(): Collection<ActionDocument> {
    if (!this.collection) {
      throw new Error('MongoActionStore.connect() must be called before use');
    }
    return this.collection;
  }

  private requireSystemPrompts(): Collection<SystemPromptDocument> {
    if (!this.systemPrompts) {
      throw new Error('MongoActionStore.connect() must be called before use');
    }
    return this.systemPrompts;
  }
}

/** sha256 hex digest of a string. */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Split a stored system prompt into its day-stable PREFIX and per-turn TAIL at the
 * recalled-memories marker. With no memories this turn there is no marker, so the
 * whole prompt is the prefix and the tail is empty.
 */
function splitSystemPrompt(system: string): { prefix: string; tail: string } {
  const idx = system.indexOf(MEMORY_BLOCK_MARKER);
  if (idx === -1) return { prefix: system, tail: '' };
  return { prefix: system.slice(0, idx), tail: system.slice(idx) };
}
