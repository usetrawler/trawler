export function revealCurrentEntry(nav: Element | null | undefined) {
  const entry = nav?.querySelector("[aria-current]");
  if (!nav || !entry) return;
  const gap = 8;
  const row = nav.getBoundingClientRect();
  const box = entry.getBoundingClientRect();
  if (box.left < row.left + gap) nav.scrollLeft -= row.left + gap - box.left;
  else if (box.right > row.right - gap) nav.scrollLeft += Math.min(box.right - (row.right - gap), box.left - (row.left + gap));
}

export const CURRENT_ENTRY_SCRIPT = `(${revealCurrentEntry.toString()})(document.currentScript&&document.currentScript.previousElementSibling)`;
