import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { clear, el, inlineText, put, textOf, untrustedBlock, type Goal, type Untrusted } from "./dom.ts";

const GROUPS = ["confirmed", "refuted", "inconclusive", "couldNotJudge", "notJudged", "friction", "dismissed"] as const;
type Group = (typeof GROUPS)[number];
const GROUP_LABEL: Record<Group, string> = { confirmed: "Confirmed by replay", refuted: "Refuted", inconclusive: "Inconclusive", couldNotJudge: "Could not be judged", notJudged: "Not judged", friction: "Friction", dismissed: "Marked not a bug" };
const POLL_MS = 5000;
const MAX_POLLS = 120;
const MAX_FAILURES = 5;

interface Item { key: string; group: string; severity: string; verdict: string | null; person: string; goal: Goal; title: Untrusted; evidence: number; reason?: Untrusted }
interface Report {
  id: string; number: number; url: string; status: string; live: boolean; headline: string; headlineDetail: Untrusted | null; project: { id: string }; plan: string | null; target: string; model: string;
  costUsd: number; budgetUsd: number; goals: { reached: number; total: number; notReached: Goal[] };
  people: Array<{ id: string; name: string; state: string; defects: number; friction: number; goals: Array<{ id: string; goal: Goal; status: string | null; note: Untrusted | null }> }>;
  findings: Record<Group, { total: number; more: number; items: Item[] }>;
}
interface Compared {
  swapped: boolean; base: { number: number; headline: string; headlineDetail: Untrusted | null; status: string }; head: { number: number; headline: string; headlineDetail: Untrusted | null; status: string };
  goals: { items: Array<{ person: string; goal: Goal; base: string; head: string; change: string }>; total: number; more: number; unchanged: number };
  findings: {
    stillReported: { items: Array<{ title: Untrusted; goal: Goal; base: { key: string; verdict: string }; head: { key: string; verdict: string } }>; total: number; more: number };
    onlyInBase: { items: Array<{ key: string; verdict: string; title: Untrusted; goal: Goal; goalInHead: string }>; total: number; more: number };
    onlyInHead: { items: Array<{ key: string; verdict: string; title: Untrusted; goal: Goal }>; total: number; more: number };
  };
  caveats: string[];
}
interface Detail {
  key: string; group: string; severity: string; verdict: string | null; person: string; goal: Goal; groupedUnder: string | null;
  title: Untrusted; observed: Untrusted; reproduction: Untrusted; quote: Untrusted | null; page: Untrusted | null;
  replay: { completed: boolean | null; observed: Untrusted | null } | null; sameReports: Array<{ key: string; title: Untrusted }>;
  dismissal: { reason: Untrusted; by: string; at: string | null } | null; evidence: Array<{ ref: string; kind: "screenshot" | "trail"; label: string }>;
}
type Result = { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

const app = new App({ name: "Trawler run report", version: "1.0.0" }, {}, { autoResize: true });
const root = document.getElementById("app")!;
const parts = Object.fromEntries(["notice", "head", "summary", "people", "baseline", "compare", "filters", "list", "detail"].map((id) => [id, el("div", { id })])) as Record<string, HTMLElement>;
root.append(el("p", { class: "sr-only", id: "status", role: "status", "aria-live": "polite" }), ...Object.values(parts));
const status = document.getElementById("status")!;

const state = {
  report: null as Report | null,
  compared: null as Compared | null,
  baselines: [] as Array<{ number: number; label: string }>,
  baselineError: null as string | null,
  baseline: "",
  filter: "all" as "all" | Group,
  selected: null as string | null,
  detail: null as Detail | null,
  detailError: null as string | null,
  evidenceErrors: new Map<string, string>(),
  peopleOpen: false,
  filterSignature: "",
  headSignature: "",
  compareToken: 0,
  loading: new Set<string>(),
  polling: false,
  pollToken: 0,
  evidence: new Map<string, { kind: "screenshot"; src: string; note: string } | { kind: "trail"; blocks: Untrusted[]; next: string | null }>(),
  polls: 0,
  failures: 0,
  timer: 0 as number,
  lastGood: null as Date | null,
  stopped: null as string | null,
};

const money = (usd: number) => `$${usd.toFixed(2)}`;
const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const announce = (text: string) => { status.textContent = text; };

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await app.callServerTool({ name, arguments: args })) as Result;
}
const failureText = (result: Result) => result.content?.find((c) => c.type === "text")?.text ?? "Trawler could not answer.";

function notice(text: string | null, retry?: () => void) {
  clear(parts.notice!);
  if (!text) return;
  parts.notice!.append(el("p", { class: "notice", role: retry ? "alert" : "status" }, text, retry && " ", retry && Object.assign(el("button", { type: "button" }, "Try again"), { onclick: retry })));
}

const linkNote = (url: string) => { put(parts.head!, el("p", { class: "muted", role: "status" }, `The host did not open the link. The run is at ${url}`)); };

function openInTrawler(url: string): HTMLElement {
  const link = el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, "Open in Trawler");
  link.onclick = (event) => {
    if (!app.getHostCapabilities()?.openLinks) return;
    event.preventDefault();
    void app.openLink({ url }).then((outcome) => { if ((outcome as { isError?: boolean }).isError) linkNote(url); }).catch(() => linkNote(url));
  };
  return link;
}

const headSignature = (r: Report) => JSON.stringify([r.number, r.status, r.live, r.headline, r.headlineDetail, r.target, r.model, r.plan, r.url]);

function renderHead() {
  const r = state.report;
  const linkHadFocus = !!document.activeElement && document.activeElement.tagName === "A" && parts.head!.contains(document.activeElement);
  clear(parts.head!);
  state.headSignature = r ? headSignature(r) : "";
  if (!r) return;
  put(parts.head!,
    el("p", { class: "eyebrow" }, `Run #${r.number} · `, el("span", { class: `badge status-${r.status}` }, r.status.replaceAll("_", " ")), r.live && " · live"),
    el("h1", {}, r.headline),
    r.headlineDetail && untrustedBlock(r.headlineDetail),
    el("p", { class: "muted" }, `${new URL(r.target).host} · ${r.model}${r.plan ? ` · ${r.plan}` : ""} · `, openInTrawler(r.url)),
  );
  if (linkHadFocus) parts.head!.querySelector("a")?.focus();
}

function renderSummary() {
  const r = state.report;
  clear(parts.summary!);
  if (!r) return;
  const counts = (["confirmed", "refuted", "inconclusive"] as const).map((g) => [GROUP_LABEL[g], r.findings[g].total] as const);
  parts.summary!.append(el("dl", { class: "summary" },
    ...[["Goals reached", `${r.goals.reached} of ${r.goals.total}`], ["Cost", `${money(r.costUsd)} of a ${money(r.budgetUsd)} cap`], ...counts.map(([label, n]) => [label, String(n)])].flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]),
  ));
}

function renderPeople() {
  const r = state.report;
  const summaryHadFocus = document.activeElement?.tagName === "SUMMARY" && parts.people!.contains(document.activeElement);
  clear(parts.people!);
  if (!r || r.people.length === 0) return;
  const goalLine = (g: Report["people"][number]["goals"][number]) => el("li", {}, g.status ?? "not tested", ": ", inlineText(g.goal), g.note && untrustedBlock(g.note, "p"));
  const person = (p: Report["people"][number]) => el("li", {}, el("strong", {}, p.name), ` · ${p.state}`, el("ul", {}, ...p.goals.map(goalLine)));
  const details = el("details", state.peopleOpen ? { open: true } : {}, el("summary", {}, `People and goals (${r.people.length})`), el("ul", { class: "people" }, ...r.people.map(person)));
  details.ontoggle = () => { state.peopleOpen = details.open; };
  parts.people!.append(details);
  if (summaryHadFocus) details.querySelector("summary")?.focus();
}

function renderBaseline() {
  const r = state.report;
  clear(parts.baseline!);
  if (state.baselineError) { parts.baseline!.append(el("p", { class: "muted" }, state.baselineError)); return; }
  if (!r || state.baselines.length === 0) return;
  const select = el("select", { id: "baseline-select" }, el("option", { value: "" }, "No baseline"), ...state.baselines.map((b) => el("option", { value: String(b.number), selected: String(b.number) === state.baseline }, b.label)));
  select.onchange = () => { state.baseline = select.value; void compareWithBaseline(); };
  parts.baseline!.append(el("label", { class: "field", for: "baseline-select" }, "Compare with an earlier run ", select));
}

function renderCompare() {
  const c = state.compared;
  clear(parts.compare!);
  if (!c) return;
  const section = el("section", { "aria-labelledby": "compare-title", class: "compare" }, el("h2", { id: "compare-title" }, `Run #${c.base.number} compared with run #${c.head.number}`));
  if (c.base.headlineDetail || c.head.headlineDetail) section.append(...[c.base.headlineDetail, c.head.headlineDetail].filter((x): x is Untrusted => !!x).map((x) => untrustedBlock(x)));
  section.append(el("p", {}, `#${c.base.number}: ${c.base.headline}`), el("p", {}, `#${c.head.number}: ${c.head.headline}`));
  section.append(el("h3", {}, `Goals that changed (${c.goals.total}, ${c.goals.unchanged} unchanged)`), c.goals.items.length === 0 ? el("p", { class: "muted" }, "No goal changed.") : el("ul", {}, ...c.goals.items.map((g) => el("li", {}, el("strong", {}, g.person), " · ", inlineText(g.goal), `: ${g.base.replaceAll("_", " ")} → ${g.head.replaceAll("_", " ")}`))));
  const lists: Array<[string, Array<{ title: Untrusted; note: string }>, number]> = [
    ["Reported in both runs", c.findings.stillReported.items.map((f) => ({ title: f.title, note: `${f.base.verdict} → ${f.head.verdict}` })), c.findings.stillReported.more],
    [`Only in run #${c.base.number}`, c.findings.onlyInBase.items.map((f) => ({ title: f.title, note: `${f.verdict}; its goal in run #${c.head.number}: ${f.goalInHead.replaceAll("_", " ")}` })), c.findings.onlyInBase.more],
    [`Only in run #${c.head.number}`, c.findings.onlyInHead.items.map((f) => ({ title: f.title, note: f.verdict })), c.findings.onlyInHead.more],
  ];
  for (const [label, items, more] of lists) {
    section.append(el("h3", {}, `${label} (${items.length + more})`), items.length === 0 ? el("p", { class: "muted" }, "None.") : el("ul", {}, ...items.map((i) => el("li", {}, i.title.text, ` (${i.note})`))));
    if (more > 0) section.append(el("p", { class: "muted" }, `…${more} more not shown.`));
  }
  section.append(el("ul", { class: "muted caveats" }, ...c.caveats.map((t) => el("li", {}, t))));
  parts.compare!.append(section);
}

function shownItems(): Item[] {
  const r = state.report;
  if (!r) return [];
  return GROUPS.filter((g) => state.filter === "all" || state.filter === g).flatMap((g) => r.findings[g].items);
}

const filterSignature = (r: Report) => GROUPS.map((g) => r.findings[g].total).join(",");

function renderFilters() {
  const r = state.report;
  const focusedValue = (document.activeElement as HTMLElement | null)?.dataset?.filter;
  clear(parts.filters!);
  if (!r) return;
  state.filterSignature = filterSignature(r);
  if (state.filter !== "all" && r.findings[state.filter].total === 0) state.filter = "all";
  const options: Array<["all" | Group, string, number]> = [["all", "All", GROUPS.reduce((n, g) => n + r.findings[g].total, 0)], ...GROUPS.filter((g) => r.findings[g].total > 0).map((g) => [g, GROUP_LABEL[g], r.findings[g].total] as ["all" | Group, string, number])];
  parts.filters!.append(el("div", { class: "filters", role: "group", "aria-label": "Filter findings" }, ...options.map(([value, label, n]) => {
    const button = el("button", { type: "button", "data-filter": value, "aria-pressed": state.filter === value }, `${label} ${n}`);
    button.onclick = () => { state.filter = value; renderFilters(); renderList(); (parts.filters!.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus(); };
    return button;
  })));
  if (focusedValue) ((parts.filters!.querySelector(`[data-filter="${CSS.escape(focusedValue)}"]`) ?? parts.filters!.querySelector('[aria-pressed="true"]')) as HTMLElement | null)?.focus();
}

function renderList() {
  const r = state.report;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  clear(parts.list!);
  if (!r) return;
  const items = shownItems();
  if (items.length === 0) { parts.list!.append(el("p", { class: "muted" }, "No findings here.")); return; }
  put(parts.list!, el("ul", { class: "findings", "aria-label": "Findings" }, ...items.map((i) => {
    const button = el("button", { type: "button", "data-key": i.key, "aria-expanded": state.selected === i.key }, el("span", { class: `sev sev-${i.severity}` }, i.severity), " ", el("span", { class: "title" }, i.title.text), el("span", { class: "muted" }, ` · ${i.person} · ${GROUP_LABEL[i.group as Group] ?? i.group}${i.evidence ? ` · ${i.evidence} capture${i.evidence === 1 ? "" : "s"}` : ""}`));
    button.onclick = () => void openFinding(i.key);
    return el("li", {}, button);
  })), ...GROUPS.filter((g) => r.findings[g].more > 0 && (state.filter === "all" || state.filter === g)).map((g) => el("p", { class: "muted" }, `…${r.findings[g].more} more ${GROUP_LABEL[g].toLowerCase()} not shown. Open the run in Trawler to see them all.`)));
  if (focused) (parts.list!.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
}

function renderDetail() {
  const active = document.activeElement as HTMLElement | null;
  const titleHadFocus = active?.id === "detail-title";
  const focused = active?.dataset?.ref ? `[data-ref="${CSS.escape(active.dataset.ref)}"][data-role="${active.dataset.role ?? "show"}"]` : null;
  clear(parts.detail!);
  if (state.detailError) { parts.detail!.append(el("p", { class: "notice", role: "alert" }, state.detailError)); return; }
  const d = state.detail;
  if (!d) return;
  const section = el("section", { class: "detail", "aria-labelledby": "detail-title" }, el("h2", { id: "detail-title" }, d.title.text),
    el("p", { class: "muted" }, `${d.severity} · ${d.person} · ${textOf(d.goal)}${d.verdict ? ` · verdict: ${d.verdict}` : ""}${d.groupedUnder ? ` · grouped under ${d.groupedUnder}` : ""}`),
    el("h3", {}, "What was observed"), untrustedBlock(d.observed), el("h3", {}, "How to reproduce it"), untrustedBlock(d.reproduction),
    d.quote && el("h3", {}, "Quoted from the page"), d.quote && untrustedBlock(d.quote), d.page && untrustedBlock(d.page, "p"),
    d.replay && el("h3", {}, d.replay.completed === false ? "Replay (did not finish)" : "Replay"), d.replay?.observed && untrustedBlock(d.replay.observed),
    d.dismissal && el("p", { class: "muted" }, `Marked not a bug by ${d.dismissal.by}:`), d.dismissal && untrustedBlock(d.dismissal.reason, "p"),
    d.sameReports.length > 0 && el("h3", {}, "Reported the same way"), d.sameReports.length > 0 && el("ul", {}, ...d.sameReports.map((s) => el("li", {}, s.title.text))),
    el("h3", {}, "Evidence"));
  const list = el("ul", { class: "evidence" });
  for (const e of d.evidence) {
    const loaded = state.evidence.get(e.ref);
    const button = el("button", { type: "button", "data-ref": e.ref, "data-role": "show" }, `${loaded ? "Reload" : "Show"}: ${e.label}`);
    button.onclick = () => void loadEvidence(e.ref, e.label);
    const item = el("li", {}, button, state.evidenceErrors.has(e.ref) && el("p", { class: "muted", role: "status" }, state.evidenceErrors.get(e.ref)));
    if (loaded?.kind === "screenshot") item.append(el("figure", { class: "capture" }, el("img", { src: loaded.src, alt: `Screen capture: ${e.label}` }), el("figcaption", {}, loaded.note)));
    if (loaded?.kind === "trail") {
      item.append(...loaded.blocks.map((b) => untrustedBlock(b)));
      if (loaded.next) { const older = el("button", { type: "button", "data-ref": e.ref, "data-role": "older" }, "Older steps"); older.onclick = () => void loadEvidence(e.ref, e.label, loaded.next!); item.append(older); }
    }
    list.append(item);
  }
  section.append(list);
  parts.detail!.append(section);
  if (titleHadFocus) { const heading = parts.detail!.querySelector("h2") as HTMLElement | null; heading?.setAttribute("tabindex", "-1"); heading?.focus(); }
  if (focused) ((parts.detail!.querySelector(focused) ?? parts.detail!.querySelector(focused.replace(/\[data-role="[^"]*"\]/, '[data-role="show"]'))) as HTMLElement | null)?.focus();
}

async function openFinding(key: string, moveFocus = true) {
  const r = state.report;
  if (!r) return;
  state.selected = key;
  state.detail = null;
  state.detailError = null;
  state.evidenceErrors.clear();
  renderList();
  const result = await call("get_finding", { run: r.number, finding: key }).catch(() => null);
  if (state.selected !== key || state.report?.number !== r.number) return;
  if (!result || result.isError) state.detailError = result ? failureText(result) : "Could not load this finding. Try again.";
  else state.detail = result.structuredContent as Detail;
  renderDetail();
  parts.detail!.querySelector("h2")?.setAttribute("tabindex", "-1");
  if (moveFocus) (parts.detail!.querySelector("h2") as HTMLElement | null)?.focus();
}

async function loadEvidence(ref: string, label: string, before?: string) {
  const r = state.report;
  const key = state.selected;
  const flight = `${ref}|${before ?? ""}`;
  if (!r || !key || state.loading.has(flight)) return;
  state.loading.add(flight);
  const result = await call("get_evidence", { run: r.number, ref, ...(before ? { before } : {}) }).catch(() => null);
  state.loading.delete(flight);
  if (state.selected !== key || state.report?.number !== r.number) return;
  if (!result || result.isError) {
    state.evidenceErrors.set(ref, result ? failureText(result) : "Could not load this evidence. Try again.");
    renderDetail();
    announce(`Could not load: ${label}.`);
    return;
  }
  const structured = result.structuredContent as { kind: "screenshot" | "trail"; trail?: Untrusted; nextBefore?: string | null };
  const image = result.content?.find((c) => c.type === "image");
  if (structured.kind === "screenshot" && image?.data && /^image\/(png|jpeg|webp)$/.test(image.mimeType ?? "")) state.evidence.set(ref, { kind: "screenshot", src: `data:${image.mimeType};base64,${image.data}`, note: `${label}. Passwords and other secrets are blacked out.` });
  if (structured.kind === "trail" && structured.trail) {
    const previous = before ? state.evidence.get(ref) : undefined;
    state.evidence.set(ref, { kind: "trail", blocks: [...(previous?.kind === "trail" ? previous.blocks : []), structured.trail], next: structured.nextBefore ?? null });
  }
  state.evidenceErrors.delete(ref);
  renderDetail();
  announce(`Loaded: ${label}.`);
}

async function compareWithBaseline() {
  const r = state.report;
  const token = ++state.compareToken;
  state.compared = null;
  renderCompare();
  if (!r || !state.baseline) return;
  const result = await call("compare_runs", { base: Number(state.baseline), head: r.number }).catch(() => null);
  if (token !== state.compareToken || state.report?.number !== r.number) return;
  if (!result || result.isError) { parts.compare!.append(el("p", { class: "notice", role: "alert" }, result ? failureText(result) : "Could not compare these runs. Try again.")); return; }
  state.compared = result.structuredContent as Compared;
  renderCompare();
}

async function loadBaselines() {
  const r = state.report;
  if (!r) return;
  const result = await call("list_runs", { project: r.project.id, limit: 50, before: r.number }).catch(() => null);
  if (state.report?.number !== r.number) return;
  if (!result || result.isError) { state.baselineError = `Could not load earlier runs to compare with. ${result ? failureText(result) : ""}`.trim(); renderBaseline(); return; }
  state.baselineError = null;
  const runs = (result.structuredContent as { runs: Array<{ number: number; status: string; confirmedDefects: number; createdAt: string | null }> }).runs;
  state.baselines = runs.map((x) => ({ number: x.number, label: `#${x.number} · ${x.status.replaceAll("_", " ")} · ${x.confirmedDefects} confirmed${x.createdAt ? ` · ${x.createdAt.slice(0, 10)}` : ""}` }));
  renderBaseline();
}

function renderAll() {
  renderHead(); renderSummary(); renderPeople(); renderBaseline(); renderCompare(); renderFilters(); renderList(); renderDetail();
}

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
  const r = state.report;
  if (!r || !r.live || document.hidden || state.stopped === "closed" || state.polling) return;
  if (state.polls >= MAX_POLLS) { stopPolling("limit"); notice("Live updates stopped after ten minutes. Use Try again to keep watching.", resume); return; }
  state.timer = window.setTimeout(() => void poll(), POLL_MS);
}

async function poll() {
  const r = state.report;
  if (!r || state.polling) return;
  state.polling = true;
  state.polls += 1;
  const token = state.pollToken;
  const result = await call("get_run", { run: r.number }).catch(() => null);
  if (token === state.pollToken) state.polling = false;
  if (token !== state.pollToken || state.stopped === "closed" || state.report?.number !== r.number) return;
  if (!result || result.isError || !isReport(result.structuredContent)) {
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
  show(result.structuredContent as Report);
}

function show(report: Report) {
  const was = state.report?.number === report.number ? state.report : null;
  state.report = report;
  const staleFilter = state.filter !== "all" && report.findings[state.filter].total === 0;
  if (staleFilter) state.filter = "all";
  if (!was || headSignature(report) !== state.headSignature) renderHead();
  renderSummary(); renderList();
  if (!was || staleFilter || filterSignature(report) !== state.filterSignature) renderFilters();
  if (!was || JSON.stringify(was.people) !== JSON.stringify(report.people)) renderPeople();
  if (was && was.status !== report.status) {
    announce(`Run ${report.number} is now ${report.status.replaceAll("_", " ")}.`);
    if (state.selected && !report.live) void openFinding(state.selected, false);
  }
  if (report.live) schedulePolling(); else stopPolling(null);
}

function resetFor(run: number | null): boolean {
  if (state.report?.number === run) return false;
  Object.assign(state, { peopleOpen: false, filterSignature: "", headSignature: "", selected: null, detail: null, detailError: null, baseline: "", compared: null, filter: "all", baselines: [], baselineError: null });
  state.evidence.clear();
  state.evidenceErrors.clear();
  state.compareToken += 1;
  state.pollToken += 1;
  state.polling = false;
  return true;
}

function showCompared(compared: Compared) {
  stopPolling(null);
  resetFor(null);
  state.report = null;
  state.compared = compared;
  clear(parts.head!); clear(parts.summary!); clear(parts.people!); clear(parts.baseline!); clear(parts.filters!); clear(parts.list!); clear(parts.detail!);
  renderCompare();
}

function isReport(value: unknown): value is Report {
  return !!value && typeof value === "object" && "findings" in value && "people" in value;
}
function isCompared(value: unknown): value is Compared {
  return !!value && typeof value === "object" && "caveats" in value && "goals" in value;
}

function theme() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

app.ontoolresult = (result) => {
  const value = result.structuredContent;
  if (result.isError) { notice(failureText(result as Result)); return; }
  notice(null);
  if (isReport(value)) { const changed = resetFor(value.number); state.polls = 0; state.failures = 0; state.stopped = null; state.lastGood = new Date(); show(value); if (changed) renderAll(); void loadBaselines(); }
  else if (isCompared(value)) showCompared(value);
};
app.onhostcontextchanged = () => theme();
app.onteardown = async () => { stopPolling("closed"); return {}; };
document.addEventListener("visibilitychange", () => { if (document.hidden) { window.clearTimeout(state.timer); state.timer = 0; } else if (!state.stopped) schedulePolling(); });

await app.connect();
theme();
