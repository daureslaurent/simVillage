/**
 * agent/src/brain/UtilityBrain.ts
 * ---------------------------------------------------------------------------
 * v3 — "The inversion" (design doc §6). A villager's brain WITHOUT an LLM.
 *
 * The v2 village gave every villager its own language model. That bought
 * parallel SAMENESS (each mind locally optimised eat/drink/sleep/work) at a
 * heavy cost. v3 moves the intelligence UP to the supervisor and makes the
 * villagers cheap automatons driven by a UTILITY AI: each turn the brain
 * enumerates a handful of candidate actions, SCORES each, and picks the best —
 *
 *     score(action) = need_pressure × trait_modifier × supervisor_weight
 *                     + order_bonus − switching/distance cost
 *
 * It is a NEW CHOOSER in front of the SAME effect layer: it emits the existing
 * {@link AgentDecision}s the engine already executes (`move_to`, `work_at`,
 * `take_from`, `give_to`, …), so the blast radius is small and the village runs
 * with zero villager LLM calls.
 *
 * This is P1 of the migration (design §11): survival + the two production
 * chains, behind the `VILLAGER_BRAIN=utility` flag. The supervisor POLICY
 * (`weights`) and ORDERS are accepted on the context but default to neutral —
 * they are wired live in P2/P3. Keeping them in the signature now is the seam.
 *
 * Pure & transport-free: it reads a {@link Perception} + the village map and
 * returns one decision. The only state it holds is a touch of HYSTERESIS (the
 * last priority it pursued) so a villager doesn't thrash between goals — the
 * classic utility-AI failure mode.
 * ---------------------------------------------------------------------------
 */

import type { AgentDecision, ResourceKind, Vec2, Priority, VillagePolicy, OrderTask, OrderParams, BuildableId } from '../../../shared/types';
import { BACKPACK_CAPACITY } from '../../../shared/types';
import { SERVICE_REACH, NEED_CONSUME_THRESHOLD } from '../../../shared/buildings';
import type { Perception, PerceivedCart } from '../sensory';
import type { MapEntry } from '../sensory';

/**
 * A live supervisor ORDER, already resolved to this villager (targeting + TTL handled
 * upstream in {@link AgentService}). The brain turns it into one large, soft candidate.
 */
export interface ResolvedOrder {
  task: OrderTask;
  params: OrderParams;
}

/** Everything the brain reads to choose: the body's senses + the known layout + who it is. */
export interface BrainContext {
  /** What the villager senses right now (its body, needs, backpack, neighbours, near buildings). */
  perception: Perception;
  /** The whole-village building map (the god's-eye layout a villager is assumed to know). */
  villageMap: MapEntry[];
  /** The villager's stable personality words (e.g. ["industrious", "friendly"]). */
  traits: string[];
  /** The supervisor's standing POLICY (0..1 priority weights). Omitted ⇒ the village runs neutral. */
  policy?: VillagePolicy;
  /** A live, targeted order this villager should obey, or omitted when none is in force. */
  order?: ResolvedOrder;
  /**
   * True when someone in this villager's village still lacks a home. Gates the HOUSE
   * build proposal (one home per villager): when everyone is housed the brain stops
   * raising new houses. Omitted ⇒ treated as no shortfall.
   */
  housingNeeded?: boolean;
  /**
   * This villager's warmth toward a sensed neighbour (−100..100), or undefined for a
   * stranger. v3 P4 — lets the idle social drift steer toward a well-liked companion
   * instead of the generic hub, so numeric affinity actually shapes where villagers go.
   * Omitted ⇒ the brain falls back to the hub (its pre-P4 behaviour).
   */
  affinityOf?: (otherId: string) => number | undefined;
}

/** The brain's pick: the decision to emit, plus why (for telemetry/status) and its priority. */
export interface UtilityChoice {
  decision: AgentDecision;
  /** Human-readable rationale, surfaced in the thought-inspector and status line. */
  why: string;
  priority: Priority;
  /** The winning score, for debugging/telemetry. */
  score: number;
}

/** One scored candidate before the argmax. */
interface Candidate {
  decision: AgentDecision;
  base: number;
  priority: Priority;
  why: string;
  /** Distance to the action's target (0 for an in-place action), for the proximity penalty. */
  distance: number;
  /** True for a supervisor ORDER candidate — scored at a flat high value, bypassing policy/traits. */
  isOrder?: boolean;
}

/** Which utility priority an order task maps onto (for stickiness bookkeeping). */
const ORDER_TASK_PRIORITY: Record<OrderTask, Priority> = {
  build: 'build',
  gather: 'gather',
  haul: 'gather',
  work: 'gather',
  guard: 'defense',
  move: 'expand',
  socialize: 'recreation',
  raid: 'expand',
};

/** Chebyshev (king-move) distance — the grid's natural radius metric. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Need pressure in ~0..1.2 from a 0..100 need. Gentle below the consume threshold
 * (a villager doesn't drop everything for a mild need) and steep above it, so a
 * pressing need reliably dominates production/leisure work.
 */
function pressure(need: number): number {
  if (need < NEED_CONSUME_THRESHOLD) return need / 200; // 0 .. ~0.22
  return 0.22 + ((need - NEED_CONSUME_THRESHOLD) / (100 - NEED_CONSUME_THRESHOLD)) * 1.0;
}

/** Keywords that mark a villager as work-/build-leaning vs. socially-leaning. */
const WORK_WORDS = /industrious|hardworking|diligent|farmer|builder|strong|practical|dutiful|tireless/;
const SOCIAL_WORDS = /talkative|friendly|sociable|kind|warm|gregarious|cheerful|curious/;
/** Keywords that mark a villager as DEVOUT — the one who leads temple prayer. */
const DEVOUT_WORDS = /devout|pious|faithful|priest|preacher|holy|reverent|spiritual/;

/** Discretionary work bases for the v3 feature-restoration behaviours (see constructor doc). */
const SUPPLY_BUILD_BASE = 0.5; //  hauling materials to an open site — meaningful shared work
const PROPOSE_BUILD_BASE = 0.4; // opening a new project — loses to chores, beats idle drift
const COMMAND_CART_BASE = 0.34; // dispatching a cart — a cheap setup that then runs itself
const PRAY_BASE = 0.32; //         leading temple prayer — a devout villager's calling
/** Min stone banked across the village before a builder will open a new project. */
const BUILD_STONE_SURPLUS = 18;
/** Fatigue at/above which a weary villager heads HOME to sleep (matches the engine's bed threshold). */
const REST_THRESHOLD = 70;
/** Base pull of heading home to rest; scaled by fatigue pressure so it dominates only when truly spent. */
const REST_BASE = 1.4;
/** A villager leads prayer at most this often (sim ticks) so it never spams the god. */
const PRAY_COOLDOWN_TICKS = 8;
/** Village-wide total of a staple below which the village is "in want" — a reason to pray. */
const PRAY_NEED_LEVEL = 20;

export class UtilityBrain {
  /** The priority pursued last turn — given a small stickiness bonus to damp thrash. */
  private lastPriority: Priority | null = null;
  /** Sim tick of this villager's last temple prayer, to space petitions out. */
  private lastPrayTick = Number.NEGATIVE_INFINITY;

  /** Extra score handed to the priority we pursued last turn, to resist goal-flipping. */
  private static readonly STICKINESS = 0.12;
  /** Score lost per tile of travel to a target — small, so urgency still beats nearness. */
  private static readonly DISTANCE_PENALTY = 0.01;
  /** The weight a priority the supervisor did NOT set takes, once a policy exists at all. */
  private static readonly NEUTRAL_WEIGHT = 0.5;
  /** Floor under any policy weight — a god may de-emphasise work but never zero it out entirely. */
  private static readonly MIN_POLICY_WEIGHT = 0.15;
  /**
   * The flat score an ORDER candidate carries — high enough to out-pull all discretionary
   * work (production ≤0.85), but BELOW the pressure of a near-starving need (~0.9+), so an
   * ordered villager still breaks off to save itself. This is what makes orders "soft".
   */
  private static readonly ORDER_SCORE = 0.88;
  /** Affinity at/above which idle drift is pulled toward a neighbour rather than the hub. */
  private static readonly LIKED_AFFINITY = 25;

  /**
   * Choose this turn's action, or null to stand pat (asleep, or genuinely nothing
   * worth doing). Enumerate candidates, fold in trait/policy/stickiness, subtract a
   * proximity cost, and take the argmax.
   */
  decide(ctx: BrainContext): UtilityChoice | null {
    // Asleep or downed (beaten back, limping home to recover): the mind is dark.
    if (ctx.perception.self.asleep || ctx.perception.self.downed) return null;

    const candidates = this.candidates(ctx);
    if (candidates.length === 0) return null;

    // The supervisor's POLICY biases discretionary work. With NO policy set we treat every
    // priority as 1 (pure need-driven). Once the supervisor sets ANY weights, priorities it
    // left unset fall to a neutral baseline, so a deliberate emphasis (food 0.7) actually
    // out-pulls the rest rather than being undercut by an implicit 1.
    const weights = ctx.policy?.weights;
    const hasPolicy = weights !== undefined && Object.keys(weights).length > 0;

    let best: { c: Candidate; score: number } | null = null;
    for (const c of candidates) {
      const stick = c.priority === this.lastPriority ? UtilityBrain.STICKINESS : 0;
      let score: number;
      if (c.isOrder) {
        // An order is scored at a flat high value — not subject to trait/policy weighting,
        // NOR to the distance penalty: an order is obeyed however far the target is (the
        // villager simply walks there over the coming turns). Only stickiness applies.
        score = UtilityBrain.ORDER_SCORE + stick;
      } else {
        const trait = this.traitModifier(c.priority, ctx.traits);
        // The supervisor's policy BIASES discretionary work but must never KILL it: a floored
        // weight keeps the village in motion even under a lopsided policy (e.g. a god that zeroes
        // build/gather while fretting over fatigue), so steering can't accidentally re-freeze it.
        const raw = hasPolicy ? (weights![c.priority] ?? UtilityBrain.NEUTRAL_WEIGHT) : 1;
        const weight = Math.max(UtilityBrain.MIN_POLICY_WEIGHT, raw);
        score = c.base * trait * weight + stick - c.distance * UtilityBrain.DISTANCE_PENALTY;
      }
      if (!best || score > best.score) best = { c, score };
    }
    if (!best) return null;

    this.lastPriority = best.c.priority;
    // Advance the prayer cool-down only when prayer is the action actually taken (not merely
    // a candidate that lost), so a devout villager paces real petitions, not considered ones.
    if (best.c.decision.kind === 'pray_at') this.lastPrayTick = ctx.perception.tick;
    return { decision: best.c.decision, why: best.c.why, priority: best.c.priority, score: best.score };
  }

  /** Industrious villagers lean into work; sociable ones into recreation. Neutral otherwise. */
  private traitModifier(priority: Priority, traits: string[]): number {
    const blob = traits.join(' ').toLowerCase();
    const workish = WORK_WORDS.test(blob);
    const socialish = SOCIAL_WORDS.test(blob);
    if (workish && (priority === 'food' || priority === 'water' || priority === 'gather' || priority === 'build')) {
      return 1.15;
    }
    if (socialish && priority === 'recreation') return 1.15;
    return 1;
  }

  // -------------------------------------------------------------------------
  // CANDIDATE GENERATION — each behaviour pushes 0+ scored options.
  // -------------------------------------------------------------------------

  private candidates(ctx: BrainContext): Candidate[] {
    const out: Candidate[] = [];
    this.surviveThirst(ctx, out);
    this.surviveHunger(ctx, out);
    this.restAtHome(ctx, out); //        v3 — a weary villager walks to its OWN home to sleep
    this.relieveBoredom(ctx, out);
    this.produceFood(ctx, out);
    this.produceGoods(ctx, out);
    this.supplyConstruction(ctx, out); // v3 — haul materials to an open building site
    this.proposeBuild(ctx, out); //      v3 — a builder opens a new project when stone is banked
    this.commandCarts(ctx, out); //      v3 — dispatch idle robot-carts onto a busy haul route
    this.prayAtTemple(ctx, out); //      v3 — the devout lead prayer, petitioning the god
    this.obeyOrder(ctx, out);
    this.socialFallback(ctx, out);
    return out;
  }

  /**
   * Turn a live supervisor ORDER into one large, soft candidate. The order maps onto an
   * action by its task; the resulting candidate is flagged `isOrder` so it scores at the
   * flat {@link ORDER_SCORE} (above discretionary work, below a near-starving need). One
   * action per turn — the brain re-enters next turn for the next leg of a multi-step order.
   */
  private obeyOrder(ctx: BrainContext, out: Candidate[]): void {
    const order = ctx.order;
    if (!order) return;
    const self = ctx.perception.self;
    const p = order.params;
    const priority = ORDER_TASK_PRIORITY[order.task];
    const target = p.buildingId ? this.byId(ctx, p.buildingId) : null;
    // A bare tile target (for move/guard/socialize, or as a fallback) when no building is named.
    const tile: Vec2 | null = p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : null;
    const mark = (c: Candidate): void => {
      c.isOrder = true;
      out.push(c);
    };

    switch (order.task) {
      case 'work': {
        if (!target) return;
        if (this.adjacent(ctx, target.id)) {
          mark({ decision: { kind: 'work_at', buildingId: target.id }, base: 0, priority, why: `ordered to work ${target.name}`, distance: 0 });
        } else {
          mark(this.moveTo(self, target.position, 0, priority, `ordered to ${target.name} to work`));
        }
        return;
      }
      case 'gather':
      case 'haul':
      case 'build': {
        // Carry a resource to the named place: source it, then deliver (one leg per turn).
        const resource = p.resource;
        if (target && resource) {
          const before = out.length;
          this.haulLeg(ctx, out, { resource, from: this.nearestSourceOf(ctx, resource), to: target, base: 0, priority, label: `ordered to ${order.task} ${resource} to ${target.name}` });
          for (let i = before; i < out.length; i++) out[i].isOrder = true;
          return;
        }
        // No resource named → just converge on the place / tile and contribute by presence.
        const at = target?.position ?? tile;
        if (at) mark(this.moveTo(self, at, 0, priority, `ordered to ${order.task}${target ? ` at ${target.name}` : ''}`));
        return;
      }
      case 'move':
      case 'guard':
      case 'socialize': {
        const at = tile ?? target?.position;
        if (at) mark(this.moveTo(self, at, 0, priority, `ordered to ${order.task}${target ? ` at ${target.name}` : ''}`));
        return;
      }
      case 'raid': {
        // v3 P5 (design §10) — cross into the rival's territory and seize its stores. If a
        // RIVAL-owned building with anything in it is within sight, close on it and steal
        // (the engine's take_from + the aggregator's raid detection do the rest); otherwise
        // march on the rival settlement's rough centre (the order's x/y) to get in range.
        const loot = ctx.perception.nearbyBuildings
          .filter((b) => b.villageId !== self.villageId)
          .map((b) => ({ b, res: this.richestResource(b.stock) }))
          .filter((x): x is { b: (typeof ctx.perception.nearbyBuildings)[number]; res: ResourceKind } => x.res !== null)
          .sort((a, b) => a.b.distance - b.b.distance)[0];
        if (loot) {
          if (this.adjacent(ctx, loot.b.id) && this.backpackRoom(self.backpack) > 0) {
            mark({ decision: { kind: 'take_from', buildingId: loot.b.id, resource: loot.res }, base: 0, priority, why: `raiding ${loot.b.name} for ${loot.res}`, distance: 0 });
          } else {
            mark(this.moveTo(self, loot.b.position, 0, priority, `raiding — closing on ${loot.b.name}`));
          }
          return;
        }
        const at = tile ?? target?.position;
        if (at) mark(this.moveTo(self, at, 0, priority, 'marching on the rival settlement'));
        return;
      }
    }
  }

  /** The resource a building holds most of (for a raider to grab), or null if it holds nothing. */
  private richestResource(stock: Partial<Record<ResourceKind, number>>): ResourceKind | null {
    let best: ResourceKind | null = null;
    let max = 0;
    for (const [r, n] of Object.entries(stock) as [ResourceKind, number][]) {
      if (n > max) {
        max = n;
        best = r;
      }
    }
    return best;
  }

  /**
   * Drink. The engine auto-consumes water from the BACKPACK anywhere, or from an
   * adjacent store; so if already carrying water, do nothing here (let the body
   * sip on its own). Otherwise walk to the nearest water store and load up.
   */
  private surviveThirst(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    if (self.needs.thirst < NEED_CONSUME_THRESHOLD - 10) return; // not yet worth a trip
    if (this.carrying(self.backpack, 'water') > 0) return; // body will drink from the pack
    const store = this.nearestStocking(ctx, 'water', ['hall_town', 'water_source', 'greenfield']);
    if (!store) return;
    const base = pressure(self.needs.thirst);
    if (this.adjacent(ctx, store.id) && this.backpackRoom(self.backpack) > 0) {
      out.push({ decision: { kind: 'take_from', buildingId: store.id, resource: 'water' }, base, priority: 'water', why: `thirsty — drawing water at ${store.name}`, distance: 0 });
    } else {
      out.push(this.moveTo(self, store.position, base, 'water', `thirsty — heading to ${store.name} for water`));
    }
  }

  /** Eat — mirror of {@link surviveThirst} over food stores (the larder + the farm). */
  private surviveHunger(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    if (self.needs.hunger < NEED_CONSUME_THRESHOLD - 10) return;
    if (this.carrying(self.backpack, 'food') > 0) return;
    const store = this.nearestStocking(ctx, 'food', ['hall_town', 'greenfield']);
    if (!store) return;
    const base = pressure(self.needs.hunger);
    if (this.adjacent(ctx, store.id) && this.backpackRoom(self.backpack) > 0) {
      out.push({ decision: { kind: 'take_from', buildingId: store.id, resource: 'food' }, base, priority: 'food', why: `hungry — taking food at ${store.name}`, distance: 0 });
    } else {
      out.push(this.moveTo(self, store.position, base, 'food', `hungry — heading to ${store.name} for food`));
    }
  }

  /**
   * Unwind. Boredom is relieved only by enjoying goods AT the tavern (never from a
   * backpack), so steer a bored villager there. If the tavern has run dry of goods,
   * say nothing here — the goods chain ({@link produceGoods}) will refill it.
   */
  private relieveBoredom(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    if (self.needs.boredom < NEED_CONSUME_THRESHOLD + 5) return;
    const tavern = this.nearest(this.ofKind(ctx, 'tavern').filter((b) => (b.stock.goods ?? 0) > 0), self.position);
    if (!tavern) return;
    const base = pressure(self.needs.boredom);
    out.push(this.moveTo(self, tavern.position, base, 'recreation', `restless — off to ${tavern.name} for a while`));
  }

  /**
   * Keep food flowing (design §4 — the water→food chain). Working Greenfield converts
   * its stocked water into food fast; if Greenfield is short of water, run a leg of the
   * spring→Greenfield haul. The whole behaviour scales with how scarce village food is,
   * so it presses harder as the larder empties but never out-shouts a hungry belly.
   */
  private produceFood(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    const farm = this.nearest(this.ofKind(ctx, 'greenfield'), self.position);
    if (!farm) return;
    const hall = this.nearest(this.ofKind(ctx, 'hall_town'), self.position);
    const villageFood = (farm.stock.food ?? 0) + (hall?.stock.food ?? 0);
    // Maintain a healthy larder, not a bare minimum — villagers keep the farm working
    // until food is comfortably buffered, so the water→food chain runs continuously
    // instead of going dormant the moment a few meals are in store.
    const FOOD_TARGET = 60;
    if (villageFood >= FOOD_TARGET) return; // larder comfortable — leave the farm be
    const scarcity = Math.min(1, (FOOD_TARGET - villageFood) / FOOD_TARGET);
    // 0.25 .. 0.70 — discretionary work: above idle/mild needs, but kept clear below both a
    // pressing need (which can reach ~1.2) and a standing order (~0.9), so neither is starved.
    const base = 0.25 + scarcity * 0.45;

    const farmWater = farm.stock.water ?? 0;
    const farmFood = farm.stock.food ?? 0;
    if (farmWater >= 1 && farmFood < farm.capacity) {
      // Tend the farm — fast water→food conversion while a villager works it.
      if (this.adjacent(ctx, farm.id)) {
        out.push({ decision: { kind: 'work_at', buildingId: farm.id }, base, priority: 'food', why: `tending ${farm.name} to grow food`, distance: 0 });
      } else {
        out.push(this.moveTo(self, farm.position, base, 'food', `food is short — going to work ${farm.name}`));
      }
      return;
    }
    // Farm is dry — haul water from the spring (one leg of the chain per turn).
    this.haulLeg(ctx, out, { resource: 'water', from: this.nearest(this.ofKind(ctx, 'water_source'), self.position), to: farm, base, priority: 'food', label: `${farm.name} needs water` });
  }

  /**
   * Keep goods on the tavern shelf so there is recreation to be had (design §4 — the
   * wood→goods chain). Walk the lumber_source→workshop→tavern pipeline one leg at a
   * time. Lower-priority than survival/food; this is the village's leisure economy.
   */
  private produceGoods(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    const tavern = this.nearest(this.ofKind(ctx, 'tavern'), self.position);
    const shop = this.nearest(this.ofKind(ctx, 'workshop'), self.position);
    if (!tavern || !shop) return;
    // Keep the tavern well stocked so the wood→goods→tavern pipeline (the village's most
    // visible bustle) stays in motion rather than parking once a couple of goods land.
    const GOODS_TARGET = 35;
    if ((tavern.stock.goods ?? 0) >= GOODS_TARGET) return;
    const scarcity = Math.min(1, (GOODS_TARGET - (tavern.stock.goods ?? 0)) / GOODS_TARGET);
    const base = 0.15 + scarcity * 0.35; // 0.15 .. 0.5 — leisure work, well under survival/orders

    if (this.carrying(self.backpack, 'goods') > 0) {
      // Carry finished goods to the tavern.
      this.haulLeg(ctx, out, { resource: 'goods', carryingTo: tavern, base, priority: 'gather', label: 'stocking the tavern with goods' });
      return;
    }
    if ((shop.stock.goods ?? 0) > 0) {
      // Pick up goods the workshop has made, bound for the tavern.
      if (this.adjacent(ctx, shop.id) && this.backpackRoom(self.backpack) > 0) {
        out.push({ decision: { kind: 'take_from', buildingId: shop.id, resource: 'goods' }, base, priority: 'gather', why: `collecting goods from ${shop.name}`, distance: 0 });
      } else {
        out.push(this.moveTo(self, shop.position, base, 'gather', `fetching goods from ${shop.name}`));
      }
      return;
    }
    if ((shop.stock.wood ?? 0) >= 1) {
      // Work the workshop — wood→goods.
      if (this.adjacent(ctx, shop.id)) {
        out.push({ decision: { kind: 'work_at', buildingId: shop.id }, base, priority: 'gather', why: `crafting goods at ${shop.name}`, distance: 0 });
      } else {
        out.push(this.moveTo(self, shop.position, base, 'gather', `going to craft at ${shop.name}`));
      }
      return;
    }
    // Workshop is out of wood — haul a load from the grove.
    this.haulLeg(ctx, out, { resource: 'wood', from: this.nearest(this.ofKind(ctx, 'lumber_source'), self.position), to: shop, base, priority: 'gather', label: `${shop.name} needs wood` });
  }

  /**
   * v3 — keep an open construction site moving: haul whichever material it still needs
   * (most-lacking first) from the nearest source and give it over. The most valuable shared
   * chore short of survival, so a half-built shell actually gets raised rather than abandoned.
   */
  private supplyConstruction(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    const sites = this.ofKind(ctx, 'construction_site').filter(
      (b) => b.needs && (Object.values(b.needs) as number[]).some((n) => n > 0),
    );
    const site = this.nearest(sites, self.position);
    if (!site || !site.needs) return;
    const wanted = (Object.entries(site.needs) as [ResourceKind, number][])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [resource] of wanted) {
      const holding = this.carrying(self.backpack, resource) > 0;
      const src = holding ? null : this.nearestSourceOf(ctx, resource);
      if (!holding && !src) continue; // nowhere to get this material right now — try the next
      this.haulLeg(ctx, out, { resource, from: src, to: site, base: SUPPLY_BUILD_BASE, priority: 'build', label: `raising ${site.name}` });
      return;
    }
  }

  /**
   * v3 — a villager OPENS a new project. Self-limiting: only when no site is already open
   * (finish one first) and the village has banked enough STONE to make real progress. Picks
   * the structure the settlement most lacks and a spot beside the town hall; the engine
   * validates placement and refuses a bad one. A builder-leaning villager scores it higher.
   */
  private proposeBuild(ctx: BrainContext, out: Candidate[]): void {
    if (this.ofKind(ctx, 'construction_site').length > 0) return; // finish the open one first
    if (this.totalStock(ctx, 'stone') < BUILD_STONE_SURPLUS) return; // no stone, no building
    const pick = this.chooseBuild(ctx);
    if (!pick) return; // nothing the village still needs (and everyone is already housed)
    const spot = this.buildSpot(ctx);
    if (!spot) return;
    out.push({
      decision: { kind: 'propose_build', structure: pick.id, name: pick.name, x: spot.x, y: spot.y },
      base: PROPOSE_BUILD_BASE,
      priority: 'build',
      why: `proposing to raise ${pick.name}`,
      distance: 0,
    });
  }

  /**
   * What the village most needs next: a monument, then light, then a second well, then a
   * home for anyone still without one — and nothing once all of those are met (the engine
   * picks the organized spot; we only choose WHAT to raise). Returns null when there is
   * nothing left worth building, so the village stops over-building houses.
   */
  private chooseBuild(ctx: BrainContext): { id: BuildableId; name: string } | null {
    if (this.ofKind(ctx, 'monument').length === 0) return { id: 'statue', name: 'the Village Statue' };
    if (this.ofKind(ctx, 'lamp').length === 0) return { id: 'lamp', name: 'a Standing Lamp' };
    if (this.ofKind(ctx, 'water_source').length < 2) return { id: 'well', name: 'a new Well' };
    if (ctx.housingNeeded) return { id: 'house', name: 'a new House' };
    return null;
  }

  /**
   * A weary villager heads to its OWN home to turn in (the engine then puts it to bed
   * once it idles there). Scaled by fatigue pressure so it stays a background pull until
   * the body is genuinely spent, when it reliably wins over discretionary chores. Skipped
   * for the homeless (no assigned home) — they sleep wherever they end up, as before.
   */
  private restAtHome(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    if (self.needs.fatigue < REST_THRESHOLD) return;
    if (!self.homeId) return;
    const home = this.byId(ctx, self.homeId);
    if (!home) return;
    out.push(
      this.moveTo(self, home.position, REST_BASE * pressure(self.needs.fatigue), 'rest', `weary — heading home to ${home.name} to sleep`),
    );
  }

  /** A spot beside the town hall to raise a new structure; rotates each tick so a refused
   *  placement retries on a different tile rather than looping on the same bad one. */
  private buildSpot(ctx: BrainContext): Vec2 | null {
    const anchor =
      this.nearest(this.ofKind(ctx, 'hall_town'), ctx.perception.self.position) ??
      this.nearest(ctx.villageMap, ctx.perception.self.position);
    if (!anchor) return null;
    const ring: ReadonlyArray<[number, number]> = [[14, 0], [0, 14], [-14, 0], [0, -14], [14, 14], [-14, 14], [14, -14], [-14, -14]];
    const [dx, dy] = ring[ctx.perception.tick % ring.length];
    return { x: Math.max(0, anchor.position.x + dx), y: Math.max(0, anchor.position.y + dy) };
  }

  /**
   * v3 — put the village's robot-carts to work. When an idle (or mis-tasked) cart is within
   * reach, set it to run the busiest haul leg on its own, sparing villagers the round trip;
   * if a usable cart is sensed but out of reach, walk over to command it.
   */
  private commandCarts(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    const carts = ctx.perception.nearbyCarts;
    const route = this.bestCartRoute(ctx);
    if (!route) return;
    if (carts.some((c) => this.cartServes(c, route))) return; // a cart already runs this route
    const ready = carts.find((c) => c.canCommand);
    if (ready) {
      out.push({
        decision: { kind: 'command_cart', cartId: ready.id, resource: route.resource, fromBuildingId: route.from.id, toBuildingId: route.to.id },
        base: COMMAND_CART_BASE,
        priority: 'gather',
        why: `setting ${ready.name} to haul ${route.resource} to ${route.to.name}`,
        distance: 0,
      });
      return;
    }
    // A cart is sensed but out of reach — walk over to it.
    const sensed = carts.find((c) => c.phase === 'idle') ?? carts[0];
    if (sensed) {
      out.push(this.moveTo(self, sensed.position, COMMAND_CART_BASE, 'gather', `going to dispatch ${sensed.name}`));
      return;
    }
    // No cart in sight at all — head to the DEPOT, the control station from which ANY cart in
    // the village can be dispatched, so the fleet gets used instead of sitting idle out of view.
    const depot = this.nearest(this.ofKind(ctx, 'depot'), self.position);
    if (depot && !this.adjacent(ctx, depot.id)) {
      out.push(this.moveTo(self, depot.position, COMMAND_CART_BASE, 'gather', `heading to ${depot.name} to dispatch a cart`));
    }
  }

  /** The haul route a cart could most usefully automate, by current scarcity, or null. */
  private bestCartRoute(ctx: BrainContext): { resource: ResourceKind; from: MapEntry; to: MapEntry } | null {
    const at = ctx.perception.self.position;
    const farm = this.nearest(this.ofKind(ctx, 'greenfield'), at);
    const shop = this.nearest(this.ofKind(ctx, 'workshop'), at);
    const tavern = this.nearest(this.ofKind(ctx, 'tavern'), at);
    const hall = this.nearest(this.ofKind(ctx, 'hall_town'), at);
    const spring = this.nearest(this.ofKind(ctx, 'water_source'), at);
    const grove = this.nearest(this.ofKind(ctx, 'lumber_source'), at);
    const low = (b: MapEntry | null, r: ResourceKind) => !!b && (b.stock[r] ?? 0) < b.capacity * 0.7;
    const has = (b: MapEntry | null, r: ResourceKind) => !!b && (b.stock[r] ?? 0) > 0;
    if (spring && farm && low(farm, 'water')) return { resource: 'water', from: spring, to: farm };
    if (grove && shop && low(shop, 'wood')) return { resource: 'wood', from: grove, to: shop };
    if (shop && tavern && has(shop, 'goods') && low(tavern, 'goods')) return { resource: 'goods', from: shop, to: tavern };
    if (farm && hall && has(farm, 'food') && low(hall, 'food')) return { resource: 'food', from: farm, to: hall };
    return null;
  }

  /** True when a cart already carries the given standing order (matched by the names it reports). */
  private cartServes(cart: PerceivedCart, route: { resource: ResourceKind; from: MapEntry; to: MapEntry }): boolean {
    return (
      !!cart.order &&
      cart.order.resource === route.resource &&
      cart.order.fromName === route.from.name &&
      cart.order.toName === route.to.name
    );
  }

  /**
   * v3 — temple prayer. A DEVOUT villager makes the trip to lead it; anyone already at the
   * temple may also offer a plea. On a cool-down, the prayer petitions the god for whatever
   * the village most lacks — flowing to the supervisor as a `villager.pray` the god can answer.
   */
  private prayAtTemple(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;
    if (ctx.perception.tick - this.lastPrayTick < PRAY_COOLDOWN_TICKS) return;
    const temple = this.nearest(this.ofKind(ctx, 'temple'), self.position);
    if (!temple) return;
    const devout = DEVOUT_WORDS.test(ctx.traits.join(' ').toLowerCase());
    const lack = this.scarcestResource(ctx);
    // The village is genuinely short of a staple when its scarcest stock runs low — a reason
    // anyone might walk to the temple and plead, not only the devout (who pray regardless).
    const inWant = lack !== null && this.totalStock(ctx, lack) < PRAY_NEED_LEVEL;
    if (!this.adjacent(ctx, temple.id)) {
      if (!devout && !inWant) return; // others make the trip only when the village is wanting
      out.push(this.moveTo(self, temple.position, PRAY_BASE, 'recreation', 'going to the temple to pray'));
      return;
    }
    const message = lack
      ? `Great god, your people are short of ${lack} — send us your providence.`
      : 'Great god, we thank you; keep our village whole and growing.';
    out.push({ decision: { kind: 'pray_at', buildingId: temple.id, message }, base: PRAY_BASE, priority: 'recreation', why: 'leading prayer at the temple', distance: 0 });
  }

  /** The staple the village holds least of, for a prayer's plea (or null if it knows none). */
  private scarcestResource(ctx: BrainContext): ResourceKind | null {
    const staples: ResourceKind[] = ['water', 'food', 'wood', 'goods', 'stone'];
    let worst: { r: ResourceKind; n: number } | null = null;
    for (const r of staples) {
      const n = this.totalStock(ctx, r);
      if (!worst || n < worst.n) worst = { r, n };
    }
    return worst?.r ?? null;
  }

  /** Total of a resource banked across every known building — the village-wide supply. */
  private totalStock(ctx: BrainContext, resource: ResourceKind): number {
    return ctx.villageMap.reduce((sum, b) => sum + (b.stock[resource] ?? 0), 0);
  }

  /**
   * The floor: when nothing presses, drift to a shared place (tavern → hall → temple)
   * so villagers converge and keep one another company (which itself eases boredom a
   * little, engine-side). A whisper-quiet score, so any real need or chore wins.
   */
  private socialFallback(ctx: BrainContext, out: Candidate[]): void {
    const self = ctx.perception.self;

    // v3 P4 — if a well-liked neighbour is in sight, drift toward THEM rather than the
    // generic hub, so numeric affinity actually pulls villagers into the company they
    // favour. Only a positive tie counts, and only when we're not already beside them.
    const friend = this.likedNeighbour(ctx);
    if (friend) {
      out.push(this.moveTo(self, friend.position, 0.06, 'recreation', `drifting over to ${friend.name}`));
      return;
    }

    const hub =
      this.nearest(this.ofKind(ctx, 'tavern'), self.position) ??
      this.nearest(this.ofKind(ctx, 'hall_town'), self.position) ??
      this.nearest(this.ofKind(ctx, 'temple'), self.position);
    if (!hub) return;
    if (this.adjacent(ctx, hub.id)) return; // already there — just linger, no move needed
    out.push(this.moveTo(self, hub.position, 0.05, 'recreation', `nothing pressing — drifting toward ${hub.name}`));
  }

  /**
   * The most-liked neighbour currently in sight that we are not already standing beside,
   * or null. Used by {@link socialFallback} to let affinity steer idle drift. Needs both
   * an affinity lookup (omitted ⇒ no friend pull) and a warm enough tie ({@link LIKED_AFFINITY}).
   */
  private likedNeighbour(ctx: BrainContext): { position: Vec2; name: string } | null {
    const affinityOf = ctx.affinityOf;
    if (!affinityOf) return null;
    const self = ctx.perception.self;
    let best: { position: Vec2; name: string; affinity: number } | null = null;
    for (const v of ctx.perception.nearbyVillagers) {
      if (!v.canSee) continue;
      const affinity = affinityOf(v.id) ?? 0;
      if (affinity < UtilityBrain.LIKED_AFFINITY) continue;
      if (chebyshev(self.position, v.position) <= 1) continue; // already at their side
      if (!best || affinity > best.affinity) best = { position: v.position, name: v.name, affinity };
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // SHARED HELPERS
  // -------------------------------------------------------------------------

  /**
   * One leg of a haul: if carrying the resource, deliver it to the destination
   * (give_to when adjacent, else walk there); otherwise load it at the source
   * (take_from when adjacent, else walk there). One action per turn; the brain
   * re-enters next turn for the next leg.
   */
  private haulLeg(
    ctx: BrainContext,
    out: Candidate[],
    spec: { resource: ResourceKind; from?: MapEntry | null; to?: MapEntry | null; carryingTo?: MapEntry; base: number; priority: Priority; label: string },
  ): void {
    const self = ctx.perception.self;
    const dest = spec.carryingTo ?? spec.to;
    if (this.carrying(self.backpack, spec.resource) > 0) {
      if (!dest) return;
      if (this.adjacent(ctx, dest.id)) {
        out.push({ decision: { kind: 'give_to', buildingId: dest.id, resource: spec.resource }, base: spec.base, priority: spec.priority, why: spec.label, distance: 0 });
      } else {
        out.push(this.moveTo(self, dest.position, spec.base, spec.priority, spec.label));
      }
      return;
    }
    const src = spec.from;
    if (!src) return;
    if (this.adjacent(ctx, src.id) && this.backpackRoom(self.backpack) > 0) {
      out.push({ decision: { kind: 'take_from', buildingId: src.id, resource: spec.resource }, base: spec.base, priority: spec.priority, why: `${spec.label} — loading ${spec.resource} at ${src.name}`, distance: 0 });
    } else {
      out.push(this.moveTo(self, src.position, spec.base, spec.priority, `${spec.label} — fetching ${spec.resource}`));
    }
  }

  /** Build a `move_to` candidate, charged for the distance it would cover. */
  private moveTo(self: Perception['self'], to: Vec2, base: number, priority: Priority, why: string): Candidate {
    return { decision: { kind: 'move_to', x: to.x, y: to.y }, base, priority, why, distance: chebyshev(self.position, to) };
  }

  /** Every map building of a given kind. */
  private ofKind(ctx: BrainContext, kind: string): MapEntry[] {
    return ctx.villageMap.filter((b) => b.kind === kind);
  }

  /** A map building by id, or null when it isn't on the known layout. */
  private byId(ctx: BrainContext, id: string): MapEntry | null {
    return ctx.villageMap.find((b) => b.id === id) ?? null;
  }

  /**
   * Nearest building currently holding ≥1 unit of `resource` to LOAD it from. Construction
   * sites are excluded: the materials hauled into a site are committed to the build and can't
   * be taken back out, so treating a half-built shell as a source just loops on a refused take.
   */
  private nearestSourceOf(ctx: BrainContext, resource: ResourceKind): MapEntry | null {
    const stores = ctx.villageMap.filter(
      (b) => b.kind !== 'construction_site' && (b.stock[resource] ?? 0) > 0,
    );
    return this.nearest(stores, ctx.perception.self.position);
  }

  /** The closest of a set of buildings to a point, or null when the set is empty. */
  private nearest(entries: MapEntry[], from: Vec2): MapEntry | null {
    let best: { e: MapEntry; d: number } | null = null;
    for (const e of entries) {
      const d = chebyshev(from, e.position);
      if (!best || d < best.d) best = { e, d };
    }
    return best?.e ?? null;
  }

  /** Nearest building that stocks `resource` (≥1 unit) among the preferred kinds. */
  private nearestStocking(ctx: BrainContext, resource: ResourceKind, kinds: string[]): MapEntry | null {
    const stores = ctx.villageMap.filter((b) => kinds.includes(b.kind) && (b.stock[resource] ?? 0) > 0);
    return this.nearest(stores, ctx.perception.self.position);
  }

  /** Within reach to use a building this turn (sensed and inside SERVICE_REACH of its footprint). */
  private adjacent(ctx: BrainContext, buildingId: string): boolean {
    return ctx.perception.nearbyBuildings.some((b) => b.id === buildingId && b.distance <= SERVICE_REACH);
  }

  private carrying(backpack: string[], resource: ResourceKind): number {
    return backpack.filter((r) => r === resource).length;
  }

  private backpackRoom(backpack: string[]): number {
    return BACKPACK_CAPACITY - backpack.length;
  }
}
