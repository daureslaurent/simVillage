/**
 * client/src/modal.ts
 * ---------------------------------------------------------------------------
 * One shared modal overlay for the whole app. A single `.modal-root` is created
 * lazily on <body> and reused: callers hand in a header and a body (HTML they
 * have already escaped) and the modal renders it centered over a dimmed
 * backdrop. Clicking the backdrop, the ✕, or pressing Escape closes it.
 *
 * Keeping this in one place means the roster's "LLM data" modal and the
 * conversations transcript modal look and behave identically, and there is never
 * more than one overlay in the DOM.
 * ---------------------------------------------------------------------------
 */

let root: HTMLElement | null = null;

function ensureRoot(): HTMLElement {
  if (root) return root;
  const el = document.createElement('div');
  el.className = 'modal-root';
  el.hidden = true;
  el.addEventListener('click', (e) => {
    if (e.target === el) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  document.body.appendChild(el);
  root = el;
  return el;
}

/** Open the modal with the given header and (already-escaped) body HTML. */
export function showModal(headerHtml: string, bodyHtml: string): void {
  const el = ensureRoot();
  el.innerHTML = `
    <div class="modal">
      <header class="modal__head">
        <span>${headerHtml}</span>
        <button class="modal__close" title="Close">✕</button>
      </header>
      <div class="modal__body">${bodyHtml}</div>
    </div>`;
  el.querySelector('.modal__close')!.addEventListener('click', () => closeModal());
  el.hidden = false;
}

export function closeModal(): void {
  if (!root) return;
  root.hidden = true;
  root.replaceChildren();
}

/** Minimal HTML-escape for untrusted text placed into modal markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
