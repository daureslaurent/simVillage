/**
 * client/src/PrayersPanel.ts
 * ---------------------------------------------------------------------------
 * The PRAYER feed — the petitions villagers offer at the Temple of the Dawn, in
 * the order they are spoken. It is a quiet record of the village's faith: who
 * prayed, and for what. (Granting or denying a prayer is the Supervisor console's
 * job; this panel just listens.)
 *
 * Fed live from the same `supervisor.prayer` stream the Supervisor console reads,
 * so no extra server wiring is needed.
 * ---------------------------------------------------------------------------
 */

import type { SupervisorPrayerMessage } from '../../shared/types';
import { escapeHtml } from './modal';
import { makeVlifeCard, type VlifeCard } from './vlife';

/** How many recent prayers to keep in the feed. */
const MAX_PRAYERS = 40;

export class PrayersPanel {
  private readonly card: VlifeCard;
  private count = 0;

  constructor(root: HTMLElement) {
    this.card = makeVlifeCard(root, { icon: '🙏', title: 'Prayers' });
    this.render();
  }

  /** Append one freshly-offered prayer to the top of the feed. */
  ingest(prayer: SupervisorPrayerMessage): void {
    if (this.count === 0) this.card.body.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'prayer';
    row.innerHTML =
      `<span class="prayer__who">${escapeHtml(firstName(prayer.villagerName))}</span>` +
      `<span class="prayer__msg">${escapeHtml(prayer.message)}</span>`;
    this.card.body.prepend(row);
    this.count++;
    while (this.card.body.childElementCount > MAX_PRAYERS) {
      this.card.body.lastElementChild?.remove();
      this.count--;
    }
    this.card.setCount(this.count);
  }

  private render(): void {
    this.card.body.innerHTML = `<div class="vlife__empty">No prayers offered yet — the Temple waits.</div>`;
    this.card.setCount(0);
  }
}

/** Just the given name, to keep the prayer feed compact. */
function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
