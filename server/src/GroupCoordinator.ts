/**
 * server/src/GroupCoordinator.ts
 * ---------------------------------------------------------------------------
 * The keeper of the village's SHARED PLANS — how a knot of neighbours turns talk
 * into coordinated doing.
 *
 * A villager that is gathered with others can `propose_plan` (a common goal + the
 * part it will take); others nearby can `join_plan` with their own roles. This
 * service is the small authority that turns those intents into live
 * {@link GroupPlan}s:
 *
 *   - it tracks who is gathered with whom (off the world stream) so a join lands
 *     on the plan being formed in the joiner's own circle;
 *   - it broadcasts every opened/joined plan on the telemetry exchange, so the
 *     members' minds (and the UI) see the shared agenda; and
 *   - it expires plans that have gone quiet, so a stale errand doesn't haunt the
 *     village forever.
 *
 * It owns no world state of record — just the live plans and a snapshot of the
 * current gatherings — and is the read model behind the gateway's `/group-plans`.
 * ---------------------------------------------------------------------------
 */

import type { EventBus } from '../../bus/EventBus';
import { makeEvent } from '../../bus/EventBus';
import {
  EXCHANGES,
  type VillagerIntentEvent,
  type WorldEvent,
} from '../../shared/events';
import type { GroupPlan, GroupPlanMember } from '../../shared/types';
import { buildableFor } from '../../shared/buildings';
import type { RuntimeStateStore } from './persistence/RuntimeStateStore';

/** Plans with no activity for this many ticks are dropped (about a working session). */
const PLAN_TTL_TICKS = 60;
/** Most plans to keep live at once, so a chatty village can't grow the list unbounded. */
const MAX_ACTIVE_PLANS = 12;
/** The runtime-state key the village's shared plans are persisted under. */
const GROUP_PLANS_KEY = 'group-plans';

export class GroupCoordinator {
  /** Active plans, newest interaction first when listed. */
  private readonly plans = new Map<string, GroupPlan>();
  /** Latest tick from the world stream, used to stamp + expire plans. */
  private tick = 0;
  /** villagerId -> the set of ids it is currently gathered with (itself included). */
  private gatheringOf = new Map<string, Set<string>>();
  /** id -> display name, kept current from the world stream. */
  private readonly names = new Map<string, string>();

  constructor(
    private readonly bus: EventBus,
    /** Optional durable store so the village's shared plans survive a reboot. */
    private readonly state?: RuntimeStateStore,
  ) {}

  async start(): Promise<void> {
    // Restore the village's shared plans first, so a reboot keeps work crews and
    // prayer rituals alive instead of erasing the agenda. Best-effort.
    await this.restorePlans();

    // Track gatherings + tick + names off the world stream.
    await this.bus.subscribe<WorldEvent>(EXCHANGES.worldEvents, 'world.map_updated', (event) => {
      if (event.type !== 'world.map_updated') return;
      this.tick = event.payload.tick;
      for (const v of event.payload.villagers) this.names.set(v.id, v.name ?? v.id);
      const map = new Map<string, Set<string>>();
      for (const g of event.payload.gatherings ?? []) {
        const set = new Set(g.memberIds);
        for (const id of g.memberIds) map.set(id, set);
      }
      this.gatheringOf = map;
      this.expireStale();
    });

    // The plan intents. Its own durable queue so it never competes with the engine
    // or aggregator for these envelopes.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.propose_plan',
      (event) => {
        if (event.type === 'villager.propose_plan') this.onPropose(event.payload);
      },
      { queue: 'group.propose', durable: true },
    );
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.join_plan',
      (event) => {
        if (event.type === 'villager.join_plan') this.onJoin(event.payload);
      },
      { queue: 'group.join', durable: true },
    );
    // A build proposal is ALSO a shared village goal: open a `build`-kind plan for it
    // (the engine, a separate consumer of this intent, opens the physical site). Its
    // own durable queue so it never competes with the engine for these envelopes.
    await this.bus.subscribe<VillagerIntentEvent>(
      EXCHANGES.villagerIntents,
      'villager.propose_build',
      (event) => {
        if (event.type === 'villager.propose_build') this.onProposeBuild(event.payload);
      },
      { queue: 'group.build', durable: true },
    );

    console.log('[group] coordinating shared plans');
  }

  /** Every active plan, most-recently-touched first — the gateway's read model. */
  all(): GroupPlan[] {
    return [...this.plans.values()].sort((a, b) => b.lastTick - a.lastTick);
  }

  // -------------------------------------------------------------------------

  private onPropose(p: { villagerId: string; goal: string; planKind: GroupPlan['kind']; role: string }): void {
    // One open plan per proposer: a fresh proposal supersedes the proposer's last.
    for (const [id, plan] of this.plans) {
      if (plan.proposerId === p.villagerId) this.plans.delete(id);
    }
    const name = this.nameOf(p.villagerId);
    const plan: GroupPlan = {
      id: `plan_${p.villagerId}_${this.tick}`,
      proposerId: p.villagerId,
      proposerName: name,
      goal: p.goal,
      kind: p.planKind,
      members: [{ villagerId: p.villagerId, villagerName: name, role: p.role }],
      startTick: this.tick,
      lastTick: this.tick,
    };
    this.plans.set(plan.id, plan);
    this.trim();
    console.log(`[group] ${name} proposed a ${plan.kind} plan: "${plan.goal}"`);
    this.broadcast(plan);
  }

  /**
   * A villager proposed RAISING a structure: open a `build`-kind group plan for it so
   * the project shows in the village agenda and neighbours can `join_plan` as the
   * build crew. The proposer's role is to lead the raising; the goal names the
   * structure and what it needs, so joiners know what to haul.
   */
  private onProposeBuild(p: { villagerId: string; structure: string; name: string; description?: string }): void {
    // One open plan per proposer: a fresh proposal supersedes the proposer's last.
    for (const [id, plan] of this.plans) {
      if (plan.proposerId === p.villagerId) this.plans.delete(id);
    }
    const spec = buildableFor(p.structure as never);
    const name = this.nameOf(p.villagerId);
    const needs = spec
      ? Object.entries(spec.cost).map(([r, n]) => `${n} ${r}`).join(', ')
      : 'materials';
    // For an invented structure, name what it IS (its description) rather than the
    // generic "a new structure", so the crew knows the thing they are raising.
    const what =
      p.structure === 'custom' && p.description
        ? `${p.description}, "${p.name}"`
        : `${spec?.label ?? 'a structure'}, "${p.name}"`;
    const plan: GroupPlan = {
      id: `plan_${p.villagerId}_${this.tick}`,
      proposerId: p.villagerId,
      proposerName: name,
      goal: `Raise ${what} — haul ${needs} to the site`,
      kind: 'build',
      members: [{ villagerId: p.villagerId, villagerName: name, role: 'leading the build' }],
      startTick: this.tick,
      lastTick: this.tick,
    };
    this.plans.set(plan.id, plan);
    this.trim();
    console.log(`[group] ${name} proposed a build plan: "${plan.goal}"`);
    this.broadcast(plan);
  }

  private onJoin(p: { villagerId: string; role: string }): void {
    const plan = this.planForJoiner(p.villagerId);
    if (!plan) {
      console.log(`[group] ${this.nameOf(p.villagerId)} tried to join, but no plan is forming nearby`);
      return;
    }
    const name = this.nameOf(p.villagerId);
    const existing = plan.members.find((m) => m.villagerId === p.villagerId);
    if (existing) existing.role = p.role;
    else plan.members.push({ villagerId: p.villagerId, villagerName: name, role: p.role });
    plan.lastTick = this.tick;
    console.log(`[group] ${name} joined ${plan.proposerName}'s plan as "${p.role}"`);
    this.broadcast(plan);
  }

  /**
   * The plan a joiner should land on: the most recent active plan whose proposer
   * (or an existing member) is currently gathered with the joiner. Falls back to
   * the single most recent plan if gathering data is thin, so a join is rarely lost.
   */
  private planForJoiner(villagerId: string): GroupPlan | null {
    const circle = this.gatheringOf.get(villagerId);
    const active = this.all();
    if (circle) {
      for (const plan of active) {
        if (plan.members.some((m) => circle.has(m.villagerId))) return plan;
      }
    }
    return active[0] ?? null;
  }

  private expireStale(): void {
    let dropped = false;
    for (const [id, plan] of this.plans) {
      if (this.tick - plan.lastTick > PLAN_TTL_TICKS) {
        this.plans.delete(id);
        dropped = true;
      }
    }
    if (dropped) void this.persistPlans();
  }

  /** Keep only the most recent {@link MAX_ACTIVE_PLANS} plans. */
  private trim(): void {
    if (this.plans.size <= MAX_ACTIVE_PLANS) return;
    const keep = new Set(this.all().slice(0, MAX_ACTIVE_PLANS).map((p) => p.id));
    for (const id of this.plans.keys()) if (!keep.has(id)) this.plans.delete(id);
  }

  private broadcast(plan: GroupPlan): void {
    this.bus.publish(EXCHANGES.villagerTelemetry, makeEvent('villager.group_plan.updated', plan));
    void this.persistPlans();
  }

  private nameOf(id: string): string {
    return this.names.get(id) ?? id;
  }

  // -------------------------------------------------------------------------
  // Durable state: the village's shared agenda survives a reboot
  // -------------------------------------------------------------------------

  /** Reload persisted plans on boot (best-effort; a fresh store yields nothing). */
  private async restorePlans(): Promise<void> {
    if (!this.state) return;
    try {
      const saved = await this.state.get<GroupPlan[]>(GROUP_PLANS_KEY);
      if (!saved || saved.length === 0) return;
      for (const plan of saved) this.plans.set(plan.id, plan);
      console.log(`[group] restored ${this.plans.size} shared plan(s)`);
    } catch (err) {
      console.warn('[group] failed to restore plans:', errMsg(err));
    }
  }

  /** Persist the live plans after a change (fire-and-forget; never blocks). */
  private async persistPlans(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.set<GroupPlan[]>(GROUP_PLANS_KEY, this.all());
    } catch (err) {
      console.warn('[group] failed to persist plans:', errMsg(err));
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Convenience for prompt/UI: a one-line summary of a plan's roster. */
export function summarisePlan(plan: GroupPlan): string {
  const roles = plan.members.map((m: GroupPlanMember) => `${m.villagerName} (${m.role})`).join(', ');
  return `${plan.goal} — ${roles}`;
}
