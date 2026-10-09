import { el, put } from "./dom.ts";
import { EvidenceStore, findingPanel } from "./evidence.ts";
import type { Host, View } from "./host.ts";
import type { Detail } from "./types.ts";
import { button, chip, person, severityChip, verdictChip, GROUP_VERDICT } from "./ui.ts";

export function findingView(detail: Detail, host: Host): View {
  const root = el("div", { class: "view finding" });
  const slot = el("div", {});
  const store = new EvidenceStore(() => detail.run, host, () => detail.key, () => render());
  function render() {
    const active = document.activeElement as HTMLElement | null;
    const ref = active?.dataset?.ref ? `[data-ref="${CSS.escape(active.dataset.ref)}"][data-role="${active.dataset.role ?? "show"}"]` : null;
    slot.replaceChildren();
    put(slot, el("section", { class: "card hero" }, el("p", { class: "eyebrow" }, el("span", { class: "mono" }, `Run #${detail.run}`), chip(detail.key, "neutral"), verdictChip(GROUP_VERDICT[detail.group] ?? null)),
      el("h1", {}, detail.title.text), el("p", { class: "meta" }, severityChip(detail.severity), person(detail.person, 20), detail.groupedUnder && chip(`grouped under ${detail.groupedUnder}`, "neutral"))), findingPanel(detail, store));
    if (ref) (slot.querySelector(ref) as HTMLElement | null)?.focus();
  }
  if (host.canGoBack()) put(root, el("div", { class: "toolbar" }, button("Back", { icon: "back", onclick: () => host.back() })));
  put(root, slot);
  render();
  return { el: root, dispose() {} };
}
