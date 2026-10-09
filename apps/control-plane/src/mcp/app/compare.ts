import { el, icon, inlineText, put, untrustedBlock } from "./dom.ts";
import type { Host, View } from "./host.ts";
import type { Compared } from "./types.ts";
import { button, chip, label, pill, STATUS_LABEL, STATUS_TONE, VERDICT_LABEL, VERDICT_TONE, verdictChip, type Tone } from "./ui.ts";

const CHANGE: Record<string, { text: string; tone: Tone }> = {
  now_reached: { text: "Now reached", tone: "ok" }, regressed: { text: "Regressed", tone: "bad" }, same: { text: "Same", tone: "neutral" },
  not_checked_in_head: { text: "Not checked in the newer run", tone: "warn" }, not_checked_in_base: { text: "Not checked in the older run", tone: "warn" }, same_not_checked: { text: "Not checked in either", tone: "neutral" },
};
const STATE_TONE: Record<string, Tone> = { reached: "ok", failed: "bad", not_attempted: "warn", not_tested: "neutral", not_in_plan: "neutral" };
const stateChip = (state: string) => chip(label(state), STATE_TONE[state] ?? "neutral");

function runCard(role: string, run: Compared["base"]): HTMLElement {
  return el("div", { class: "card run-card" },
    el("p", { class: "eyebrow" }, role, el("span", { class: "mono" }, `Run #${run.number}`), pill(STATUS_LABEL[run.status] ?? label(run.status), STATUS_TONE[run.status] ?? "neutral")),
    el("p", { class: "run-headline" }, run.headline), run.headlineDetail && untrustedBlock(run.headlineDetail));
}

export function compareView(c: Compared, host: Host): View {
  const root = el("div", { class: "view compare" });
  if (host.canGoBack()) put(root, el("div", { class: "toolbar" }, button("Back", { icon: "back", onclick: () => host.back() })));
  put(root, el("h1", { class: "title" }, `Run #${c.base.number} compared with run #${c.head.number}`),
    el("div", { class: "versus" }, runCard("Older", c.base), el("span", { class: "versus-arrow", "aria-hidden": "true" }, icon("arrow", 22)), runCard("Newer", c.head)));

  const comparable = c.goals.items.filter((g) => g.base !== "not_in_plan" && g.head !== "not_in_plan");
  const onlyOne = c.goals.items.filter((g) => g.base === "not_in_plan" || g.head === "not_in_plan");
  if (onlyOne.length > 0) {
    put(root, el("div", { class: "callout tone-info" }, icon("layers", 18), el("div", {},
      el("strong", {}, "These runs followed different plans."),
      el("p", {}, `${onlyOne.length}${c.goals.more > 0 ? "+" : ""} ${onlyOne.length === 1 ? "goal exists" : "goals exist"} in only one of the runs, so there is nothing to compare for ${onlyOne.length === 1 ? "it" : "them"}.`),
      el("details", {}, el("summary", {}, "Show those goals"), el("ul", { class: "plain" }, ...onlyOne.map((g) => el("li", {}, el("span", { class: "muted" }, `${g.person} · `), inlineText(g.goal), ` (only in run #${g.head === "not_in_plan" ? c.base.number : c.head.number})`)))))));
  }

  const goalsSection = el("section", { class: "card block" }, el("h2", {}, "Goals", el("span", { class: "muted" }, ` ${c.goals.unchanged} unchanged`)));
  if (comparable.length === 0) goalsSection.append(el("p", { class: "muted" }, "No goal changed between the runs."));
  else goalsSection.append(el("ul", { class: "diff" }, ...comparable.map((g) => {
    const change = CHANGE[g.change] ?? { text: label(g.change), tone: "neutral" as Tone };
    return el("li", {}, el("div", { class: "diff-main" }, el("span", { class: "muted small" }, g.person), el("span", {}, inlineText(g.goal))),
      el("div", { class: "diff-change" }, stateChip(g.base), icon("arrow", 14), stateChip(g.head), chip(change.text, change.tone)));
  })));
  if (c.goals.more > 0) goalsSection.append(el("p", { class: "muted small" }, `…${c.goals.more} more not shown.`));
  put(root, goalsSection);

  const f = c.findings;
  const block = (title: string, tone: Tone, count: number, rows: HTMLElement[], more: number) => el("section", { class: "card block" },
    el("h2", {}, title, chip(String(count), tone)), rows.length === 0 ? el("p", { class: "muted" }, "None.") : el("ul", { class: "diff" }, ...rows), more > 0 && el("p", { class: "muted small" }, `…${more} more not shown.`));
  const transition = (a: string, b: string) => el("span", { class: "diff-change" }, chip(VERDICT_LABEL[a] ?? label(a), VERDICT_TONE[a] ?? "neutral"), icon("arrow", 14), chip(VERDICT_LABEL[b] ?? label(b), VERDICT_TONE[b] ?? "neutral"));
  put(root,
    block("Reported in both runs", "warn", f.stillReported.total, f.stillReported.items.map((i) => el("li", {}, el("div", { class: "diff-main" }, el("span", {}, i.title.text), el("span", { class: "muted small" }, inlineText(i.goal))), transition(i.base.verdict, i.head.verdict))), f.stillReported.more),
    block(`Only in run #${c.base.number}`, "neutral", f.onlyInBase.total, f.onlyInBase.items.map((i) => el("li", {}, el("div", { class: "diff-main" }, el("span", {}, i.title.text), el("span", { class: "muted small" }, `Its goal in run #${c.head.number}: ${label(i.goalInHead)}`)), verdictChip(i.verdict))), f.onlyInBase.more),
    block(`Only in run #${c.head.number}`, "info", f.onlyInHead.total, f.onlyInHead.items.map((i) => el("li", {}, el("div", { class: "diff-main" }, el("span", {}, i.title.text), el("span", { class: "muted small" }, inlineText(i.goal))), verdictChip(i.verdict))), f.onlyInHead.more));

  put(root, el("details", { class: "card fold" }, el("summary", {}, el("span", {}, "How to read this"), icon("chevron", 16)), el("ul", { class: "plain caveats" }, ...c.caveats.map((t) => el("li", {}, t)))));
  return { el: root, dispose() {} };
}
