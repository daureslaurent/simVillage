/**
 * client/src/GroupActivitiesPanel.ts
 * ---------------------------------------------------------------------------
 * The SHARED-PLANS / agenda view. When a knot of villagers turns talk into a
 * coordinated effort, one proposes a plan and others commit to roles; this panel
 * shows every live plan as a card — a kind badge (work / prayer / social / build), the
 * shared goal, and who took which part.
 *
 * Seeded from `GET /group-plans` and updated live as `group_plan.updated`
 * messages arrive. Plans expire server-side once they go quiet, so the list
 * stays a window onto what the village is *currently* doing together.
 * ---------------------------------------------------------------------------
 */

import type { GroupPlan, GroupPlanMessage } from '../../shared/types';
import { escapeHtml } from './modal';
import { makeVlifeCard, type VlifeCard } from './vlife';

export interface GroupActivitiesPanelOptions {
  /** Fetch the active plans once at startup. */
  onFetch: () => Promise<GroupPlan[]>;
}

export class GroupActivitiesPanel {
  private readonly card: VlifeCard;
  private readonly plans = new Map<string, GroupPlan>();

  constructor(root: HTMLElement, options: GroupActivitiesPanelOptions) {
    this.card = makeVlifeCard(root, { icon: '📋', title: 'Shared Plans' });
    this.render();
    void options
      .onFetch()
      .then((plans) => {
        for (const p of plans) this.plans.set(p.id, p);
        this.render();
      })
      .catch(() => {
        /* empty until the first live plan */
      });
  }

  /** Fold one opened/joined plan into the view. */
  ingest(message: GroupPlanMessage): void {
    this.plans.set(message.plan.id, message.plan);
    this.prune();
    this.render();
  }

  /** Keep only the most recently-touched dozen, so a long session doesn't pile up. */
  private prune(): void {
    if (this.plans.size <= 12) return;
    const keep = [...this.plans.values()]
      .sort((a, b) => b.lastTick - a.lastTick)
      .slice(0, 12);
    this.plans.clear();
    for (const p of keep) this.plans.set(p.id, p);
  }

  private render(): void {
    const plans = [...this.plans.values()].sort((a, b) => b.lastTick - a.lastTick);
    this.card.setCount(plans.length);

    if (plans.length === 0) {
      this.card.body.innerHTML = `<div class="vlife__empty">No shared plans afoot — villagers form them when they gather.</div>`;
      return;
    }

    this.card.body.innerHTML = plans.map((p) => this.renderPlan(p)).join('');
  }

  private renderPlan(plan: GroupPlan): string {
    const roles = plan.members
      .map(
        (m) =>
          `<div class="plan__role"><span class="plan__rolename">${escapeHtml(m.villagerName)}</span><span>${escapeHtml(m.role)}</span></div>`,
      )
      .join('');
    return `
      <div class="plan">
        <div class="plan__top">
          <span class="plan__badge plan__badge--${plan.kind}">${plan.kind}</span>
          <span class="plan__goal">${escapeHtml(plan.goal)}</span>
        </div>
        ${roles}
      </div>`;
  }
}
