/**
 * client/src/RelationshipsPanel.ts
 * ---------------------------------------------------------------------------
 * The RELATIONSHIPS view — who in the village thinks what of whom. Each villager
 * has a small social book (an affinity score and an evolving opinion per
 * neighbour) revised each night by its reflection; this panel shows them all,
 * one collapsible person at a time, with a centre-anchored warmth meter (fills
 * right for fondness, left for coolness) and the villager's own words beneath.
 *
 * Seeded from `GET /relationships` and updated live as `relationship.updated`
 * messages arrive after each nightly reflection.
 * ---------------------------------------------------------------------------
 */

import type { Relationship, RelationshipUpdateMessage } from '../../shared/types';
import { escapeHtml } from './modal';
import { makeVlifeCard, type VlifeCard } from './vlife';

/** One villager's whole social book, as served / pushed. */
export interface VillagerBook {
  villagerId: string;
  villagerName: string;
  relationships: Relationship[];
}

export interface RelationshipsPanelOptions {
  /** Fetch the initial books (every villager's standing) once at startup. */
  onFetch: () => Promise<VillagerBook[]>;
  /** Resolve a villager id to its map colour, for the person swatch. */
  colorOf?: (villagerId: string) => string | undefined;
}

export class RelationshipsPanel {
  private readonly card: VlifeCard;
  private readonly books = new Map<string, VillagerBook>();
  private readonly colorOf: (id: string) => string | undefined;

  constructor(root: HTMLElement, options: RelationshipsPanelOptions) {
    this.card = makeVlifeCard(root, { icon: '🫂', title: 'Relationships' });
    this.colorOf = options.colorOf ?? (() => undefined);
    this.render();
    void options
      .onFetch()
      .then((books) => {
        for (const b of books) this.books.set(b.villagerId, b);
        this.render();
      })
      .catch(() => {
        /* the view simply stays empty until the first live update */
      });
  }

  /** Fold one villager's freshly-revised book into the view. */
  ingest(message: RelationshipUpdateMessage): void {
    this.books.set(message.villagerId, {
      villagerId: message.villagerId,
      villagerName: message.villagerName,
      relationships: message.relationships,
    });
    this.render();
  }

  private render(): void {
    const books = [...this.books.values()]
      .filter((b) => b.relationships.length > 0)
      .sort((a, b) => a.villagerName.localeCompare(b.villagerName));
    this.card.setCount(books.length);

    if (books.length === 0) {
      this.card.body.innerHTML = `<div class="vlife__empty">No opinions yet — villagers form them as they live and reflect.</div>`;
      return;
    }

    this.card.body.innerHTML = books.map((b) => this.renderPerson(b)).join('');
  }

  private renderPerson(book: VillagerBook): string {
    const swatch = this.colorOf(book.villagerId);
    const ties = book.relationships
      .slice()
      .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity))
      .map((r) => this.renderTie(r))
      .join('');
    return `
      <div class="rel__person">
        <div class="rel__who">
          ${swatch ? `<span class="rel__swatch" style="background:${escapeAttr(swatch)}"></span>` : ''}
          <span class="rel__name">${escapeHtml(book.villagerName)}</span>
        </div>
        ${ties}
      </div>`;
  }

  private renderTie(r: Relationship): string {
    const pct = (Math.min(100, Math.abs(r.affinity)) / 100) * 50; // half-width max
    const warm = r.affinity >= 0;
    const left = warm ? 50 : 50 - pct;
    const color = warm ? 'var(--ok)' : 'var(--danger)';
    const sign = r.affinity > 0 ? '+' : '';
    const opinion = r.opinion
      ? `<div class="rel__opinion">“${escapeHtml(r.opinion)}”</div>`
      : '';
    return `
      <div class="rel__tie" title="${sign}${r.affinity}">
        <span class="rel__other">${escapeHtml(r.otherName)}</span>
        <span class="rel__meter"><span class="rel__fill" style="left:${left}%;width:${pct}%;background:${color}"></span></span>
        ${opinion}
      </div>`;
  }
}

/** Escape a value destined for an HTML attribute (e.g. a CSS color). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
