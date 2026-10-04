import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { runView } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";

vi.mock("./actions.ts", () => ({ cancelRunAction: async () => true, judgeAgainAction: async () => ({}), runAgainAction: async () => ({}), dismissFindingAction: async () => ({}), undoDismissalAction: async () => ({}) }));

const { RunLive, outcome, personLine } = await import("./run-live.tsx");

const job = (kind: string, status: string, extra: Partial<RunSummary["jobs"][number]> = {}) =>
  ({ id: `${kind}-${status}-${Math.random()}`, kind, status, persona_key: null, finding_key: null, usage: null, stopped_by: null, error: null, requested: false, ...extra }) as RunSummary["jobs"][number];
const finding = (key: string, persona: string, extra: Partial<RunSummary["findings"][number]> = {}) =>
  ({ key, personaKey: persona, kind: "defect", filedAs: null, goal: "g1", title: key, observed: "o", reproduction: ["Open Invoices.", "Save."], severity: "high", replay: null, verdict: null, sameAs: null, url: null, quote: null, stepPeople: null, screenshots: { reported: null, replayed: null }, dismissal: null, ...extra }) as RunSummary["findings"][number];
const summary = (over: Partial<RunSummary>): RunSummary => ({
  id: "run-1", number: 7, status: "succeeded", cancelReason: null, projectId: "project-1", planName: null, costUsd: 0.35, budgetUsd: 2, completionUsdPerMtok: null, agentModel: "deepseek/deepseek-v4.1-flash", judgeModel: "deepseek/deepseek-v4.1-flash",
  provider: "openrouter", paidBy: "workspace", tokenCap: null, tokensUsed: 0, createdAt: new Date("2026-09-25T19:40:00Z"), startedAt: new Date("2026-09-25T19:40:05Z"), finishedAt: new Date("2026-09-25T19:59:00Z"),
  jobs: [], findings: [], goals: [], botProtection: null, target: "https://app.acme.test/", activity: [],
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
  expect(top).toMatch(/<div class="flex w-full flex-col gap-2 md:w-auto md:flex-row"><a href="\/projects\/project-1#start"[^>]*>Start another run<\/a><form[^>]*><input type="hidden" name="runId" value="run-1"\/><button type="submit"[^>]*>Run again/);
  expect(top).not.toContain("Stop run");
});

test("a finished run sums up who reached every goal, what the replay confirmed and dismissed, and what it cost against its cap", () => {
  const summed = text(band(render(finished)));
  expect(summed).toContain("Outcome 1 of 2 people reached every goal. 3 of 4 goals reached in all.");
  expect(summed).toContain("Verified 1 of 2 reported");
  expect(summed).toContain("Dismissed by replay 1 the replay did not bear them out");
  expect(summed).toContain("Cost $0.35 cap was $2.00");
  const priceless = text(band(render(summary({ ...finished, tokenCap: 3_000_000, tokensUsed: 1_200_000 }))));
  expect(priceless).toContain("Tokens 1.20M cap was 3.0M · price unknown");
});

test("a run Trawler paid for says so next to its cost, live and finished", () => {
  expect(text(band(render(summary({ ...finished, paidBy: "trawler", budgetUsd: 1 }))))).toContain("Cost $0.35 cap was $1.00 · paid by Trawler");
  expect(text(head(render(summary({ ...live, paidBy: "trawler", budgetUsd: 1 }))))).toContain("Live cost $0.84 of $1.00 cap · paid by Trawler");
  expect(text(band(render(summary({ ...finished, paidBy: "trawler", tokenCap: 3_000_000, tokensUsed: 1_200_000 }))))).toContain("Tokens 1.20M cap was 3.0M · price unknown · paid by Trawler");
  expect(text(band(render(finished)))).not.toContain("paid by Trawler");
});

test("a confirmed defect is a row with its severity, number, person, title and what happened, marked as replayed, that opens to its steps and the replay", () => {
  const [row] = rows(render(finished), "Confirmed");
  const [summaryPart, details] = row!.split("</summary>");
  expect(text(summaryPart!)).toBe("high severity 01 · Ana Saving an invoice fails A 500 page. ✓ Replayed →");
  expect(text(details!)).toContain("Steps Open Invoices. Save.");
  expect(text(details!)).toContain("What the replay saw: The same 500 page.");
});

test("a defect several people found is one row naming each of them once, that opens to how each of the others found it, with their screen capture", () => {
  const html = render(summary({
    ...finished,
    findings: [
      ...finished.findings,
      finding("lee:f1", "lee", { title: "Invoice will not save", goal: "g2", reproduction: ["Open Invoices.", "Press Save twice."], sameAs: "ana:f1", screenshots: { reported: "11111111-1111-4111-8111-111111111111", replayed: null } }),
      finding("ana:f3", "ana", { title: "Save fails again", sameAs: "ana:f1" }),
      finding("ana:f4", "ana", { title: "Save fails once more", sameAs: "ana:f1" }),
    ],
  }));
  const [row] = rows(html, "Confirmed");
  expect(text(row!)).toContain("01 · Ana, Lee Park Saving an invoice fails");
  expect(text(row!)).toContain("Ana , while trying to: Get an account.");
  expect(text(row!)).toContain("Also reported by Lee Park, Ana again");
  expect(text(row!)).toContain("Lee Park , while trying to: Send an invoice. Reported as: Invoice will not save What they saw: o Steps Open Invoices. Press Save twice.");
  expect(row).toContain('href="/captures/11111111-1111-4111-8111-111111111111"');
  expect(text(band(html))).toContain("Verified 1 of 2 reported");
  expect(rows(html, "Confirmed")).toHaveLength(1);
  const [single] = rows(render(finished), "Confirmed");
  expect(single).not.toContain("Also reported by");
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
    personas: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }, { id: "e", name: "E" }],
    jobs: [job("role_session", "succeeded", { persona_key: "a" }), job("role_session", "succeeded", { persona_key: "b" }), job("role_session", "failed", { persona_key: "c", error: "the browser crashed" }), job("role_session", "succeeded", { persona_key: "e" }), job("role_session", "cancelled", { persona_key: "e" })],
    goals: [{ personaKey: "a", goal: "g1", status: "reached", note: "" }, { personaKey: "b", goal: "g2", status: "failed", note: "" }],
  }));
  expect(view.personas.map(personLine)).toEqual(["Reached 1 of 2 goals.", "Did not reach: Send an invoice.", "Could not finish: the browser crashed", "Stopped before their turn.", "Stopped before the end."]);
  expect(outcome(view)).toEqual({ people: "0 of 5 people reached every goal.", goals: "1 of 10 goals reached in all." });
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
  expect(text(band(html))).toContain("Dismissed by replay 1 the replay did not bear them out");
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
  expect(html.indexOf("Working on: Get an account.")).toBeLessThan(html.indexOf(">Latest</h2>"));
});

test("the actions stay together and move under the text until the page is wide, a finding's line is cut at two lines, and an opened finding wraps long words", () => {
  const html = render(finished);
  expect(head(html)).toMatch(/^<div class="flex flex-col"><div class="flex flex-col items-start gap-6 wide:flex-row wide:items-end wide:justify-between"><div class="flex min-w-0 flex-col wide:flex-1">/);
  expect(head(html)).toMatch(/<div class="flex w-full flex-col gap-2 md:w-auto md:flex-row"><a href="\/projects\/project-1#start"[^>]*>Start another run<\/a><form/);
  expect(head(render(live))).toMatch(/<div class="flex min-w-0 flex-col md:min-w-80 md:flex-1">/);
  const [row] = rows(html, "Confirmed");
  expect(row).toMatch(/<span class="mt-\[5px\] line-clamp-2 [^"]*">A 500 page\.<\/span>/);
  expect(row!.match(/<span class="mt-\[5px\][^"]*"/)?.[0]).not.toMatch(/\bblock\b/);
  expect(row).toMatch(/<div class="[^"]*\bwrap-anywhere\b[^"]*"><p><span class="text-muted">While trying to: /);
});

test("a confirmed defect's card shows both screenshots after its steps, and a card without any shows none", () => {
  const html = render(summary({
    findings: [
      finding("ana:f1", "ana", { title: "Save fails", reproduction: ["Open /", "Click Save"], verdict: "confirmed", replay: { completed: true, observed: "Internal Server Error", blockedAt: null }, screenshots: { reported: "11111111-1111-4111-8111-111111111111", replayed: "22222222-2222-4222-8222-222222222222" } }),
      finding("ana:f2", "ana", { title: "Load fails", verdict: "confirmed" }),
    ],
  }));
  const [saved, loaded] = rows(html, "Confirmed");
  expect(saved).toMatch(/Click Save<\/li><\/ol><\/div><div class="@container [^"]*"><div class="grid gap-3 @xl:grid-cols-2">/);
  expect(saved).toContain('src="/api/artifacts/11111111-1111-4111-8111-111111111111"');
  expect(saved).toContain('src="/api/artifacts/22222222-2222-4222-8222-222222222222"');
  expect(loaded).toContain("Load fails");
  expect(loaded).not.toContain("<figure");
});

test("while a run is live the active stage and the person exploring visibly move, only for those who allow motion, and nothing moves once it ends", () => {
  const html = render(live);
  const moving = html.match(/class="[^"]*animate-(spin|ping|pulse)[^"]*"/g) ?? [];
  expect(moving).toHaveLength(3);
  expect(moving.every((c) => /motion-safe:animate-/.test(c))).toBe(true);
  expect(render({ ...live, status: "succeeded", finishedAt: new Date("2026-09-25T20:00:00Z") })).not.toMatch(/animate-(spin|ping|pulse)/);
});

test("a defect whose replay failed is not judged, its row gives the reason, and the opened row keeps the whole of it", () => {
  const error = `the browser failed 3 times in a row; last error: ${"x".repeat(300)}`;
  const html = render(summary({ ...finished, jobs: [...finished.jobs, job("replay", "failed", { finding_key: "x:d1", error })], findings: [finding("x:d1", "ana", { title: "Export is empty" })] }));
  const [row] = rows(html, "Not judged");
  expect(text(row!.split("</summary>")[0]!)).toBe(`high severity 01 · Ana Export is empty The replay failed: ${error} →`);
  expect(text(row!.split("</summary>")[1]!)).toContain(`Why it was not judged: The replay failed: ${error}`);
});

test("a finding shows the page it was reported on and the person's own words, and one reported before either existed shows neither", () => {
  const html = render(summary({
    ...finished,
    findings: [
      finding("ana:f1", "ana", { title: "Saving an invoice fails", verdict: "confirmed", url: "https://app.acme.test/invoices/new?step=2", quote: "I saved it twice and still have nothing." }),
      finding("lee:f2", "lee", { title: "An old finding", verdict: "confirmed" }),
    ],
  }));
  const [first, second] = html.split("<li ").slice(1).map(text);
  expect(first).toContain("Page: /invoices/new?step=2");
  expect(first).toContain("In Ana's words “I saved it twice and still have nothing.”");
  expect(second).toContain("An old finding");
  expect(second).not.toContain("Page:");
  expect(second).not.toContain("words");
});

test("a defect others reported too shows each report's page and words, under the name of who said them", () => {
  const html = render(summary({
    ...finished,
    findings: [
      finding("ana:f1", "ana", { title: "Saving an invoice fails", verdict: "confirmed" }),
      finding("lee:f1", "lee", { title: "Save does nothing", sameAs: "ana:f1", url: "https://app.acme.test/invoices/7", quote: "Nothing happened when I saved." }),
    ],
  }));
  const row = text(html.split("<li ").slice(1)[0]!);
  expect(row).toContain("Page: /invoices/7");
  expect(row).toContain("In Lee Park's words: “Nothing happened when I saved.”");
});

test("a confirmed defect a person filed as friction says so, and a defect they filed as one does not", () => {
  const run = summary({ ...finished, findings: [
    finding("ana:f1", "ana", { title: "Balance has no history", verdict: "confirmed", filedAs: "friction", replay: { completed: true, observed: "No transactions found", blockedAt: null } }),
    finding("lee:f2", "lee", { title: "Saving an invoice fails", verdict: "confirmed", filedAs: null, replay: { completed: true, observed: "A 500 page.", blockedAt: null } }),
    finding("lee:f3", "lee", { kind: "friction", title: "Confirmation shows no balances", verdict: "refuted", filedAs: "friction", severity: "low" }),
  ] });
  const said = text(render(run)).match(/filed this as friction on a goal they did not reach, so Trawler replayed it too/g);
  expect(text(render(run))).toContain("Ana filed this as friction on a goal they did not reach, so Trawler replayed it too.");
  expect(said).toHaveLength(1);
});

test("a run stopped by bot protection says which check blocked Trawler and where, live and finished, and links to how to let Trawler through", () => {
  const met = { vendor: "Cloudflare", url: "https://app.acme.test/register.htm?step=2" };
  for (const run of [summary({ ...finished, botProtection: met }), summary({ ...live, botProtection: met })]) {
    const html = render(run);
    expect(text(html)).toContain("Bot protection stopped Trawler Cloudflare's bot protection blocked Trawler's browser at /register.htm . It stops automated browsers, so what lies behind it could not be tried, and it is not reported as a defect.");
    expect(html).toContain('href="https://usetrawler.com/docs/reference/troubleshooting/#bot-protection-stopped-trawler"');
  }
  expect(text(render(finished))).not.toContain("Bot protection");
});


test("every finding of a finished run opens to Not a bug, in every section, and none does while the run is live", () => {
  const html = render(summary({
    ...finished,
    jobs: [...finished.jobs, job("judge", "failed", { finding_key: "x:judge-failed", error: "the judge timed out" })],
    findings: [
      ...finished.findings, finding("ana:fr", "ana", { kind: "friction", title: "Hard to find Export" }), finding("x:open", "ana", { verdict: "inconclusive" }),
      finding("x:judge-failed", "ana"), finding("x:unjudged", "ana"),
    ],
  }));
  for (const section of ["Confirmed", "Could not be judged", "Inconclusive", "Not judged", "Refuted", "Friction"]) {
    const [, details] = rows(html, section)[0]!.split("</summary>");
    expect(details, section).toMatch(/<div class="border-t border-line pt-3"><button type="button"[^>]*>Not a bug<\/button><\/div><\/div><\/details>/);
  }
  expect(render(summary({ ...live, findings: finished.findings }))).not.toContain(">Not a bug<");
});

test("a finding marked not a bug leaves its section and the counts for its own, with the reason, who and when, and Undo", () => {
  const marked = (by: string | null) => ({ reason: "Saving twice is on purpose.", userId: "u1", at: new Date("2026-10-02T10:00:00Z"), by, matched: null });
  const html = render(summary({
    ...finished,
    findings: [
      finding("ana:f1", "ana", { title: "Saving an invoice fails", verdict: "confirmed", dismissal: marked("ana@acme.test") }),
      finding("lee:f3", "lee", { title: "Saving an invoice fails too", sameAs: "ana:f1", verdict: "confirmed" }),
      finding("ana:f2", "ana", { title: "Export is empty", verdict: "confirmed" }),
      finding("lee:fr", "lee", { kind: "friction", title: "Hard to find Export", dismissal: marked(null) }),
    ],
  }));
  expect(head(html)).toMatch(/<h1[^>]*>1 defect confirmed by replay\.<\/h1>/);
  expect(text(band(html))).toContain("Verified 1 of 1 reported");
  expect(rows(html, "Confirmed").map((row) => text(row.split("</summary>")[0]!))).toEqual(["high severity 01 · Ana Export is empty o ✓ Replayed →"]);
  expect(html).not.toMatch(/>Friction · /);
  const [first, second] = rows(html, "Not a bug");
  expect(text(first!.split("</summary>")[0]!)).toBe("high severity 01 · Ana, Lee Park Saving an invoice fails o →");
  expect(text(first!.split("</details>")[1]!)).toBe("Not a bug, because: Saving twice is on purpose. Marked by ana@acme.test on 2026-10-02 10:00 UTC . Undo : Saving an invoice fails");
  expect(first).not.toContain(">Not a bug</button>");
  expect(text(second!.split("</details>")[1]!)).toContain("Marked by someone no longer in this workspace on");
  expect(html).toMatch(/>Not a bug · 2<\/h2><p[^>]*>Marked not a bug by your team, or by Trawler for a repeat of one; the people in later runs of this project are told, with the reason<\/p>/);
  expect(first).toMatch(/<span class="min-w-0 wrap-anywhere text-muted">Marked by ana@acme.test/);
});

test("each person beside a finished run's findings links to what they did", () => {
  const html = render(finished);
  expect(html).toMatch(/<a href="#trail-ana"[^>]*>What they did<span class="sr-only">: Ana<\/span><\/a>/);
  expect(html).toMatch(/<a href="#trail-lee"[^>]*>What they did<span class="sr-only">: Lee Park<\/span><\/a>/);
  expect(html).toMatch(/<li id="trail-ana"/);
});

test("the bot protection notice shows a masked page readably, and no page when there is none", () => {
  const masked = text(render(summary({ ...finished, botProtection: { vendor: "Cloudflare", url: "https://app.acme.test/reset/%E2%80%A2%E2%80%A2%E2%80%A2?x=1" } })));
  expect(masked).toContain("Cloudflare's bot protection blocked Trawler's browser at /reset/••• . It stops");
  expect(text(render(summary({ ...finished, botProtection: { vendor: "Cloudflare", url: "" } })))).toContain("Cloudflare's bot protection blocked Trawler's browser. It stops");
});

test("friction replayed as a possible defect whose judge gave no verdict can be judged again, says why it was replayed, and is not counted as reported", () => {
  const html = render(summary({
    ...finished,
    jobs: [...finished.jobs, job("judge", "failed", { finding_key: "ana:fr", error: "No output generated." })],
    findings: [finished.findings[0]!, finding("ana:fr", "ana", { kind: "friction", filedAs: "friction", title: "Balance has no history", replay: { completed: true, observed: "No transactions.", blockedAt: null } }), finding("lee:fr", "lee", { kind: "friction", title: "Menu is hard to find" })],
  }));
  const [row] = rows(html, "Could not be judged");
  expect(text(row!.split("</summary>")[0]!)).toBe("high severity 01 · Ana Balance has no history Failed: No output generated. →");
  expect(row).toContain("Ana filed this as friction on a goal they did not reach, so Trawler replayed it too.");
  expect(row).toMatch(/<button type="button"[^>]*>Judge again<\/button>/);
  expect(rows(html, "Friction").map((r) => text(r.split("</summary>")[0]!))).toEqual(["high severity 01 · Lee Park Menu is hard to find o →"]);
  expect(text(band(html))).toContain("Verified 1 of 1 reported");
});

test("an account the beta list will refuse is told so in place of Run again and Judge again, and Start another run stays", () => {
  const message = "Hosted runs are in private beta. Write to contact@usetrawler.com to get access.";
  const run = summary({ ...finished, jobs: [...finished.jobs, job("judge", "failed", { finding_key: "x:d4", error: "the judge timed out" })], findings: [...finished.findings, finding("x:d4", "ana", { title: "Export is empty" })] });
  const html = renderToStaticMarkup(createElement(RunLive, { initial: JSON.parse(JSON.stringify({ run, view: runView(run) })), closedBeta: message }));
  expect(html).not.toMatch(/>Run again/);
  expect(html).toContain(">Start another run</a>");
  expect(html).toContain(`<p class="mt-3 max-w-md self-end border-l-2 border-warn pl-3 text-sm max-wide:self-start">${message}</p>`);
  const [unjudged] = rows(html, "Could not be judged");
  expect(unjudged).not.toContain(">Judge again</button>");
  expect(unjudged).toContain(`<p class="text-sm text-muted">${message}</p>`);
  expect(render(run)).toMatch(/>Run again/);

  const liveRun = summary({ ...live, findings: finished.findings });
  expect(renderToStaticMarkup(createElement(RunLive, { initial: JSON.parse(JSON.stringify({ run: liveRun, view: runView(liveRun) })), closedBeta: message }))).not.toContain(message);
  const judging = summary({ ...finished, jobs: [...finished.jobs, job("judge", "queued", { finding_key: "x:d4", requested: true })], findings: [...finished.findings, finding("x:d4", "ana", { title: "Export is empty" })] });
  const [beingJudged] = rows(renderToStaticMarkup(createElement(RunLive, { initial: JSON.parse(JSON.stringify({ run: judging, view: runView(judging) })), closedBeta: message })), "Could not be judged");
  expect(beingJudged).toContain("Judging again…");
  expect(beingJudged).not.toContain(message);
});

test("a finding Trawler marked not a bug says so and links to the earlier mark it matches, with Undo", () => {
  const html = render(summary({
    ...finished,
    findings: [finding("ana:f1", "ana", { title: "Checkout refuses my postcode", verdict: "confirmed", dismissal: { reason: "We deliver to a fixed list.", userId: "trawler", at: new Date("2026-10-03T10:00:00Z"), by: null, matched: { runNumber: 3, findingKey: "lee:f2" } } })],
  }));
  const [row] = rows(html, "Not a bug");
  expect(row).toContain('Marked by Trawler: it matches a finding marked not a bug in <a href="/runs/0003#finding-lee%3Af2" class="underline underline-offset-4 hover:text-ink">Run 0003</a>.');
  expect(row).toContain("Not a bug, because: </span>We deliver to a fixed list.");
  expect(row).toMatch(/>Undo<span class="sr-only">/);
  expect(row).not.toContain("someone no longer in this workspace");
});

test("the run page names the plan the run came from when the project has several, or the plan was removed", () => {
  expect(render(summary({ ...finished, planName: "Invitations" }))).toMatch(/Invitations · deepseek\/deepseek-v4\.1-flash/);
  expect(render(summary({ ...finished, planName: null }))).not.toContain("Invitations");
});
