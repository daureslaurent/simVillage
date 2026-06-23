/**
 * client/src/vlife.ts
 * ---------------------------------------------------------------------------
 * A tiny shared chrome for the "Village Life" rail panels (relationships,
 * shared plans, prayers). Each is a collapsible card with an icon, a title, a
 * live count badge, and a scrollable body — built once here so the three panels
 * stay visually identical and the collapse behaviour lives in one place.
 * ---------------------------------------------------------------------------
 */

export interface VlifeCard {
  /** The scrollable content host the panel fills. */
  readonly body: HTMLElement;
  /** Set the little count badge in the header (hidden when 0). */
  setCount(n: number): void;
}

/** Turn a host element into a collapsible Village-Life card and return its body. */
export function makeVlifeCard(
  root: HTMLElement,
  options: { icon: string; title: string; startCollapsed?: boolean },
): VlifeCard {
  root.classList.add('vlife');
  if (options.startCollapsed) root.classList.add('vlife--collapsed');
  root.innerHTML = `
    <header class="vlife__head">
      <span class="vlife__caret">▾</span>
      <span class="vlife__icon">${options.icon}</span>
      <span class="vlife__title">${options.title}</span>
      <span class="vlife__count" hidden>0</span>
    </header>
    <div class="vlife__body"></div>`;
  const head = root.querySelector('.vlife__head')!;
  const body = root.querySelector('.vlife__body') as HTMLElement;
  const count = root.querySelector('.vlife__count') as HTMLElement;
  head.addEventListener('click', () => root.classList.toggle('vlife--collapsed'));
  return {
    body,
    setCount(n: number): void {
      count.hidden = n <= 0;
      count.textContent = String(n);
    },
  };
}
