import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { ProjectConfigSchema, type RunEventInput } from "@usetrawler/protocol";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { localRun, type OpenBrowser } from "./local-run.ts";
import { RunDir } from "./run-dir.ts";

const project = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://a.test",
  personas: [{ id: "p1", name: "A", brief: "b", accountRef: "acct" }, { id: "p2", name: "B", brief: "b" }],
  goals: [{ id: "g", instruction: "x" }],
  accounts: [{ ref: "acct", username: "a@a.test", password: "hunter22-secret" }],
});

function fakeBrowsers() {
  const opened: string[] = [];
  let closed = 0;
  const open: OpenBrowser = async ({ onBlocked, scrubber }) => {
    opened.push(scrubber.scrub("hunter22-secret"));
    return {
      tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => (onBlocked("https://evil.test/?p=hunter22-secret"), "page") }) },
      fillField: async () => "typed",
      close: async () => void closed++,
    };
  };
  return { open, opened, closed: () => closed };
}

const finished = (summary: string) => [toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary })];

test("roles, then a replay and a judge per defect, each in its own browser", async () => {
  const agent = scriptedModel([
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    ...finished("p1 done"),
    ...finished("p2 done"),
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ]);
  const judgeModel = scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]);
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const dir = new RunDir(root);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: (e) => void dir.emit(e), openBrowser: browsers.open,
  });
  expect(summary.roles.map((r) => r.persona)).toEqual(["p1", "p2"]);
  expect(summary.verdicts).toEqual({ f1: "confirmed" });
  expect(summary.replays.f1).toEqual({ completed: true, observed: "It broke", blockedAt: null });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:p1", "role:p2", "replay:f1", "judge:f1"]);
  expect(summary.totalCostUsd).toBeCloseTo(0.008, 10);
  expect(browsers.opened).toEqual(["•••", "•••", "•••"]);
  expect(browsers.closed()).toBe(3);
  const events = readFileSync(join(root, "events.jsonl"), "utf8");
  expect(events).toContain('"type":"verdict"');
  expect(events).toContain('"type":"blocked_request"');
  expect(events).not.toContain("hunter22-secret");
});

test("the replay signs in with the account of the persona that found the defect", async () => {
  const signIn = toolCall("sign_in", { account: "acct", usernameField: "e1", passwordField: "e2" });
  const agent = scriptedModel([
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    ...finished("p1"),
    ...finished("p2"),
    signIn,
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ]);
  const events: RunEventInput[] = [];
  await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]), judgeModelId: "j",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: (e) => events.push(e), openBrowser: fakeBrowsers().open,
  });
  const replayResults = JSON.stringify(agent.doGenerateCalls.at(-1)!.prompt);
  expect(replayResults).toContain("typed");
  expect(replayResults).not.toMatch(/unknown account/);
});

test("stops scheduling once the budget is spent", async () => {
  const agent = scriptedModel([toolCall("finish", { summary: "x" })], 5);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: browsers.open,
  });
  expect(summary.roles.map((r) => r.persona)).toEqual(["p1"]);
  expect(browsers.opened).toHaveLength(1);
});

test("a browser that fails to close does not end the run", async () => {
  const agent = scriptedModel([...finished("p1"), ...finished("p2")]);
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: async () => ({ tools: {}, fillField: async () => "typed", close: async () => { throw new Error("already gone"); } }),
  });
  expect(summary.roles.map((r) => r.stoppedBy)).toEqual(["finish", "finish"]);
});
