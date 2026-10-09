import { el, icon, put } from "./dom.ts";
import { type Host, type View } from "./host.ts";
import { failureText, payloadOf, type RunList } from "./types.ts";
import { button, chip, empty, meter, money, segmented, shortDate, statusPill } from "./ui.ts";

const goalTone = (reached: number, total: number) => (total === 0 ? "neutral" : reached === total ? "ok" : reached * 2 < total ? "bad" : "warn");

export function runsView(initial: RunList, host: Host, args: Record<string, unknown> = {}): View {
  const root = el("div", { class: "view runs" });
  const state = { list: initial, status: (args.status as string | undefined) ?? "all", loading: false, opening: false, disposed: false, pending: null as Record<string, unknown> | null, error: null as string | null, filterKept: args };
  const slot = el("div", {});
  const toolbar = el("div", { class: "toolbar" });
  put(root, toolbar, el("h1", { class: "title" }, "Runs"), slot);

  async function open(number: number) {
    if (state.opening) return;
    state.opening = true;
    const result = await host.call("get_run", { run: number }).catch(() => null);
    state.opening = false;
    if (state.disposed) return;
    const payload = result && !result.isError ? payloadOf(result.structuredContent) : null;
    if (!payload || payload.view !== "report") { state.error = result && result.isError ? failureText(result) : "Could not open this run."; render(); return; }
    state.error = null;
    host.show(payload);
  }

  async function reload(extra: Record<string, unknown>) {
    if (state.loading) { state.pending = extra; return; }
    state.loading = true;
    state.error = null;
    render();
    const next = { ...state.filterKept, ...extra };
    const result = await host.call("list_runs", { ...next, limit: 20 }).catch(() => null);
    state.loading = false;
    if (state.disposed) return;
    if (!result || result.isError) { state.error = result ? failureText(result) : "Could not load runs."; render(); return; }
    state.filterKept = next;
    state.status = (next.status as string | undefined) ?? "all";
    state.list = extra.before ? { ...(result.structuredContent as RunList), runs: [...state.list.runs, ...(result.structuredContent as RunList).runs] } : (result.structuredContent as RunList);
    render();
    const pending = state.pending;
    state.pending = null;
    if (pending) void reload(pending);
  }

  function renderToolbar() {
    toolbar.replaceChildren();
    if (host.canGoBack()) put(toolbar, button("Back", { icon: "back", onclick: () => host.back() }));
  }

  function render() {
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.dataset?.filter ? `[data-filter="${CSS.escape(active.dataset.filter)}"]` : active?.dataset?.role === "older-runs" ? '[data-role="older-runs"]' : active?.dataset?.run ? `[data-run="${CSS.escape(active.dataset.run)}"]` : null;
    renderToolbar();
    const l = state.list;
    slot.replaceChildren();
    put(slot,
      segmented([{ value: "all", label: "All", count: l.counts.all }, { value: "completed", label: "Completed", count: l.counts.completed }, { value: "attention", label: "Needs attention", count: l.counts.attention }], state.status, (value) => void reload({ status: value, before: undefined }), "Filter runs"),
      state.error && el("p", { class: "notice", role: "alert" }, icon("alert", 16), el("span", {}, state.error)),
      l.runs.length === 0 ? empty("No runs here.", "Start one from the app or ask the assistant to start it.") : el("ul", { class: "run-rows", "aria-label": "Runs", ...(state.loading ? { "aria-busy": "true" } : {}) }, ...l.runs.map((r) => {
        const row = el("button", { type: "button", class: "run-row card", "data-run": r.number },
          el("span", { class: "run-id mono" }, `#${r.number}`), statusPill(r.status),
          el("span", { class: "run-what" }, el("strong", {}, r.project.name), el("span", { class: "muted small" }, r.plan ?? shortDate(r.createdAt))),
          el("span", { class: "run-goals" }, el("span", { class: "small" }, `${r.goalsReached}/${r.goalsTotal} goals`), meter(r.goalsReached, r.goalsTotal, goalTone(r.goalsReached, r.goalsTotal), "Goals reached")),
          chip(`${r.confirmedDefects} ${r.confirmedDefects === 1 ? "defect" : "defects"}${r.hasUncheckedDefects ? " +" : ""}`, r.confirmedDefects > 0 ? "bad" : "ok"),
          el("span", { class: "run-cost small muted" }, money(r.costUsd)), icon("arrow", 15));
        row.onclick = () => void open(r.number);
        return el("li", {}, row);
      })),
      l.nextBefore !== null && button(state.loading ? "Loading…" : "Older runs", { attrs: { "data-role": "older-runs" }, onclick: () => void reload({ before: l.nextBefore }) }));
    if (focused) (slot.querySelector(focused) as HTMLElement | null)?.focus();
  }
  render();
  return { el: root, dispose() { state.disposed = true; }, setActive(active) { if (active) renderToolbar(); } };
}
