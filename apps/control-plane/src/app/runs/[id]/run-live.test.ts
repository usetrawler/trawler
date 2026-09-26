import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { runView } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";

vi.mock("./actions.ts", () => ({ cancelRunAction: async () => true, judgeAgainAction: async () => ({}), runAgainAction: async () => ({}) }));

const { RunLive, outcome, personLine } = await import("./run-live.tsx");

const job = (kind: string, status: string, extra: Partial<RunSummary["jobs"][number]> = {}) =>
  ({ id: `${kind}-${status}-${Math.random()}`, kind, status, persona_key: null, finding_key: null, usage: null, stopped_by: null, error: null, requested: false, ...extra }) as RunSummary["jobs"][number];
const finding = (key: string, persona: string, extra: Partial<RunSummary["findings"][number]> = {}) =>
  ({ key, personaKey: persona, kind: "defect", goal: "g1", title: key, observed: "o", reproduction: ["Open Invoices.", "Save."], severity: "high", replay: null, verdict: null, ...extra }) as RunSummary["findings"][number];
const summary = (over: Partial<RunSummary>): RunSummary => ({
  id: "run-1", number: 7, status: "succeeded", projectId: "project-1", costUsd: 0.35, budgetUsd: 2, agentModel: "deepseek/deepseek-v4.1-flash", judgeModel: "deepseek/deepseek-v4.1-flash",
  provider: "openrouter", tokenCap: null, tokensUsed: 0, createdAt: new Date("2026-09-25T19:40:00Z"), startedAt: new Date("2026-09-25T19:40:05Z"), finishedAt: new Date("2026-09-25T19:59:00Z"),
  jobs: [], findings: [], goals: [], target: "https://app.acme.test/", activity: [],
  personas: [{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee Park" }], goalTexts: [{ id: "g1", instruction: "Get an account." }, { id: "g2", instruction: "Send an invoice." }],
  ...over,
});
const finished = summary({
  jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("role_session", "succeeded", { persona_key: "lee" })],
  goals: [
    { personaKey: "ana", goal: "g1", status: "reached", note: "" }, { personaKey: "ana", goal: "g2", status: "reached", note: "" },
    { personaKey: "lee", goal: "g1", status: "reached", note: "" }, { personaKey: "lee", goal: "g2", status: "failed", note: "The invoice form never saved." },
  ],
  findings: [
    finding("ana:f1", "ana", { title: "Saving an invoice fails", observed: "A 500 page.", verdict: "confirmed", replay: { completed: true, observed: "The same 500 page.", blockedAt: null } }),
    finding("lee:f2", "lee", { title: "A typo on the button", observed: "It reads Sav.", verdict: "refuted", severity: "low" }),
  ],
});
const live = summary({
  status: "running", finishedAt: null, costUsd: 0.84,
  jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("role_session", "leased", { persona_key: "lee" })],
  goals: [{ personaKey: "ana", goal: "g1", status: "reached", note: "" }, { personaKey: "ana", goal: "g2", status: "reached", note: "" }],
});
const render = (run: RunSummary) => renderToStaticMarkup(createElement(RunLive, { initial: JSON.parse(JSON.stringify({ run, view: runView(run) })) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
const head = (html: string) => html.slice(0, html.indexOf("<section"));
const band = (html: string) => html.match(/<section aria-labelledby="[^"]+" class="mt-\[35px\].*?<\/section>/)?.[0] ?? "";
const rows = (html: string, title: string) => (html.match(new RegExp(`>${title} · \\d+</h2>.*?</section>`))?.[0] ?? "").split("<li ").slice(1).map((row) => row.slice(row.indexOf(">") + 1));

test("a finished run's head gives its status and when it ended, the outcome, the product and model, then Start another run and Run again", () => {
  const top = head(render(finished));
  expect(text(top)).toContain("Complete · 2026-09-25 19:59 UTC");
  expect(top).toMatch(/<h1[^>]*>1 defect confirmed by replay\.<\/h1>/);
  expect(text(top)).toContain("app.acme.test · deepseek/deepseek-v4.1-flash");
  expect(top).toMatch(/<a href="\/projects\/project-1#start"[^>]*>Start another run<\/a><form[^>]*><input type="hidden" name="runId" value="run-1"\/><button type="submit"[^>]*>Run again/);
  expect(top).not.toContain("Stop run");
});

test("a finished run sums up who reached every goal, what the replay confirmed and dismissed, and what it cost against its cap", () => {
  const summed = text(band(render(finished)));
  expect(summed).toContain("Outcome 1 of 2 people reached every goal. 3 of 4 goals reached in all.");
  expect(summed).toContain("Verified 1 of 2 reported");
  expect(summed).toContain("Dismissed by replay 1 the replay did not see them");
  expect(summed).toContain("Cost $0.35 cap was $2.00");
  const priceless = text(band(render(summary({ ...finished, tokenCap: 3_000_000, tokensUsed: 1_200_000 }))));
  expect(priceless).toContain("Tokens 1.20M cap was 3.0M · price unknown");
});

test("a confirmed defect is a row with its severity, number, person, title and what happened, marked as replayed, that opens to its steps and the replay", () => {
  const [row] = rows(render(finished), "Confirmed");
  const [summaryPart, details] = row!.split("</summary>");
  expect(text(summaryPart!)).toBe("high severity 01 · Ana Saving an invoice fails A 500 page. ✓ Replayed →");
  expect(text(details!)).toContain("Steps Open Invoices. Save.");
  expect(text(details!)).toContain("What the replay saw: The same 500 page.");
});

test("a refuted defect keeps its own section and carries no replayed mark", () => {
  const [row] = rows(render(finished), "Refuted");
  expect(text(row!.split("</summary>")[0]!)).toBe("low severity 01 · Lee Park A typo on the button It reads Sav. →");
});

test("beside the findings, each person is listed with a mark and one line on how far they got", () => {
  const html = render(finished);
  const aside = text(html.slice(html.indexOf("<aside")));
  expect(aside).toContain("People ✓ Ana : Goal reached. Reached all 2 goals.");
  expect(aside).toContain("× Lee Park : Goal not reached. The invoice form never saved.");
  expect(aside).toContain("Each goal of Ana ✓ Reached: Get an account. ✓ Reached: Send an invoice.");
  expect(aside).toContain("Each goal of Lee Park ✓ Reached: Get an account. ✕ Not reached: Send an invoice. — The invoice form never saved.");
});

test("a live run shows its cost against the cap, the four stages, each person and what they are on, and Stop run; no Run again and no summary yet", () => {
  const html = render(live);
  expect(text(head(html))).toContain("Live · 2026-09-25 19:40 UTC");
  expect(text(head(html))).toContain("Live cost $0.84 of $2.00 cap");
  expect(text(html)).toContain("01 Use In progress 02 Replay Waiting 03 Judge Waiting 04 Report Waiting");
  expect(text(html)).toContain("AN Ana Reached all 2 goals. Goal reached");
  expect(text(html)).toContain("LP Lee Park Working on: Get an account. 0 of 2 goals reached. Exploring");
  expect(text(html)).toContain("Safe to leave. The run keeps going; come back to this page for the report.");
  expect(html).toMatch(/<button type="button"[^>]*>Stop run<\/button>/);
  expect(html).not.toContain("Run again");
  expect(band(html)).toBe("");
  expect(text(html)).toContain("Confirmed · 0 A fresh agent reproduced it and the judge agreed Nothing confirmed yet.");
});

test("each person's line says how far they got, in every state", () => {
  const view = runView(summary({
    status: "succeeded",
    personas: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }],
    jobs: [job("role_session", "succeeded", { persona_key: "a" }), job("role_session", "succeeded", { persona_key: "b" }), job("role_session", "failed", { persona_key: "c", error: "the browser crashed" })],
    goals: [{ personaKey: "a", goal: "g1", status: "reached", note: "" }, { personaKey: "b", goal: "g2", status: "failed", note: "" }],
  }));
  expect(view.personas.map(personLine)).toEqual(["Reached 1 of 2 goals.", "Did not reach: Send an invoice.", "Could not finish: the browser crashed", "Stopped before the end."]);
  expect(outcome(view)).toEqual({ people: "0 of 4 people reached every goal.", goals: "1 of 8 goals reached in all." });
});

test("a person's line also covers waiting, failing without a reason, a single goal, and a failed goal the plan no longer has", () => {
  const one = [{ id: "g1", instruction: "Get an account." }];
  const waiting = runView(summary({ status: "running", finishedAt: null, goalTexts: one, personas: [{ id: "a", name: "A" }], jobs: [job("role_session", "queued", { persona_key: "a" })] }));
  expect(waiting.personas.map(personLine)).toEqual(["Waiting for their turn."]);
  const ended = runView(summary({
    goalTexts: one, personas: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    jobs: [job("role_session", "succeeded", { persona_key: "a" }), job("role_session", "failed", { persona_key: "b" }), job("role_session", "succeeded", { persona_key: "c" })],
    goals: [{ personaKey: "a", goal: "g1", status: "reached", note: "" }, { personaKey: "c", goal: "gone", status: "failed", note: "" }],
  }));
  expect(ended.personas.map(personLine)).toEqual(["Reached the goal.", "Could not finish.", "Did not reach a goal."]);
});

test("Run again and Start another run belong to every run that has ended, and to none that is still going", () => {
  for (const status of ["succeeded", "stopped_budget", "failed", "cancelled"]) {
    const top = head(render(summary({ ...finished, status })));
    expect(top).toContain(">Run again<");
    expect(top).toContain(">Start another run</a>");
  }
  for (const status of ["queued", "running"]) {
    const html = render(summary({ ...live, status }));
    expect(html).not.toContain("Run again");
    expect(html).not.toContain("Start another run");
  }
});

test("every defect counts as reported whatever the replay made of it, friction does not, and a defect the judge left without a verdict can be judged again", () => {
  const html = render(summary({
    ...finished,
    jobs: [...finished.jobs, job("judge", "failed", { finding_key: "x:d4", error: "the judge timed out" })],
    findings: [
      finding("x:d1", "ana", { verdict: "confirmed" }), finding("x:d2", "ana", { verdict: "refuted" }), finding("x:d3", "ana", { verdict: "inconclusive" }),
      finding("x:d4", "ana", { title: "Export is empty" }), finding("x:d5", "ana"), finding("x:f1", "ana", { kind: "friction" }),
    ],
  }));
  expect(text(band(html))).toContain("Verified 1 of 5 reported");
  expect(text(band(html))).toContain("Dismissed by replay 1 the replay did not see them");
  const [unjudged] = rows(html, "Could not be judged");
  expect(text(unjudged!.split("</summary>")[0]!)).toBe("high severity 01 · Ana Export is empty Failed: the judge timed out →");
  expect(unjudged).toMatch(/<button type="button"[^>]*>Judge again<\/button>/);
});

test("while a run is live, the latest things that happened are listed under the people", () => {
  const html = render(summary({
    ...live,
    activity: [
      { id: "2", at: new Date(), personaKey: "lee", kind: "role_session", text: "Opened the invoices page" },
      { id: "1", at: new Date(), personaKey: null, kind: "judge", text: "Confirmed: Saving an invoice fails" },
    ] as RunSummary["activity"],
  }));
  expect(text(html)).toContain("Latest Lee Park: Opened the invoices page Judge: Confirmed: Saving an invoice fails");
});

test("the actions stay together and move under the text until the page is wide, a finding's line is cut at two lines, and an opened finding wraps long words", () => {
  const html = render(finished);
  expect(head(html)).toMatch(/^<div class="flex flex-col"><div class="flex flex-col items-start gap-6 wide:flex-row wide:items-end wide:justify-between"><div class="flex min-w-0 flex-col wide:flex-1">/);
  expect(head(html)).toMatch(/<div class="flex w-full flex-col gap-2 md:w-auto md:flex-row md:flex-wrap md:justify-end wide:max-w-md"><a href="\/projects\/project-1#start"[^>]*>Start another run<\/a><form/);
  expect(head(render(live))).toMatch(/<div class="flex min-w-0 flex-col md:min-w-80 md:flex-1">/);
  const [row] = rows(html, "Confirmed");
  expect(row).toMatch(/<span class="mt-\[5px\] line-clamp-2 [^"]*">A 500 page\.<\/span>/);
  expect(row!.match(/<span class="mt-\[5px\][^"]*"/)?.[0]).not.toMatch(/\bblock\b/);
  expect(row).toMatch(/<div class="[^"]*\bwrap-anywhere\b[^"]*"><p><span class="text-muted">While trying to: /);
});
