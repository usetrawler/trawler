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

const seeing = { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => "page" }) };
const look = toolCall("browser_snapshot", {});
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
      screenshot: async () => null,
      close: async () => void closed++,
    };
  };
  return { open, opened, closed: () => closed };
}

const signedIn = toolCall("report_sign_in", { outcome: "signed_in", observed: "The dashboard, signed in." });
const finished = (summary: string) => [toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary })];

test("roles, then a replay and a judge per defect, each in its own browser", async () => {
  const agent = scriptedModel([signedIn, 
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
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["account:acct", "role:p1", "role:p2", "replay:f1", "judge:f1"]);
  expect(summary.totalCostUsd).toBeCloseTo(0.009, 10);
  expect(browsers.opened).toEqual(["•••", "•••", "•••", "•••"]);
  expect(browsers.closed()).toBe(4);
  const events = readFileSync(join(root, "events.jsonl"), "utf8");
  expect(events).toContain('"type":"verdict"');
  expect(events).toContain('"type":"blocked_request"');
  expect(events).not.toContain("hunter22-secret");
});

test("the replay signs in with the account of the persona that found the defect", async () => {
  const signIn = toolCall("sign_in", { account: "acct", usernameField: "e1", passwordField: "e2" });
  const agent = scriptedModel([signedIn, 
    look,
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
  const agent = scriptedModel([signedIn, toolCall("finish", { summary: "x" })], 2.5);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: browsers.open,
  });
  expect(summary.roles.map((r) => r.persona)).toEqual(["p1"]);
  expect(browsers.opened).toHaveLength(2);
});

test("a browser that fails to close does not end the run", async () => {
  const agent = scriptedModel([signedIn, ...finished("p1"), ...finished("p2")]);
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: async () => ({ tools: {}, fillField: async () => "typed", screenshot: async () => null, close: async () => { throw new Error("already gone"); } }),
  });
  expect(summary.roles.map((r) => r.stoppedBy)).toEqual(["finish", "finish"]);
});

test("a job that throws does not end the run; its role is recorded as an error", async () => {
  const agent = scriptedModel([signedIn, ...finished("p2")]);
  let n = 0;
  const open: OpenBrowser = async () => {
    if (n++ === 1) throw new Error("browserType.launch: Timeout exceeded with hunter22-secret");
    return { tools: seeing, fillField: async () => "typed", screenshot: async () => null, close: async () => {} };
  };
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: open,
  });
  expect(summary.roles.map((r) => [r.persona, r.stoppedBy])).toEqual([["p1", "error"], ["p2", "finish"]]);
  expect(summary.roles[0]!.error).toMatch(/Timeout exceeded/);
  expect(summary.roles[0]!.error).not.toContain("hunter22-secret");
});

test("a defect is left unjudged when the budget is gone after its replay or the replay wrote no report", async () => {
  const agent = scriptedModel([signedIn, 
    look,
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "One", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Two", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    ...finished("p1"),
    ...finished("p2"),
    text("no report"), text("still none"), text("nothing"),
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ], 0.001);
  const judgeModel = scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]);
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 0.0115, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: fakeBrowsers().open,
  });
  expect(summary.replays.f1?.completed).toBe(false);
  expect(summary.verdicts.f1).toBeUndefined();
  expect(summary.replays.f2?.completed).toBe(true);
  expect(summary.verdicts.f2).toBeUndefined();
  expect(judgeModel.doGenerateCalls).toHaveLength(0);
});

test("a defect whose judge never gives a verdict is left unjudged with the judge's error", async () => {
  const agent = scriptedModel([signedIn, 
    look,
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    ...finished("p1"),
    ...finished("p2"),
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ]);
  const judgeModel = scriptedModel([text("no idea"), text("still no idea")]);
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: fakeBrowsers().open,
  });
  expect(summary.verdicts).toEqual({});
  expect(summary.judgeErrors).toEqual({ f1: "the model gave no verdict (2 tries)" });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["account:acct", "role:p1", "role:p2", "replay:f1", "judge:f1"]);
});

test("failed jobs are recorded as events and replay failures leave a trace", async () => {
  const agent = scriptedModel([signedIn, 
    look,
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    ...finished("p1"),
  ]);
  let n = 0;
  const open: OpenBrowser = async () => {
    n++;
    if (n === 3 || n === 4) throw new Error("no chromium hunter22-secret");
    return { tools: seeing, fillField: async () => "typed", screenshot: async () => null, close: async () => {} };
  };
  const events: RunEventInput[] = [];
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: (e) => events.push(e), openBrowser: open,
  });
  expect(events.filter((e) => e.jobId === "role:p2").map((e) => e.type)).toEqual(["job_started", "job_finished"]);
  expect(events.find((e) => e.jobId === "role:p2" && e.type === "job_finished")).toMatchObject({ stoppedBy: "error", error: "no chromium •••" });
  expect(events.find((e) => e.jobId === "replay:f1" && e.type === "job_finished")).toMatchObject({ stoppedBy: "error", error: "no chromium •••" });
  expect(summary.replayErrors).toEqual({ f1: "no chromium •••" });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["account:acct", "role:p1", "role:p2", "replay:f1"]);
});

test("leaves no timers behind once the run is over", async () => {
  const agent = scriptedModel([signedIn, ...finished("p1"), ...finished("p2")]);
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: fakeBrowsers().open,
  });
  expect(timers()).toBeLessThanOrEqual(before);
});

test("people take turns in the plan's order, each told what happened before, and each person's results are kept together", async () => {
  const team = ProjectConfigSchema.parse({
    name: "Pitches", targetUrl: "https://a.test",
    personas: [{ id: "priya", name: "Priya", brief: "b" }, { id: "marco", name: "Marco", brief: "b", accountRef: "acct" }],
    goals: [
      { id: "submit", instruction: "Submit a pitch.", personaId: "priya" },
      { id: "review", instruction: "Accept Priya's pitch.", personaId: "marco" },
      { id: "decision", instruction: "See the decision.", personaId: "priya" },
    ],
    accounts: [{ ref: "acct", username: "a@a.test", password: "hunter22-secret" }],
  });
  const agent = scriptedModel([signedIn, 
    toolCall("note", { text: "Submitted EcoLoop." }), toolCall("goal_status", { goal: "submit", status: "reached", note: "" }), toolCall("finish", { summary: "ok" }),
    toolCall("goal_status", { goal: "review", status: "reached", note: "Accepted EcoLoop." }), toolCall("finish", { summary: "ok" }),
    toolCall("goal_status", { goal: "decision", status: "reached", note: "" }), toolCall("finish", { summary: "ok" }),
  ]);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project: team, agentModel: agent, agentModelId: "m", judgeModel: scriptedModel([]), judgeModelId: "m",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: browsers.open,
  });
  expect(browsers.opened).toHaveLength(4);
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["account:acct", "role:priya#1", "role:marco#2", "role:priya#3"]);
  expect(summary.roles.map((r) => [r.persona, r.goals.map((g) => `${g.goal}:${g.status}`)])).toEqual([
    ["priya", ["submit:reached", "decision:reached"]],
    ["marco", ["review:reached"]],
  ]);
  const prompts = agent.doGenerateCalls.slice(1).map((c) => JSON.stringify(c.prompt));
  expect(prompts[3]).toContain("Submitted EcoLoop.");
  expect(prompts[5]).toContain("Accepted EcoLoop.");
  expect(prompts[5]).toMatch(/priya\.[0-9a-f]{8}@example\.com/);
  expect(/priya\.[0-9a-f]{8}@example\.com/.exec(prompts[5]!)![0]).toBe(/priya\.[0-9a-f]{8}@example\.com/.exec(prompts[0]!)![0]);
});

test("a test account the product refuses stops the run before any person spends the budget", async () => {
  const agent = scriptedModel([
    toolCall("sign_in", { account: "acct", usernameField: "e1", passwordField: "e2" }),
    toolCall("report_sign_in", { outcome: "refused", observed: "Epic sadface: Username and password do not match" }),
  ]);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: agent, judgeModelId: "a", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: browsers.open,
  });
  expect(summary.refusedAccount).toBe("The product refused the username and password of a@a.test: Epic sadface: Username and password do not match");
  expect(summary.roles).toEqual([]);
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["account:acct"]);
  expect(browsers.opened).toHaveLength(1);
});
