# v3 — Supervisor-driven village (design doc)

Status: **draft for review** · Branch target: evolve `v2` in place · Date: 2026-06-26

This doc captures the agreed direction from the design discussion. It is the
"see clearly" artefact before any plan or code. Nothing here is built yet.

---

## 1. The problem we're fixing

The v2 "parallel minds" design ([[parallel-minds-refactor]]) gives **every
villager its own LLM**. In practice this produced:

- **No emergence** — each mind independently optimises its own local needs
  (eat / drink / sleep / work), so the village settles into *homeostasis*: a
  stable, repetitive loop. "Always the same thing."
- **Cost & a performance bottleneck** — N minds = N concurrent LLM calls; the
  endpoint pool caps how many villagers can think, so scale is limited.
- **Inconsistency** — small local models stall, loop, ignore withheld tools
  ([[commitment-stall-enforcement]]).

**Insight:** more LLM calls bought *parallel sameness*, not variety. Variety
comes from a global strategist facing a *changing, contested* world — not from
many local optimisers.

## 2. The inversion

Move the LLM **up** to the supervisor; make villagers **cheap automatons**.

```
          ┌──────────────────────────────────────────────┐
          │  SUPERVISOR  (LLM — big model, 1 per village) │
          │  • thinks PERIODICALLY + on big EVENTS        │
          │  • reads a compact WORLD DIGEST               │
          │  • outputs POLICY (priorities) + a few ORDERS │
          │  • has an evolving AGENDA + a PERSONALITY     │
          └───────────────┬──────────────────────────────┘
            policy+orders  │        ▲  digest (food low, enemy seen…)
                           ▼        │
          ┌──────────────────────────────────────────────┐
          │  VILLAGE ENGINE  (rules — fast, cheap)        │
          │  • each villager = UTILITY AI                 │
          │      score(action)=needs×traits×weights(+order)│
          │  • needs, jobs, building, movement, economy   │
          │  • templated speech · numeric affinity        │
          │  • world events / scarcity                    │
          │  • RARE villager-LLM budget for big moments   │
          └──────────────────────────────────────────────┘
                  (human can override via console)
```

**The whole trick:** one brain *steers* (sets weights, occasionally orders);
many cheap bodies *execute* hundreds of small autonomous actions. The supervisor
never micromanages pathfinding or eating.

## 3. Decisions locked in (from the design discussion)

| Topic | Decision |
|---|---|
| Why | cost/perf + clearer gameplay + reliability + kill repetition |
| Control style | **Hybrid** — standing policy drives ~90%; supervisor can issue targeted orders |
| Villager AI | **Utility AI** (score actions, pick best) |
| Supervisor cadence | **Periodic + on events** |
| Systems kept | needs, building/economy, speech, memory, social — but as **cheap derived systems** (see §4) |
| Villager LLM | **Mostly cut, small rare budget** kept for special moments (§7) |
| Variety engines | rival pressure + world events/scarcity + supervisor agenda + villager traits (all on) |
| Who is god | **LLM autonomous + human override** via existing console ([[supervisor-console-tab]]) |
| Rival village | **Exploring** — design seams now, build later; **soft competition** (no death) first |
| Rollout | **Evolve v2 in place**, runnable throughout |
| Next artefact | this design doc |

## 4. Keep the *feel*, drop the *LLM*

The kept systems were expensive only because an LLM powered each. Re-home them as
cheap derived systems; the village still feels alive at ~1–2 LLM calls total.

| System | v2 (per-villager LLM) | v3 (rule-driven) |
|---|---|---|
| **Needs** | flavoured a prompt | **drives** the utility scores — the core loop |
| **Building / economy** | LLM chose actions | utility AI auto-runs the water→food & grove→tavern chains, construction, hauling |
| **Speech** | free LLM dialogue | **templated lines** from state ("I'm starving", "Wall's up!") + supervisor/God may inject a line; rare-LLM moments can still generate real dialogue |
| **Memory** | RAG / Qdrant per villager | shrinks to **lightweight recent-events ring + relationship counters**; Qdrant likely retired |
| **Social / affinity** | LLM-flavoured relationships | **numeric affinity**, nudged by shared work / proximity / conflict, fed back into utility scores |

## 5. Supervisor I/O contract

### 5.1 What it reads — the **World Digest**
A compact, *aggregated* snapshot (NOT raw per-villager state) assembled by the
engine. Builds on `DailySummaryAggregator` but runs on the periodic/event
cadence, not only daily.

```ts
interface WorldDigest {
  day: number; partOfDay: string; weather: WeatherKind;
  population: number;
  needs: { hunger: Stat; thirst: Stat; fatigue: Stat; boredom: Stat }; // avg/max across villagers
  stocks: Record<ResourceKind, number>;        // total food/water/goods/stone…
  buildings: { kind: BuildingKind; count: number; lowStock: number }[];
  construction: { name: string; pctComplete: number }[];
  roles: Record<string, number>;               // farmers, builders, idle…
  events: DigestEvent[];                        // since last think: famine, build done, newcomer, raid…
  rival?: RivalDigest;                          // §10, when a second village exists
  vision: VillageVision;                        // current stage/milestones ([[phase10-city-ambition]])
}
type Stat = { avg: number; max: number };
```

### 5.2 What it outputs — policy + orders
Extends the existing `GOD_TOOLS` / `GodDecision` pattern in `supervisor/src/tools.ts`.
Two new primary tools, plus the existing macro tools kept as escalations.

```ts
// NEW — the standing policy (the ~90% lever)
{ kind: 'set_priorities';
  weights: Partial<Record<Priority, number>>;   // 0..1, e.g. {food:0.7, build:0.2, defense:0.1}
  rationale: string }                           // shown in UI, feeds chronicle
type Priority = 'food'|'water'|'rest'|'recreation'|'build'|'gather'|'defense'|'expand';

// NEW — targeted order (the override lever)
{ kind: 'issue_order';
  target: { villagerIds?: string[]; role?: string; count?: number }; // who
  task: 'build'|'gather'|'haul'|'guard'|'move'|'work'|'socialize';
  params: { buildingId?: string; resource?: ResourceKind; x?: number; y?: number };
  ttlTicks?: number }                            // expires; villager returns to policy

// KEPT (escalation / drama) — from current GOD_TOOLS
{ kind: 'change_weather'; … } | { kind: 'spawn_entity'; … } | { kind: 'plant_idea'; … }
```

**Orders are soft.** A villager carrying an order gets a large utility bonus for
the ordered action but still self-preserves (won't ignore starvation to obey).
Orders expire via `ttlTicks` so the village relaxes back to policy.

## 6. Utility AI (the villager brain)

Each tick (or every few ticks), per *free* villager:

```
score(action) = base_need_pressure(action)        // hunger→eat, fatigue→rest …
              × trait_modifier(villager, action)   // a "builder" weights build higher
              × supervisor_weight(action.priority) // the policy
              + order_bonus(action)                // if an active order matches
              − cost(distance, switching)          // don't thrash
pick argmax → emit the existing AgentDecision (move_to / work_at / take_from / …)
```

Key properties:
- **Reuses the existing `AgentDecision` actions** — the engine already executes
  `move_to`, `work_at`, `take_from`, `give_to`, `propose_build`, etc. The utility
  AI is a *new chooser* in front of the same effect layer. Low blast radius.
- **Hysteresis / switching cost** prevents jitter (the classic utility-AI bug).
- **Traits** give "same orders, different execution" variety (§3 variety engine).

Lives as a new `server/src/VillagerBrain.ts` (or similar), selected instead of
the LLM `AgentService` path. `MindScheduler` / endpoint pool become unused for
ordinary villagers (kept only for the rare-LLM budget, §7).

## 7. The rare villager-LLM budget

Keep a *small* path for special moments so the village can still surprise:

- A **budget/cooldown** (e.g. ≤ K villager LLM calls per in-game day, globally).
- **Triggers:** a festival, a death/crisis, a leader villager, a first contact
  with the rival, a supervisor `plant_idea`. The supervisor can also explicitly
  "spend" a moment.
- When triggered, that one villager runs a single LLM turn → real dialogue /
  a memorable choice → templated villagers react around it.

This reuses the existing `AgentService` + pool for the *one* villager, then it
drops back to the utility AI.

## 8. Cadence & human override

- **Supervisor think trigger:** a timer (every `SUPERVISOR_THINK_MS` / N in-game
  hours) **plus** an interrupt when a `DigestEvent` of high salience fires
  (famine, building complete, raid, newcomer). Mirrors the v2 heartbeat+interrupt
  idea, lifted to the supervisor.
- **Human override:** the existing `user.supervisor.*` console
  ([[supervisor-console-tab]]) gains controls to *set priorities* and *issue
  orders* directly — same contract as §5.2 — and to pause the LLM supervisor.
  LLM drives by default; human can seize the wheel.

## 9. Variety engines (anti-repetition)

All four are on; each is a seam in the design:
1. **Supervisor agenda + personality** — a charter/personality in the supervisor
   prompt; an evolving agenda persisted in its `RuntimeStateStore`. Strategy
   shifts week to week.
2. **World events / scarcity** — resource depletion, weather, disasters,
   discoveries injected as `DigestEvent`s; the engine, not just the LLM, can fire
   them.
3. **Villager traits/roles** — per-villager trait vector feeding the utility
   `trait_modifier`. Same orders → different play.
4. **Rival pressure** — §10. The strongest pump.

## 10. Rival village — soft competition (future seam)

Not built first, but the architecture must not preclude it:
- **N villages, each its own supervisor** (the supervisor service already is
  per-village-shaped — one process/charter per side).
- **Shared world, partitioned ownership** — each building/villager has a
  `villageId`. The `WorldDigest` gains a `RivalDigest` (what *this* supervisor can
  observe of the other: rough size, territory, visible activity — fog-of-war).
- **Soft competition first:** compete for shared resource nodes, claim territory,
  **raid to steal goods**, sabotage. **No death yet.** Defense priority + `guard`
  order + raid events make the conflict legible.
- **Later:** opt-in full combat (health, military roles, casualties) behind a flag.

Designing for two now mostly means: a `villageId` on entities, a per-supervisor
digest, and ownership checks in effects. We do **not** build combat in phase 1.

## 11. Migration plan (evolve v2 in place — keep it runnable)

Sketch only; a detailed phased plan is the next artefact if this doc is approved.

- **P1 — Utility brain behind a flag.** Add `VillagerBrain` (utility AI) choosing
  existing `AgentDecision`s. Feature flag `VILLAGER_BRAIN=utility|llm` so v2 still
  runs. Goal: a self-sustaining village with zero villager LLM.
- **P2 — Supervisor policy.** `set_priorities` + `WorldDigest` on the periodic
  cadence; weights feed the utility scores. Supervisor now visibly steers.
- **P3 — Orders + human override.** `issue_order` + console controls + order
  bonus/TTL in the utility AI.
- **P4 — Trim & variety.** Retire Qdrant/heavy memory; templated speech; numeric
  social; traits; world-event injectors. Rare-LLM budget wired.
- **P5 — Rival seam (optional).** `villageId` everywhere, second supervisor,
  `RivalDigest`, soft competition (raids/territory). No death.

## 12. Open questions (to resolve before/within the plan)

1. **Tick cadence for the utility AI** — every tick, or every K ticks per
   villager? (perf vs responsiveness)
2. **How granular are priorities?** the `Priority` enum above — right list?
3. **Trait model** — fixed roles, or a small numeric trait vector? how assigned
   (LLM world-gen vs deterministic)?
4. **Rare-LLM budget K** — calls/day, and exact trigger list.
5. **Templated speech** — how rich a template library; does the supervisor author
   any lines directly?
6. **Memory** — fully drop Qdrant, or keep a tiny vector store for the rare-LLM
   villagers? Likely drop.
7. **Digest size** — token budget for the supervisor prompt as population grows.

---

### Relationships
Builds on / supersedes parts of: [[parallel-minds-refactor]],
[[phase5-supervisor-and-inception]], [[phase10-city-ambition]],
[[supervisor-console-tab]], [[villager-cognitive-redesign]],
[[phase7-economy-redesign]], [[phase8-variety-and-movement]],
[[full-persistence-and-chronicle]].
