import { expect, test } from "vitest";
import { runView } from "./report.ts";
import type { RunSummary } from "./runs.ts";

const job = (kind: string, status: string, extra: Partial<RunSummary["jobs"][number]> = {}) =>
  ({ id: `${kind}-${status}-${Math.random()}`, kind, status, persona_key: null, finding_key: null, usage: null, stopped_by: null, error: null, requested: false, ...extra }) as RunSummary["jobs"][number];
const finding = (key: string, persona: string, extra: Partial<RunSummary["findings"][number]> = {}) =>
  ({ key, personaKey: persona, kind: "defect", goal: "g", title: key, observed: "o", reproduction: ["a", "b"], severity: "high", replay: null, verdict: null, ...extra }) as RunSummary["findings"][number];

function summary(over: Partial<RunSummary>): RunSummary {
  return {
    id: "r", number: 1, status: "running", projectId: "p", costUsd: 0.1, budgetUsd: 2, agentModel: "m", judgeModel: "m",
    provider: "openrouter", tokenCap: null, tokensUsed: 0,
    createdAt: new Date(), startedAt: new Date(), finishedAt: null, jobs: [], findings: [], goals: [], target: "https://a.test/",
    personas: [{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee" }], goalTexts: [{ id: "g", instruction: "Get in." }], activity: [],
    ...over,
  };
}

test("while people explore, the use stage is active and each person shows where they are", () => {
  const view = runView(summary({
    jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("role_session", "leased", { persona_key: "lee" })],
    goals: [{ personaKey: "ana", goal: "g", status: "reached", note: "" }],
  }));
  expect(view.stages.map((s) => s.state)).toEqual(["active", "waiting", "waiting", "waiting"]);
  expect(view.personas.map((p) => p.state)).toEqual(["reached", "exploring"]);
  expect(view.personas[0]!.goals).toEqual([{ id: "g", goal: "Get in.", status: "reached", note: "" }]);
  expect(view.personas[1]!.goals).toEqual([{ id: "g", goal: "Get in.", status: null, note: "" }]);
  expect(view.headline).toMatch(/using the product/);
});

test("a finished run sorts defects by verdict and explains the ones never judged", () => {
  const view = runView(summary({
    status: "succeeded",
    jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("role_session", "failed", { persona_key: "lee", error: "boom" }), job("replay", "succeeded"), job("replay", "succeeded"), job("judge", "succeeded")],
    findings: [
      finding("ana:f1", "ana", { verdict: "confirmed" }),
      finding("ana:f2", "ana", { replay: { completed: false, observed: "", blockedAt: null } }),
      finding("ana:f3", "ana", { kind: "friction" }),
    ],
    goals: [{ personaKey: "ana", goal: "g", status: "failed", note: "stuck" }],
  }));
  expect(view.stages.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
  expect(view.report.confirmed.map((f) => [f.key, f.personaName, f.goalText])).toEqual([["ana:f1", "Ana", "Get in."]]);
  expect(view.report.notJudged[0]!.reason).toMatch(/could not follow/);
  expect(view.report.friction).toHaveLength(1);
  expect(view.personas.map((p) => p.state)).toEqual(["missed", "failed"]);
  expect(view.headline).toBe("1 defect confirmed by replay.");
  expect(view.goalsTotal).toBe(2);
});

test("a run stopped at the cap says so, and skipped stages are marked", () => {
  const view = runView(summary({ status: "stopped_budget", jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("role_session", "cancelled", { persona_key: "lee" })], findings: [finding("ana:f1", "ana")] }));
  expect(view.stages.map((s) => s.state)).toEqual(["done", "skipped", "skipped", "done"]);
  expect(view.personas[1]!.state).toBe("cancelled");
  expect(view.report.notJudged[0]!.reason).toMatch(/ended before/);
  expect(view.headline).toBe("Stopped at the cap. None of the reported defects was confirmed.");
});

test("a run stopped while someone was still exploring settles instead of looking live forever", () => {
  const view = runView(summary({ status: "cancelled", jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("role_session", "leased", { persona_key: "lee" })] }));
  expect(view.live).toBe(false);
  expect(view.personas.map((p) => p.state)).toEqual(["finished", "cancelled"]);
  expect(view.stages.map((s) => s.state)).toEqual(["done", "skipped", "skipped", "done"]);
});

test("replays that were all cancelled by the cap count as skipped, not done", () => {
  const view = runView(summary({ status: "stopped_budget", jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("replay", "cancelled"), job("replay", "cancelled")] }));
  expect(view.stages[1]!.state).toBe("skipped");
});

test("reaching one of several goals is not reported as reaching the goal", () => {
  const view = runView(summary({
    goalTexts: [{ id: "g", instruction: "Get in." }, { id: "h", instruction: "Pay." }],
    jobs: [job("role_session", "succeeded", { persona_key: "ana" })],
    goals: [{ personaKey: "ana", goal: "g", status: "reached", note: "" }],
  }));
  expect(view.personas[0]!.state).toBe("finished");
});

const replayed = { replay: { completed: true, observed: "Internal Server Error", blockedAt: null } };
const judged = (status: string, extra: Partial<RunSummary["jobs"][number]> = {}) => job("judge", status, { finding_key: "ana:f1", ...extra });
const modelError = { stopped_by: "error", error: "the model ran out of room before it gave a verdict (2 tries)" };
const finished = (over: Partial<RunSummary>) => runView(summary({ status: "succeeded", ...over }));

test("a defect whose judge failed is shown as could not be judged with the model's error, not as inconclusive", () => {
  const view = finished({
    jobs: [job("role_session", "succeeded", { persona_key: "ana" }), job("replay", "succeeded"), judged("failed", { stopped_by: "error", error: "No output generated." })],
    findings: [finding("ana:f1", "ana", { ...replayed, verdict: "inconclusive" })],
  });
  expect(view.report.inconclusive).toEqual([]);
  expect(view.report.notJudged).toEqual([]);
  expect(view.report.couldNotJudge).toEqual([expect.objectContaining({ key: "ana:f1", reason: "Model error: No output generated.", action: "judge_again" })]);
  expect(view.rejudging).toBe(false);
});

test("a failed judge job never hides a verdict the judge did give", () => {
  const view = finished({ jobs: [judged("failed", { stopped_by: null, error: "the runner stopped answering" })], findings: [finding("ana:f1", "ana", { ...replayed, verdict: "confirmed" })] });
  expect(view.report.confirmed.map((f) => f.key)).toEqual(["ana:f1"]);
  expect(view.report.couldNotJudge).toEqual([]);
});

test("a runner failure is not blamed on the model", () => {
  for (const [extra, reason] of [
    [{ stopped_by: null, error: "the runner stopped answering" }, "Failed: the runner stopped answering"],
    [{ stopped_by: "error", error: "the runner could not report events: HTTP 503 from /api/jobs/x/events" }, "Failed: the runner could not report events: HTTP 503 from /api/jobs/x/events"],
  ] as const) {
    const view = finished({ jobs: [judged("failed", extra)], findings: [finding("ana:f1", "ana", replayed)] });
    expect(view.report.couldNotJudge.map((f) => f.reason)).toEqual([reason]);
  }
});

test("a judge stopped by the proxy or the cap says why, and offers judging again only while the cap has room", () => {
  const refused = finished({ jobs: [judged("succeeded", { stopped_by: "budget", error: "the provider account behind the workspace key is out of credits" })], findings: [finding("ana:f1", "ana", replayed)] });
  expect(refused.report.couldNotJudge).toEqual([expect.objectContaining({ reason: "Stopped: the provider account behind the workspace key is out of credits", action: "judge_again" })]);
  const capped = finished({ status: "stopped_budget", costUsd: 2.01, jobs: [judged("succeeded", { stopped_by: "budget" })], findings: [finding("ana:f1", "ana", replayed)] });
  expect(capped.report.couldNotJudge).toEqual([expect.objectContaining({ reason: "The run's cap ran out before the judge answered.", action: "cap_spent" })]);
  const stopped = finished({ status: "cancelled", jobs: [judged("succeeded", { stopped_by: "budget" })], findings: [finding("ana:f1", "ana", replayed)] });
  expect(stopped.report.couldNotJudge.map((f) => f.reason)).toEqual(["You stopped the run before the judge answered."]);
});

test("judging again is not offered once the run's cap is spent", () => {
  const dollars = finished({ status: "stopped_budget", costUsd: 2, jobs: [judged("failed", modelError)], findings: [finding("ana:f1", "ana", replayed)] });
  const tokens = finished({ tokenCap: 1000, tokensUsed: 1000, jobs: [judged("failed", modelError)], findings: [finding("ana:f1", "ana", replayed)] });
  const room = finished({ costUsd: 1.99, tokenCap: 1000, tokensUsed: 999, jobs: [judged("failed", modelError)], findings: [finding("ana:f1", "ana", replayed)] });
  expect([dollars, tokens, room].map((v) => v.report.couldNotJudge[0]!.action)).toEqual(["cap_spent", "cap_spent", "judge_again"]);
});

test("an old inconclusive that the judge wrote when the proxy refused it is not taken as a verdict", () => {
  const legacy = finished({ jobs: [judged("succeeded", { stopped_by: "budget" })], findings: [finding("ana:f1", "ana", { ...replayed, verdict: "inconclusive" })] });
  expect(legacy.report.inconclusive).toEqual([]);
  expect(legacy.report.couldNotJudge.map((f) => f.key)).toEqual(["ana:f1"]);
  const genuine = finished({ jobs: [judged("failed", modelError), judged("succeeded", { stopped_by: "budget", requested: true })], findings: [finding("ana:f1", "ana", { ...replayed, verdict: "inconclusive" })] });
  expect(genuine.report.inconclusive.map((f) => f.key)).toEqual(["ana:f1"]);
});

test("while the run is live a failed judge waits for the run to end before it can be judged again", () => {
  const view = runView(summary({ jobs: [judged("failed", modelError), job("replay", "queued")], findings: [finding("ana:f1", "ana", replayed)] }));
  expect(view.report.couldNotJudge.map((f) => f.action)).toEqual(["after_run"]);
});

test("a defect being judged again says so while it waits and while it runs, and the finished run keeps updating", () => {
  for (const status of ["queued", "leased"]) {
    const view = finished({ jobs: [judged("failed", modelError), judged(status, { requested: true })], findings: [finding("ana:f1", "ana", replayed)] });
    expect(view.live).toBe(false);
    expect(view.rejudging).toBe(true);
    expect(view.report.couldNotJudge).toEqual([expect.objectContaining({ key: "ana:f1", reason: "Judging again…", action: "judging" })]);
    expect(view.stages.find((st) => st.label === "Judge")!.state).toBe("active");
  }
});

test("a judge that was still running when the run stopped is not shown as judging again", () => {
  const view = runView(summary({ status: "cancelled", jobs: [job("replay", "succeeded"), judged("leased")], findings: [finding("ana:f1", "ana", replayed)] }));
  expect(view.rejudging).toBe(false);
  expect(view.report.couldNotJudge).toEqual([]);
  expect(view.report.notJudged.map((f) => f.reason)).toEqual(["The run ended before it was judged."]);
});

test("a defect judged again takes its new verdict", () => {
  const view = finished({
    jobs: [judged("failed", modelError), judged("succeeded", { stopped_by: "done", requested: true })],
    findings: [finding("ana:f1", "ana", { ...replayed, verdict: "confirmed" })],
  });
  expect(view.report.confirmed.map((f) => f.key)).toEqual(["ana:f1"]);
  expect(view.report.couldNotJudge).toEqual([]);
  expect(view.rejudging).toBe(false);
  expect(view.headline).toBe("1 defect confirmed by replay.");
});

test("a defect that was replayed but never judged is not said to be unreplayed", () => {
  const ended = runView(summary({ status: "stopped_budget", jobs: [job("replay", "succeeded"), judged("cancelled")], findings: [finding("ana:f1", "ana", replayed)] }));
  expect(ended.report.notJudged.map((f) => f.reason)).toEqual(["The run ended before it was judged."]);
  const live = runView(summary({ jobs: [job("replay", "succeeded"), judged("queued")], findings: [finding("ana:f1", "ana", replayed)] }));
  expect(live.report.notJudged.map((f) => f.reason)).toEqual(["Waiting for the judge."]);
});
