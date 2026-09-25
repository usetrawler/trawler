import { expect, test } from "vitest";
import { runView } from "./report.ts";
import type { RunSummary } from "./runs.ts";

const job = (kind: string, status: string, extra: Partial<RunSummary["jobs"][number]> = {}) =>
  ({ id: `${kind}-${status}-${Math.random()}`, kind, status, persona_key: null, finding_key: null, usage: null, stopped_by: null, error: null, ...extra }) as RunSummary["jobs"][number];
const finding = (key: string, persona: string, extra: Partial<RunSummary["findings"][number]> = {}) =>
  ({ key, personaKey: persona, kind: "defect", goal: "g", title: key, observed: "o", reproduction: ["a", "b"], severity: "high", replay: null, verdict: null, ...extra }) as RunSummary["findings"][number];

function summary(over: Partial<RunSummary>): RunSummary {
  return {
    id: "r", number: 1, status: "running", projectId: "p", costUsd: 0.1, budgetUsd: 2, agentModel: "m", judgeModel: "m",
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
  expect(view.personas[0]!.goals).toEqual([{ goal: "Get in.", status: "reached", note: "" }]);
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
