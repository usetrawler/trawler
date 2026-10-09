import { el, icon, put } from "./dom.ts";
import type { Host, View } from "./host.ts";
import type { Started, Stopped } from "./types.ts";
import { button, chip, meter, money, statusPill, tile } from "./ui.ts";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function startedView(s: Started, host: Host): View {
  const root = el("div", { class: "view control" });
  const limit = s.limit;
  put(root, el("section", { class: "card hero ok-hero" },
    el("p", { class: "eyebrow" }, el("span", { class: "mono" }, `Run #${s.number}`), !s.replayed && statusPill("queued")),
    el("h1", {}, s.replayed ? "This run was already started" : "Run started"),
    el("p", { class: "muted" }, "It runs in the background. Ask for the run again to see its report."),
    el("p", { class: "meta" }, chip(`${s.people} ${s.people === 1 ? "person" : "people"}`, "neutral"), s.replayed && chip("same idempotency key", "info")),
    button("Open in Trawler", { icon: "external", kind: "primary", onclick: () => host.open(s.url), attrs: { "data-role": "open-link" } })));
  if (limit) {
    const tone = (a: number, b: number) => (a >= b ? "bad" : a / b > 0.75 ? "warn" : "ok");
    put(root, el("section", { class: "card block" }, el("h2", {}, icon("coins", 17), "This connection's limit, last 24 hours"),
      el("div", { class: "tiles" },
        tile("Runs", `${limit.runs}/${limit.runsPerDay}`, tone(limit.runs, limit.runsPerDay), meter(limit.runs, limit.runsPerDay, tone(limit.runs, limit.runsPerDay), "Runs used")),
        tile("Spent or set aside", money(limit.spentUsd), tone(limit.spentUsd, limit.spendUsdPerDay), meter(limit.spentUsd, limit.spendUsdPerDay, tone(limit.spentUsd, limit.spendUsdPerDay), "Spend used", money), el("p", { class: "tile-sub" }, `of ${money(limit.spendUsdPerDay)}`))),
      limit.nextFreeAt && el("p", { class: "muted small" }, `The oldest start leaves the window at ${when(limit.nextFreeAt)}.`)));
  }
  return { el: root, dispose() {} };
}

export function stoppedView(s: Stopped, host: Host): View {
  const root = el("div", { class: "view control" });
  if (host.canGoBack()) put(root, el("div", { class: "toolbar" }, button("Back", { icon: "back", onclick: () => host.back() })));
  put(root, el("section", { class: "card hero" }, el("p", { class: "eyebrow" }, statusPill(s.status)),
    el("h1", {}, s.stopped ? "Run stopped" : "Nothing to stop"),
    el("p", { class: "muted" }, s.stopped ? "The run was stopped and what it had found is kept. Its unused cap went back to this connection's limit." : `The run is already ${s.status.replaceAll("_", " ")}.`)));
  return { el: root, dispose() {} };
}
