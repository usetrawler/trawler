import { clear, el, icon, inlineText, put, textOf, untrustedBlock } from "./dom.ts";
import { EvidenceStore, findingPanel } from "./evidence.ts";
import type { Host, View } from "./host.ts";
import { failureText, GROUP_LABEL, GROUPS, payloadOf, type Detail, type Group, type Item, type Payload, type Report } from "./types.ts";
import { avatar, button, chip, goalMark, GROUP_VERDICT, VERDICT_TONE, hostOf, meter, money, person, segmented, severityChip, stack, statusPill, tile, verdictChip, label as pretty } from "./ui.ts";

const POLL_MS = 5000;
const MAX_POLLS = 120;
const MAX_FAILURES = 5;

const goalTone = (reached: number, total: number) => (total === 0 ? "neutral" : reached === total ? "ok" : reached * 2 < total ? "bad" : "warn");

export function reportView(initial: Report, host: Host): View {
  const root = el("div", { class: "view report" });
  const parts = Object.fromEntries(["toolbar", "notice", "head", "tiles", "people", "baseline", "filters", "list"].map((id) => [id, el("div", { class: `part-${id}`, "data-part": id })])) as Record<string, HTMLElement>;
  put(root, ...Object.values(parts));
  const state = {
    report: initial,
    filter: "all" as "all" | Group,
    selected: null as string | null,
    detail: null as Detail | null,
    detailError: null as string | null,
    peopleOpen: false,
    baselines: [] as Array<{ number: number; label: string }>,
    baselineError: null as string | null,
    baseline: "",
    compareToken: 0,
    filterSignature: "",
    headSignature: "",
    polls: 0,
    failures: 0,
    polling: false,
    pollToken: 0,
    timer: 0,
    lastGood: new Date() as Date | null,
    stopped: null as string | null,
    active: true,
    disposed: false,
  };
  const store = new EvidenceStore(() => state.report.number, host, () => state.selected, () => renderList());

  const notice = (text: string | null, retry?: () => void) => {
    clear(parts.notice!);
    if (!text) return;
    put(parts.notice!, el("p", { class: "notice", role: retry ? "alert" : "status" }, icon("alert", 16), el("span", {}, text), retry && button("Try again", { onclick: retry })));
  };

  const openLink = () => {
    const link = button("Open in Trawler", { icon: "external", kind: "primary", attrs: { "data-role": "open-link" } });
    link.onclick = () => host.open(state.report.url);
    return link;
  };

  const headSignature = (r: Report) => JSON.stringify([r.number, r.status, r.live, r.headline, r.headlineDetail, r.target, r.model, r.plan, r.url]);

  function renderToolbar() {
    clear(parts.toolbar!);
    if (host.canGoBack()) put(parts.toolbar!, button("Back", { icon: "back", onclick: () => host.back() }));
  }

  function renderHead() {
    const r = state.report;
    const had = document.activeElement?.getAttribute("data-role") === "open-link" && parts.head!.contains(document.activeElement);
    clear(parts.head!);
    state.headSignature = headSignature(r);
    const meta = el("p", { class: "meta" }, chip(hostOf(r.target), "neutral", icon("globe", 13)), chip(r.model, "neutral", icon("cpu", 13)), r.plan && chip(r.plan, "neutral", icon("layers", 13)));
    put(parts.head!, el("section", { class: "card hero" },
      el("div", { class: "hero-top" }, el("p", { class: "eyebrow" }, el("span", { class: "mono" }, `Run #${r.number}`), statusPill(r.status, r.live)), openLink()),
      el("h1", {}, r.headline), r.headlineDetail && untrustedBlock(r.headlineDetail), meta));
    if (had) (parts.head!.querySelector('[data-role="open-link"]') as HTMLElement | null)?.focus();
  }

  function renderTiles() {
    const r = state.report;
    clear(parts.tiles!);
    const f = r.findings;
    const confirmed = f.confirmed.total;
    const others = f.refuted.total + f.inconclusive.total + f.couldNotJudge.total + f.notJudged.total;
    put(parts.tiles!, el("div", { class: "tiles" },
      tile("Confirmed defects", String(confirmed), confirmed > 0 ? "bad" : "ok", el("p", { class: "tile-sub" }, confirmed === 1 ? "confirmed by a blind replay" : "confirmed by blind replays")),
      tile("Goals reached", `${r.goals.reached}/${r.goals.total}`, goalTone(r.goals.reached, r.goals.total), meter(r.goals.reached, r.goals.total, goalTone(r.goals.reached, r.goals.total), "Goals reached")),
      tile("Cost", money(r.costUsd), "neutral", meter(r.costUsd, r.budgetUsd, r.costUsd >= r.budgetUsd ? "warn" : "info", "Cost against cap", money), el("p", { class: "tile-sub" }, `of a ${money(r.budgetUsd)} cap`)),
      tile("Findings", String(confirmed + others + f.friction.total), "neutral",
        stack([{ value: confirmed, tone: "bad", label: "confirmed" }, { value: f.inconclusive.total, tone: "warn", label: "inconclusive" }, { value: f.refuted.total, tone: "ok", label: "refuted" }, { value: f.couldNotJudge.total + f.notJudged.total, tone: "neutral", label: "not judged" }, { value: f.friction.total, tone: "info", label: "friction" }]),
        el("p", { class: "tile-sub" }, `${f.refuted.total} refuted · ${f.inconclusive.total} inconclusive`))));
  }

  function renderPeople() {
    const r = state.report;
    const had = document.activeElement?.tagName === "SUMMARY" && parts.people!.contains(document.activeElement);
    clear(parts.people!);
    if (r.people.length === 0) return;
    const goalLine = (g: Report["people"][number]["goals"][number]) => el("li", {}, goalMark(g.status), el("span", { class: "goal-text" }, inlineText(g.goal), g.note && untrustedBlock(g.note, "p")));
    const card = (p: Report["people"][number]) => el("li", { class: "person-card" }, el("div", { class: "person-head" }, avatar(p.name, 32), el("div", {}, el("strong", {}, p.name), el("p", { class: "muted small" }, `${pretty(p.state)} · ${p.defects} ${p.defects === 1 ? "defect" : "defects"}${p.friction ? ` · ${p.friction} friction` : ""}`))), el("ul", { class: "goals" }, ...p.goals.map(goalLine)));
    const details = el("details", { class: "card fold", ...(state.peopleOpen ? { open: true } : {}) }, el("summary", {}, el("span", {}, `People and goals`), el("span", { class: "muted" }, `${r.people.length}`), icon("chevron", 16)), el("ul", { class: "people-grid" }, ...r.people.map(card)));
    details.ontoggle = () => { state.peopleOpen = details.open; };
    parts.people!.append(details);
    if (had) details.querySelector("summary")?.focus();
  }

  function renderBaseline() {
    clear(parts.baseline!);
    if (state.baselineError) { put(parts.baseline!, el("p", { class: "muted small" }, state.baselineError)); return; }
    if (state.baselines.length === 0) return;
    const select = el("select", { id: "baseline-select" }, el("option", { value: "" }, "Choose a run"), ...state.baselines.map((b) => el("option", { value: String(b.number) }, b.label)));
    select.onchange = () => { state.baseline = select.value; void compareWithBaseline(); };
    put(parts.baseline!, el("label", { class: "field", for: "baseline-select" }, el("span", {}, icon("layers", 15), "Compare with an earlier run"), select));
  }

  const filterSignature = (r: Report) => GROUPS.map((g) => r.findings[g].total).join(",");

  function renderFilters() {
    const r = state.report;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.filter;
    clear(parts.filters!);
    state.filterSignature = filterSignature(r);
    if (state.filter !== "all" && r.findings[state.filter].total === 0) state.filter = "all";
    const total = GROUPS.reduce((n, g) => n + r.findings[g].total, 0);
    if (total === 0) return;
    const options = [{ value: "all", label: "All", count: total }, ...GROUPS.filter((g) => r.findings[g].total > 0).map((g) => ({ value: g, label: GROUP_LABEL[g], count: r.findings[g].total }))];
    put(parts.filters!, segmented(options, state.filter, (value) => { state.filter = value as "all" | Group; renderFilters(); renderList(); (parts.filters!.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus(); }, "Filter findings"));
    if (focused) ((parts.filters!.querySelector(`[data-filter="${CSS.escape(focused)}"]`) ?? parts.filters!.querySelector('[aria-pressed="true"]')) as HTMLElement | null)?.focus();
  }

  const shownItems = (): Item[] => GROUPS.filter((g) => state.filter === "all" || state.filter === g).flatMap((g) => state.report.findings[g].items);

  function renderList() {
    const r = state.report;
    const active = document.activeElement as HTMLElement | null;
    const focusedKey = active?.dataset?.key;
    const titleHadFocus = active?.dataset?.role === "detail-title";
    const focusedEvidence = active?.dataset?.ref ? `[data-ref="${CSS.escape(active.dataset.ref)}"][data-role="${active.dataset.role ?? "show"}"]` : null;
    clear(parts.list!);
    const items = shownItems();
    if (items.length === 0) {
      put(parts.list!, el("div", { class: "empty" }, el("p", {}, GROUPS.every((g) => r.findings[g].total === 0) ? (r.live ? "No findings yet. They appear here as the people report them." : "Nobody reported a finding in this run.") : "No findings in this group.")));
      return;
    }
    const cards = items.map((i) => {
      const open = state.selected === i.key;
      const header = el("button", { type: "button", class: "finding-head", "data-key": i.key, "aria-expanded": open },
        el("span", { class: `rail tone-${VERDICT_TONE[GROUP_VERDICT[i.group] ?? ""] ?? "neutral"}`, "aria-hidden": "true" }),
        el("span", { class: "finding-main" }, el("span", { class: "finding-title" }, i.title.text),
          el("span", { class: "finding-meta" }, severityChip(i.severity), person(i.person, 18), i.evidence > 0 && chip(String(i.evidence), "neutral", icon("camera", 12)))),
        verdictChip(GROUP_VERDICT[i.group] ?? null), icon("chevron", 16));
      header.onclick = () => void openFinding(i.key);
      const card = el("li", { class: `card finding${open ? " open" : ""}` }, header);
      if (open) {
        if (state.detailError) card.append(el("p", { class: "notice", role: "alert", "data-role": "detail-error", tabindex: titleHadFocus ? "-1" : undefined }, state.detailError));
        else if (state.detail) card.append(findingPanel(state.detail, store, { "data-role": "detail-title", tabindex: "-1" }));
        else card.append(el("p", { class: "muted", style: "padding:0 18px 14px" }, "Loading…"));
      }
      return card;
    });
    put(parts.list!, el("ul", { class: "findings", "aria-label": "Findings" }, ...cards), ...GROUPS.filter((g) => r.findings[g].more > 0 && (state.filter === "all" || state.filter === g)).map((g) => el("p", { class: "muted small" }, `…${r.findings[g].more} more ${GROUP_LABEL[g].toLowerCase()} not shown. Open the run in Trawler to see them all.`)));
    if (focusedKey) (parts.list!.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`) as HTMLElement | null)?.focus();
    if (titleHadFocus) (parts.list!.querySelector('[data-role="detail-title"], [data-role="detail-error"]') as HTMLElement | null)?.focus();
    if (focusedEvidence) ((parts.list!.querySelector(focusedEvidence) ?? parts.list!.querySelector(focusedEvidence.replace(/\[data-role="[^"]*"\]/, '[data-role="show"]'))) as HTMLElement | null)?.focus();
  }

  async function openFinding(key: string, moveFocus = true) {
    const r = state.report;
    if (state.selected === key && moveFocus && (state.detail || state.detailError)) { state.selected = null; state.detail = null; state.detailError = null; store.reset(); renderList(); return; }
    state.selected = key;
    if (moveFocus) { state.detail = null; store.reset(); }
    state.detailError = null;
    renderList();
    const result = await host.call("get_finding", { run: r.number, finding: key }).catch(() => null);
    if (state.disposed || state.selected !== key || state.report.number !== r.number) return;
    if (!result || result.isError) state.detailError = result ? failureText(result) : "Could not load this finding. Try again.";
    else state.detail = result.structuredContent as Detail;
    renderList();
    if (moveFocus) (parts.list!.querySelector('[data-role="detail-title"], [data-role="detail-error"]') as HTMLElement | null)?.focus();
  }

  async function compareWithBaseline() {
    const token = ++state.compareToken;
    if (!state.baseline) return;
    const r = state.report;
    const result = await host.call("compare_runs", { base: Number(state.baseline), head: r.number }).catch(() => null);
    if (state.disposed || token !== state.compareToken) return;
    if (!result || result.isError) { notice(result ? failureText(result) : "Could not compare these runs. Try again."); return; }
    const payload = payloadOf(result.structuredContent);
    if (!payload || payload.view !== "compare") { notice("Could not compare these runs. Try again."); return; }
    notice(null);
    const select = parts.baseline!.querySelector("select") as HTMLSelectElement | null;
    if (select) select.value = "";
    state.baseline = "";
    host.show(payload);
  }

  async function loadBaselines() {
    const r = state.report;
    const result = await host.call("list_runs", { project: r.project.id, limit: 50, before: r.number }).catch(() => null);
    if (state.disposed || state.report.number !== r.number) return;
    if (!result || result.isError) { state.baselineError = `Could not load earlier runs to compare with. ${result ? failureText(result) : ""}`.trim(); renderBaseline(); return; }
    state.baselineError = null;
    const runs = (result.structuredContent as { runs: Array<{ number: number; status: string; confirmedDefects: number; createdAt: string | null }> }).runs;
    state.baselines = runs.map((x) => ({ number: x.number, label: `#${x.number} · ${pretty(x.status)} · ${x.confirmedDefects} confirmed${x.createdAt ? ` · ${x.createdAt.slice(0, 10)}` : ""}` }));
    renderBaseline();
  }

  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function stopPolling(reason: string | null) {
    window.clearTimeout(state.timer);
    state.timer = 0;
    state.stopped = reason;
    state.pollToken += 1;
    state.polling = false;
  }

  const resume = () => { state.stopped = null; state.polls = 0; state.failures = 0; notice(null); schedulePolling(); };

  function schedulePolling() {
    window.clearTimeout(state.timer);
    state.timer = 0;
    if (state.disposed || !state.active || !state.report.live || document.hidden || state.stopped === "closed" || state.polling) return;
    if (state.polls >= MAX_POLLS) { stopPolling("limit"); notice("Live updates stopped after ten minutes.", resume); return; }
    state.timer = window.setTimeout(() => void poll(), POLL_MS);
  }

  async function poll() {
    if (state.polling) return;
    const number = state.report.number;
    state.polling = true;
    state.polls += 1;
    const token = state.pollToken;
    const result = await host.call("get_run", { run: number }).catch(() => null);
    if (token === state.pollToken) state.polling = false;
    if (token !== state.pollToken || state.disposed || state.stopped === "closed" || state.report.number !== number) return;
    const valid = result && !result.isError && (result.structuredContent as Report | undefined)?.findings;
    if (!valid) {
      state.failures += 1;
      const when = state.lastGood ? ` Showing the last result from ${time(state.lastGood)}.` : "";
      if (state.failures >= MAX_FAILURES) { stopPolling("connection"); notice(`Could not refresh this run.${when}`, resume); return; }
      notice(`Could not refresh this run, trying again.${when}`);
      schedulePolling();
      return;
    }
    state.failures = 0;
    state.lastGood = new Date();
    notice(null);
    apply(result.structuredContent as Report);
  }

  function apply(report: Report) {
    const was = state.report;
    state.report = report;
    if (headSignature(report) !== state.headSignature) renderHead();
    renderTiles();
    const staleFilter = state.filter !== "all" && report.findings[state.filter].total === 0;
    if (staleFilter) state.filter = "all";
    if (staleFilter || filterSignature(report) !== state.filterSignature) renderFilters();
    if (JSON.stringify(was.people) !== JSON.stringify(report.people)) renderPeople();
    renderList();
    if (was.status !== report.status) {
      host.announce(`Run ${report.number} is now ${pretty(report.status)}.`);
      if (state.selected && !report.live) void openFinding(state.selected, false);
    }
    if (report.live) schedulePolling(); else stopPolling(null);
  }

  renderToolbar(); renderHead(); renderTiles(); renderPeople(); renderFilters(); renderList();
  void loadBaselines();
  if (initial.live) schedulePolling();

  document.addEventListener("visibilitychange", onVisibility);
  function onVisibility() {
    if (document.hidden) { window.clearTimeout(state.timer); state.timer = 0; } else if (!state.stopped) schedulePolling();
  }

  return {
    el: root,
    key: `run:${initial.number}`,
    dispose() { state.disposed = true; stopPolling("closed"); document.removeEventListener("visibilitychange", onVisibility); },
    setActive(active) { state.active = active; if (active) { renderToolbar(); if (!state.stopped) schedulePolling(); } else { window.clearTimeout(state.timer); state.timer = 0; } },
    update(payload) { if (payload.view === "report" && payload.data.number === state.report.number) { state.polls = 0; state.failures = 0; state.stopped = null; state.lastGood = new Date(); notice(null); apply(payload.data); } },
  };
}

export { textOf };
