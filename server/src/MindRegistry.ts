/**
 * server/src/MindRegistry.ts
 * ---------------------------------------------------------------------------
 * The keeper of the village's LIVE MINDS — it gives every body a brain, and
 * keeps doing so for bodies that appear AFTER boot.
 *
 * The boot sequence used to build one `AgentService` per seeded persona in a
 * fixed loop, so a villager the God Agent later `spawn_entity`s got a body but no
 * mind — it just stood there. This registry replaces that loop: it builds a mind
 * for each seeded persona, then watches the world stream and brings any NEW body
 * to life too (a spawned "Newcomer" gets a synthesized persona and starts taking
 * turns within a heartbeat). Each registered mind is handed to the
 * {@link MindScheduler}, which from then on grants it turns like any other.
 *
 * The registry also owns the live ROSTER (everyone with a brain, by id + name),
 * which it hands to each mind for the nightly relation pass — so newcomers are
 * known to their neighbours and vice-versa.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { EXCHANGES, type WorldMapUpdatedEvent } from '../../shared/events';
import type { LlmRouteHint, Relationship } from '../../shared/types';
import { AgentService } from '../../agent/src/AgentService';
import { defaultProfile, type CharacterProfile } from '../../agent/src/profile';
import { RelationshipBook } from '../../agent/src/social/RelationshipBook';
import { MemoryStream } from '../../agent/src/memory/MemoryStream';
import type { KnownPerson } from '../../agent/src/memory/MemoryStream';
import type { QdrantMemoryStore } from '../../agent/src/memory/QdrantMemoryStore';
import { SimClock } from '../../agent/src/memory/narrative';
import type { HttpLLMClient } from '../../agent/src/llm/HttpLLMClient';
import type { MindScheduler } from './MindScheduler';
import type { RuntimeStateStore } from './persistence/RuntimeStateStore';

export interface MindRegistryDeps {
  /**
   * The world bible handed to every mind. A single string for a one-village world, or a
   * resolver keyed by the villager's `villageId` so each side of a two-village world gets
   * its OWN themed bible (the LLM rival path).
   */
  bible: string | ((villageId: string | undefined) => string);
  /** The vector store backing long-term memory, or null to run minds amnesiac. */
  memoryStore: QdrantMemoryStore | null;
  /** Durable key/value store for each mind's reflected-day watermark. */
  runtimeState: RuntimeStateStore;
  /** Persisted social books by villager id, seeded into each mind's relations. */
  storedBooks: Map<string, Relationship[]>;
  /** Personas for the seeded villagers, by id. A body with no entry is a newcomer. */
  profilesById: Map<string, CharacterProfile>;
  /** Minimum gap between a mind's decisions, in ms (self-pace fallback only). */
  thinkIntervalMs: number;
  /**
   * v3 — which BRAIN every villager runs on: `'llm'` (the v2 per-villager language
   * model) or `'utility'` (the cheap rule-driven UtilityBrain, no LLM). Set
   * village-wide from `VILLAGER_BRAIN`. Defaults to `'llm'`.
   */
  villagerBrain?: 'llm' | 'utility';
  /**
   * Pool routing for a given villager (which endpoint/model its mind runs on), or
   * undefined to let the pool pick a free endpoint. This is the seam for assigning
   * villagers to specific endpoints/models vs. sharing one.
   */
  routeFor?: (villagerId: string) => LlmRouteHint | undefined;
}

export class MindRegistry {
  /** Live minds by villager id. */
  private readonly minds = new Map<string, AgentService>();
  /** Display name per live mind, for the shared roster. */
  private readonly names = new Map<string, string>();
  /** Ids whose registration is in flight, so the world watcher doesn't double-spawn a mind. */
  private readonly pending = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    /** The LLM client — provider, synthesizer (planner/reflection) and embedder in one. */
    private readonly llm: HttpLLMClient,
    private readonly scheduler: MindScheduler,
    private readonly deps: MindRegistryDeps,
  ) {}

  /** Everyone with a live brain, by id + name — the roster each mind reasons over. */
  roster(): KnownPerson[] {
    return [...this.names].map(([id, name]) => ({ id, name }));
  }

  /** True once a mind exists for this body. */
  has(id: string): boolean {
    return this.minds.has(id) || this.pending.has(id);
  }

  /**
   * Bring every seeded persona to life, then watch the world for new bodies and
   * give each one a mind too. Call after the minds' dependencies are ready and
   * before the scheduler starts granting turns.
   */
  async start(seedIds: string[]): Promise<void> {
    for (const id of seedIds) await this.register(id);
    console.log(`[registry] ${this.minds.size} villager mind(s) online`);

    // Any body that appears later (a God-spawned newcomer) gets a brain too. The
    // body is in the world before this fires; the brief gap until its mind is wired
    // is harmless — the scheduler only grants turns once we've added it.
    await this.bus.subscribe<WorldMapUpdatedEvent>(
      EXCHANGES.worldEvents,
      'world.map_updated',
      (event) => {
        for (const v of event.payload.villagers) {
          if (!this.has(v.id)) {
            // Remember the body's name for the synthesized persona, then bring it alive.
            if (v.name) this.names.set(v.id, v.name);
            void this.register(v.id);
          }
        }
      },
    );
  }

  /**
   * Build one mind for `villagerId` and register it with the scheduler. Uses the
   * seeded persona when there is one; otherwise synthesizes a newcomer persona
   * (named after the body) so a spawned villager thinks immediately. Idempotent.
   */
  async register(villagerId: string): Promise<void> {
    if (this.has(villagerId)) return;
    this.pending.add(villagerId);
    try {
      const profile = this.profileFor(villagerId);
      this.names.set(villagerId, profile.name);

      // v3 — a utility-brained villager never reasons with the LLM, so the costly
      // language-model satellites (RAG memory + nightly reflection, the daily planner)
      // are pure waste in that mode: the brain ignores their output. Switch them off so
      // the village genuinely makes ZERO villager LLM calls (design §11, P1 + §4).
      const utility = this.deps.villagerBrain === 'utility';
      const memory =
        this.deps.memoryStore && !utility
          ? new MemoryStream(villagerId, this.llm, this.deps.memoryStore, this.llm, { clock: new SimClock() })
          : undefined;
      // Restore the reflected-day watermark so a reboot during the night doesn't
      // fire a duplicate reflection for the current day.
      const reflectionKey = `reflection:${villagerId}`;
      const savedReflectedDay = await this.deps.runtimeState.get<number>(reflectionKey);
      const route = this.deps.routeFor?.(villagerId);

      const mind = new AgentService(this.bus, profile, this.llm, {
        thinkIntervalMs: this.deps.thinkIntervalMs,
        coordinated: true, // think on a granted turn from the scheduler
        ...(this.deps.villagerBrain ? { villagerBrain: this.deps.villagerBrain } : {}),
        bible:
          typeof this.deps.bible === 'function'
            ? this.deps.bible(profile.villageId)
            : this.deps.bible,
        // The daily planner is an LLM call; only the LLM brain reads its agenda.
        ...(utility ? {} : { planner: this.llm }), // sketch a daily agenda over the shared /complete seam
        relationships: new RelationshipBook(this.deps.storedBooks.get(villagerId) ?? []),
        roster: () => this.roster(),
        ...(memory ? { memory } : {}),
        ...(savedReflectedDay !== null && savedReflectedDay !== undefined
          ? { initialReflectedDay: savedReflectedDay }
          : {}),
        ...(route ? { route } : {}),
        onReflectedDay: (day) => {
          void this.deps.runtimeState.set(reflectionKey, day);
        },
      });
      await mind.start();

      this.minds.set(villagerId, mind);
      this.scheduler.add(villagerId);
    } finally {
      this.pending.delete(villagerId);
    }
  }

  /** Drop a mind so it's no longer granted turns (the body left the world). */
  unregister(villagerId: string): void {
    if (!this.minds.delete(villagerId)) return;
    this.names.delete(villagerId);
    this.scheduler.remove(villagerId);
  }

  /** The seeded persona for an id, or a synthesized newcomer persona named after the body. */
  private profileFor(villagerId: string): CharacterProfile {
    const seeded = this.deps.profilesById.get(villagerId);
    if (seeded) return seeded;
    const name = this.names.get(villagerId);
    return { ...defaultProfile(villagerId), ...(name ? { name } : {}) };
  }
}
