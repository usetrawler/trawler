import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { ProjectConfigSchema, type RunEventInput } from "@usetrawler/protocol";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { localRun, type OpenBrowser } from "./local-run.ts";
import { renderReport, RunDir } from "./run-dir.ts";

const seeing = { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => "page" }) };
const look = toolCall("browser_snapshot", {});
const project = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://a.test",
  personas: [{ id: "p1", name: "A", brief: "b", accountRef: "acct" }, { id: "p2", name: "B", brief: "b" }],
  goals: [{ id: "g", instruction: "x" }],
  accounts: [{ ref: "acct", username: "a@a.test", password: "hunter22-secret" }],
});

function fakeBrowsers(pageUrl: () => string | null = () => null) {
  const opened: string[] = [];
  let closed = 0;
  const open: OpenBrowser = async ({ onBlocked, scrubber }) => {
    opened.push(scrubber.scrub("hunter22-secret"));
    return {
      tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => (onBlocked("https://evil.test/?p=hunter22-secret"), "page") }) },
      fillField: async () => "typed",
      screenshot: async () => null,
      pageUrl,
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
  const browsers = fakeBrowsers(() => "https://a.test/invoices?step=2&token=abc");
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: (e) => void dir.emit(e), openBrowser: browsers.open,
  });
  expect(summary.roles.map((r) => r.persona)).toEqual(["p1", "p2"]);
  expect(summary.roles[0]!.findings[0]!.url).toBe("https://a.test/invoices?step=2&token=%E2%80%A2%E2%80%A2%E2%80%A2");
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

test("what the browser itself could not load goes into the events with its cause and into the summary, masked; Trawler's own blocks only into the events", async () => {
  const open: OpenBrowser = async ({ onBlocked }) => ({
    tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => {
      onBlocked("https://evil.test/");
      onBlocked("ws://localhost:3000/_next/webpack-hmr?key=hunter22-secret", "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS");
      return "page";
    } }) },
    fillField: async () => "typed", screenshot: async () => null, pageUrl: () => null, close: async () => {},
  });
  const events: RunEventInput[] = [];
  const summary = await localRun({
    project: { ...project, personas: [project.personas[1]!] }, agentModel: scriptedModel([look, ...finished("done")]), agentModelId: "a",
    judgeModel: scriptedModel([]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: (e) => events.push(e), openBrowser: open,
  });
  expect(events.filter((e) => e.type === "blocked_request")).toEqual([
    { type: "blocked_request", jobId: "role:p2", url: "https://evil.test/" },
    { type: "blocked_request", jobId: "role:p2", url: "ws://localhost:3000/_next/webpack-hmr?key=•••", cause: "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS" },
  ]);
  expect(summary.browserFailures).toEqual([{ jobId: "role:p2", url: "ws://localhost:3000/_next/webpack-hmr?key=•••", cause: "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS" }]);
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

test.each([[true, true], [false, false], [undefined, false]])("people and replays can look at the page as a picture only when the run is set to (look %j: %s)", async (looks, offered) => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const open: OpenBrowser = async () => ({ tools: seeing, fillField: async () => "typed", screenshot: async () => ({ bytes: png, contentType: "image/png" as const }), pageUrl: () => null, close: async () => {} });
  const agent = scriptedModel([signedIn,
    look,
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    toolCall("look_at_page", {}),
    ...finished("p1 done"),
    ...finished("p2 done"),
    toolCall("look_at_page", {}),
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ]);
  await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: open, ...(looks === undefined ? {} : { look: looks }),
  });
  const withTool = (name: string) => agent.doGenerateCalls.filter((c) => c.tools!.some((t) => t.name === name));
  const offeredLook = (name: string) => withTool(name).every((c) => c.tools!.some((t) => t.name === "look_at_page"));
  expect(withTool("finish").length).toBeGreaterThan(0);
  expect(withTool("report_replay").length).toBeGreaterThan(0);
  expect(offeredLook("finish")).toBe(offered);
  expect(offeredLook("report_replay")).toBe(offered);
  expect(withTool("report_sign_in").some((c) => c.tools!.some((t) => t.name === "look_at_page"))).toBe(false);
  const shown = (name: string) => withTool(name).some((c) => c.prompt.some((m) => m.role === "user" && m.content.some((p) => p.type === "file")));
  expect(shown("finish")).toBe(offered);
  expect(shown("report_replay")).toBe(offered);
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
    emit: () => {}, openBrowser: async () => ({ tools: {}, fillField: async () => "typed", screenshot: async () => null, pageUrl: () => null, close: async () => { throw new Error("already gone"); } }),
  });
  expect(summary.roles.map((r) => r.stoppedBy)).toEqual(["finish", "finish"]);
});

test("a job that throws does not end the run; its role is recorded as an error", async () => {
  const agent = scriptedModel([signedIn, ...finished("p2")]);
  let n = 0;
  const open: OpenBrowser = async () => {
    if (n++ === 1) throw new Error("browserType.launch: Timeout exceeded with hunter22-secret");
    return { tools: seeing, fillField: async () => "typed", screenshot: async () => null, pageUrl: () => null, close: async () => {} };
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
  const judgeModel = scriptedModel([toolCall("report_groups", { groups: [["f1"], ["f2"]] }), text(JSON.stringify({ verdict: "confirmed" }))]);
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 0.0125, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: fakeBrowsers().open,
  });
  expect(summary.replays.f1?.completed).toBe(false);
  expect(summary.verdicts.f1).toBeUndefined();
  expect(summary.replays.f2?.completed).toBe(true);
  expect(summary.verdicts.f2).toBeUndefined();
  expect(judgeModel.doGenerateCalls).toHaveLength(1);
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
    return { tools: seeing, fillField: async () => "typed", screenshot: async () => null, pageUrl: () => null, close: async () => {} };
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

test("the account a person made in their first turn is in their next turn's prompt as the exact username they typed", async () => {
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
    toolCall("type_own_password", { fields: ["e4"] }), toolCall("goal_status", { goal: "submit", status: "reached", note: "" }), toolCall("finish", { summary: "ok" }),
    toolCall("goal_status", { goal: "review", status: "reached", note: "" }), toolCall("finish", { summary: "ok" }),
    toolCall("goal_status", { goal: "decision", status: "reached", note: "" }), toolCall("finish", { summary: "ok" }),
  ]);
  const typed: string[] = [];
  const open: OpenBrowser = async () => ({
    tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => "page" }) },
    fillField: async (_ref, text) => (typed.push(text), "typed the password"),
    accountForm: async () => ({ fields: [{ label: "Username", value: "priya42", type: "text", autocomplete: "username", name: "username" }] }),
    screenshot: async () => null,
    pageUrl: () => "https://a.test/signup",
    close: async () => {},
  });
  const events: RunEventInput[] = [];
  await localRun({
    project: team, agentModel: agent, agentModelId: "m", judgeModel: scriptedModel([]), judgeModelId: "m",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: (e) => events.push(e), openBrowser: open,
  });
  const prompts = agent.doGenerateCalls.slice(1).map((c) => JSON.stringify(c.prompt));
  expect(prompts[5]).toContain('You signed up earlier as Username \\"priya42\\"');
  expect(prompts[5]).toContain("https://a.test/signup");
  expect(prompts[3]).not.toMatch(/priya42/);
  expect(JSON.stringify([events, prompts])).not.toContain(typed[0]);
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

test("a defect that needs two people is replayed in two browsers, one per person, and both are closed", async () => {
  const agent = scriptedModel([signedIn,
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "o", reproduction: ["B: Submit the form", "Open the result"], severity: "high" }),
    ...finished("p1 done"),
    ...finished("p2 done"),
    toolCall("browser_snapshot", {}),
    toolCall("act_as", { person: "A" }),
    toolCall("browser_snapshot", {}),
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ]);
  const judgeModel = scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10,
    emit: () => {}, openBrowser: browsers.open,
  });
  expect(summary.roles[0]!.findings[0]).toMatchObject({ reproduction: ["Submit the form", "Open the result"], by: ["p2", "p1"] });
  expect(summary.verdicts).toEqual({ f1: "confirmed" });
  expect(browsers.opened).toHaveLength(5);
  expect(browsers.closed()).toBe(5);
});

test("once a turn ends in an error the later turns are not started, and their goals say why", async () => {
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
  const agent = scriptedModel([signedIn, text("thinking"), text("still thinking"), text("hmm")]);
  const browsers = fakeBrowsers();
  const summary = await localRun({
    project: team, agentModel: agent, agentModelId: "m", judgeModel: scriptedModel([]), judgeModelId: "m",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: browsers.open,
  });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["account:acct", "role:priya#1"]);
  const why = "not started: the turn of Priya (role:priya#1) ended in an error, so this turn would have built on what never happened";
  expect(summary.roles.map((r) => [r.persona, r.goals])).toEqual([
    ["priya", [{ goal: "submit", status: "not_attempted", note: "" }, { goal: "decision", status: "not_attempted", note: why }]],
    ["marco", [{ goal: "review", status: "not_attempted", note: why }]],
  ]);
});

const SHOP_PAGE = { content: [{ type: "text", text: `### Page\n- Page URL: https://a.test/shop\n### Snapshot\n\`\`\`yaml\n- link "Account" [ref=e1]:\n  - /url: /account\n- searchbox "Search plants" [ref=e2]\n\`\`\`` }] };
const shopBrowser: OpenBrowser = async () => ({
  tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => SHOP_PAGE }) },
  fillField: async () => "typed", screenshot: async () => null, pageUrl: () => "https://a.test/shop", close: async () => {},
});
const shop = ProjectConfigSchema.parse({
  name: "Shop", targetUrl: "https://a.test", description: "Plants, delivered.",
  personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
  goals: [{ id: "order", instruction: "A plant is ordered.", personaId: "ana" }, { id: "browse", instruction: "The shop is open.", personaId: "lee" }],
});
const reached = (goal: string) => [toolCall("goal_status", { goal, status: "reached", note: `${goal} done` }), toolCall("finish", { summary: "done" })];

test("with a second round the lead plans from the pages the people saw, the people it names play its goals, and their defects are replayed like any other", async () => {
  const agent = scriptedModel([
    toolCall("browser_snapshot", {}), ...reached("order"),
    ...reached("browse"),
    text(JSON.stringify({ passedBy: ["the search box"], goals: [{ id: "search-any-case", instruction: "Search in any letter case; the list holds what matches.", personaId: "ana" }] })),
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "defect", goal: "search-any-case", title: "Search needs exact case", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    toolCall("goal_status", { goal: "search-any-case", status: "failed", note: "lowercase finds nothing", blockedBy: "product" }),
    toolCall("finish", { summary: "done" }),
    toolCall("report_replay", { completed: true, observed: "Nothing found", blockedAt: null }),
  ]);
  const events: RunEventInput[] = [];
  const summary = await localRun({
    project: shop, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]), judgeModelId: "j",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: (e) => void events.push(e), openBrowser: shopBrowser, secondRound: true,
  });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee", "plan:second-round", "role:ana#second-round", "replay:f1", "judge:f1"]);
  expect(summary.secondRound).toEqual({ passedBy: ["the search box"], goals: [{ id: "search-any-case", instruction: "Search in any letter case; the list holds what matches.", personaId: "ana" }], sessions: [{ persona: "ana", stoppedBy: "finish" }] });
  expect(summary.roles.find((r) => r.persona === "ana")!.goals.map((g) => `${g.goal}:${g.status}`)).toEqual(["order:reached", "search-any-case:failed"]);
  expect(summary.roles.find((r) => r.persona === "lee")!.goals.map((g) => g.goal)).toEqual(["browse"]);
  expect(summary.verdicts).toEqual({ f1: "confirmed" });
  const prompts = agent.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
  const plan = prompts.find((p) => p.includes("you plan a second round"))!;
  expect(plan).toContain(String.raw`- searchbox \"Search plants\"`);
  expect(plan).not.toContain("ref=e2");
  expect(plan).toContain("Account (seen by Ana)");
  expect(plan).toContain("https://a.test/shop (seen by Ana)");
  expect(plan).toContain("order done");
  const second = prompts.filter((p) => p.includes("[search-any-case] Search in any letter case"));
  expect(second.length).toBeGreaterThan(0);
  expect(second[0]).toContain("you started using earlier in this session");
  expect(second[0]).not.toContain("[order] A plant is ordered.");
  expect(events.filter((e) => e.jobId === "plan:second-round").map((e) => e.type)).toEqual(["job_started", "job_finished"]);
  const md = renderReport(summary);
  expect(md).toMatch(/## Second round\n\nGoals written after the first round[\s\S]*What the first round passed by:\n\n- the search box\n\n- search-any-case \(Ana\): Search in any letter case; the list holds what matches\.\n\n## Goals/);
  expect(md).toContain("- search-any-case (second round): failed");
  expect(md).toContain("defect, high, ana / search-any-case, second round");
  expect(md).toContain("- order: reached");
  expect(md).not.toContain("second-round session was stopped");
});

test("the lead is told what the first round reported, its plan is masked before anyone sees it, and a failed plan leaves its events", async () => {
  const secret = ProjectConfigSchema.parse({ ...shop, accounts: [{ ref: "acct", username: "a@a.test", password: "hunter22-secret" }] });
  const first = [
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "friction", goal: "order", title: "Hidden checkout", observed: "o", reproduction: ["a"], severity: "low" }),
    ...reached("order"), toolCall("browser_snapshot", {}), ...reached("browse"),
  ];
  const agent = scriptedModel([...first, text(JSON.stringify({ passedBy: ["a field holding hunter22-secret"], goals: [{ id: "more", instruction: "Type hunter22-secret into the search.", personaId: "lee" }] })), ...reached("more")]);
  const summary = await localRun({
    project: secret, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser, secondRound: true,
  });
  expect(summary.secondRound!.goals).toEqual([{ id: "more", instruction: "Type ••• into the search.", personaId: "lee" }]);
  expect(summary.secondRound!.passedBy).toEqual(["a field holding •••"]);
  const plan = agent.doGenerateCalls.map((c) => JSON.stringify(c.prompt)).find((p) => p.includes("you plan a second round"))!;
  expect(plan).toContain("Hidden checkout");
  expect(plan).toMatch(/person[^}]*ana[^}]*order done/);

  const events: RunEventInput[] = [];
  await localRun({
    project: shop, agentModel: scriptedModel([...first, text("no"), text("no")]), agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: (e) => void events.push(e), openBrowser: shopBrowser, secondRound: true,
  });
  expect(events.filter((e) => e.jobId === "plan:second-round")).toMatchObject([{ type: "job_started", kind: "setup" }, { type: "job_finished", stoppedBy: "error", error: "the lead could not plan a second round: the model gave no usable plan (2 tries)" }]);
});

test("after a team plan's turn ended in an error nobody goes on to a second round", async () => {
  const team = ProjectConfigSchema.parse({ ...shop, goals: [...shop.goals, { id: "again", instruction: "The plant is ordered again.", personaId: "ana" }] });
  let opened = 0;
  const summary = await localRun({
    project: team, agentModel: scriptedModel([toolCall("browser_snapshot", {}), ...reached("order")]), agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, secondRound: true,
    openBrowser: async (o) => {
      if (++opened === 2) throw new Error("the browser would not start");
      return shopBrowser(o);
    },
  });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana#1", "role:lee#2"]);
  expect(summary.secondRound).toEqual({ goals: [], passedBy: [], sessions: [], error: "the turn of Lee (role:lee#2) ended in an error, so nobody went on to a second round" });
});

test("without --second-round nobody is asked for more goals", async () => {
  const agent = scriptedModel([toolCall("browser_snapshot", {}), ...reached("order"), ...reached("browse")]);
  const summary = await localRun({
    project: shop, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser,
  });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee"]);
  expect(summary.secondRound).toBeUndefined();
  expect(renderReport(summary)).not.toContain("Second round");
});

test("a second round the lead could not plan is said in the report, and what the first round found is still replayed", async () => {
  const agent = scriptedModel([
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "defect", goal: "order", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" }),
    ...reached("order"), ...reached("browse"),
    text("not a plan"), text("still not a plan"),
    toolCall("report_replay", { completed: true, observed: "It broke", blockedAt: null }),
  ]);
  const summary = await localRun({
    project: shop, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]), judgeModelId: "j",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser, secondRound: true,
  });
  expect(summary.secondRound).toEqual({ goals: [], passedBy: [], sessions: [], error: "the lead could not plan a second round: the model gave no usable plan (2 tries)" });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee", "plan:second-round", "replay:f1", "judge:f1"]);
  expect(summary.jobs.find((j) => j.jobId === "plan:second-round")!.costUsd).toBeCloseTo(0.002, 10);
  expect(summary.verdicts).toEqual({ f1: "confirmed" });
  expect(renderReport(summary)).toContain("## Second round\n\nNot played: the lead could not plan a second round: the model gave no usable plan (2 tries)\n");
});

test("a provider error too long for an event does not take the run down with it", async () => {
  const agent = scriptedModel([toolCall("browser_snapshot", {}), ...reached("order"), ...reached("browse"), new Error("x".repeat(3000))]);
  const dir = new RunDir(mkdtempSync(join(tmpdir(), "run-")));
  const summary = await localRun({
    project: shop, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: (e) => void dir.emit(e), openBrowser: shopBrowser, secondRound: true,
  });
  expect(summary.roles.map((r) => r.stoppedBy)).toEqual(["finish", "finish"]);
  expect(summary.secondRound!.error).toHaveLength("the lead could not plan a second round: ".length + 3000);
  const finished = readFileSync(dir.path("events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.jobId === "plan:second-round" && e.type === "job_finished");
  expect(finished.error).toHaveLength(2000);
});

test("a second-round session that breaks leaves the person's first round as it ended, and the report says what happened", async () => {
  const solo = ProjectConfigSchema.parse({ ...shop, personas: [shop.personas[0]], goals: [shop.goals[0]] });
  const agent = scriptedModel([toolCall("browser_snapshot", {}), ...reached("order"), text(JSON.stringify({ goals: [{ id: "more", instruction: "Try the search.", personaId: "ana" }] }))]);
  let opened = 0;
  const summary = await localRun({
    project: solo, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, secondRound: true,
    openBrowser: async (o) => {
      if (++opened === 2) throw new Error("the browser would not start");
      return shopBrowser(o);
    },
  });
  expect(summary.roles).toMatchObject([{ persona: "ana", stoppedBy: "finish", goals: [{ goal: "order", status: "reached" }, { goal: "more", status: "not_attempted" }] }]);
  expect(summary.roles[0]!.error).toBeUndefined();
  expect(summary.secondRound!.sessions).toEqual([{ persona: "ana", stoppedBy: "error", error: "the browser would not start" }]);
  expect(renderReport(summary)).toContain("- Ana's second-round session was stopped by error: the browser would not start\n");
});

test("when the budget runs out the report says which second-round goals nobody started, or that the round was not planned", async () => {
  const session = () => scriptedModel([toolCall("browser_snapshot", {}), ...reached("order"), toolCall("browser_snapshot", {}), ...reached("browse"), text(JSON.stringify({ goals: [{ id: "more", instruction: "Try the search.", personaId: "lee" }] }))]);
  const run = (budgetUsd: number) => localRun({
    project: shop, agentModel: session(), agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j", budgetUsd, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser, secondRound: true,
  });
  const afterPlanning = await run(0.0065);
  expect(afterPlanning.secondRound!.goals.map((g) => g.id)).toEqual(["more"]);
  expect(afterPlanning.secondRound!.sessions).toEqual([]);
  expect(afterPlanning.roles.find((r) => r.persona === "lee")).toMatchObject({ stoppedBy: "finish", goals: [{ goal: "browse", status: "reached" }, { goal: "more", status: "not_attempted", note: "not started: the budget ran out" }] });
  const before = await run(0.0055);
  expect(before.secondRound).toEqual({ goals: [], passedBy: [], sessions: [], error: "the budget ran out before the second round" });
  expect(before.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee"]);
});

test("when nobody saw a page there is nothing to plan a second round from", async () => {
  const agent = scriptedModel([...reached("order"), ...reached("browse")]);
  const summary = await localRun({
    project: shop, agentModel: agent, agentModelId: "a", judgeModel: scriptedModel([]), judgeModelId: "j",
    budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser, secondRound: true,
  });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee"]);
  expect(summary.secondRound).toEqual({ goals: [], passedBy: [], sessions: [], error: "nobody saw a page to plan it from" });
  expect(renderReport(summary)).toContain("Not played: nobody saw a page to plan it from");
});

const reportsOfOneCause = [
  toolCall("browser_snapshot", {}),
  toolCall("submit_finding", { kind: "defect", goal: "order", title: "Total stale after quantity change", observed: "o1", reproduction: ["a", "b"], severity: "high" }),
  toolCall("browser_snapshot", {}),
  toolCall("submit_finding", { kind: "defect", goal: "order", title: "Search is case-sensitive", observed: "o2", reproduction: ["c", "d"], severity: "medium" }),
  ...reached("order"),
  toolCall("browser_snapshot", {}),
  toolCall("submit_finding", { kind: "defect", goal: "browse", title: "Cart total never updates", observed: "o3", reproduction: ["d", "e"], severity: "high" }),
  ...reached("browse"),
];

test("reports of the same defect are grouped, one of each group is replayed and judged, and the report shows the others under it", async () => {
  const agent = scriptedModel([...reportsOfOneCause, toolCall("report_replay", { completed: true, observed: "Stale", blockedAt: null }), toolCall("report_replay", { completed: true, observed: "Nothing for fern", blockedAt: null })]);
  const judgeModel = scriptedModel([toolCall("report_groups", { groups: [["f3", "f1"], ["f2"]] }), text(JSON.stringify({ verdict: "confirmed" })), text(JSON.stringify({ verdict: "confirmed" }))]);
  const summary = await localRun({ project: shop, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee", "group", "replay:f1", "judge:f1", "replay:f2", "judge:f2"]);
  expect(summary.sameAs).toEqual({ f3: "f1" });
  expect(summary.verdicts).toEqual({ f1: "confirmed", f2: "confirmed" });
  const grouping = JSON.stringify(judgeModel.doGenerateCalls[0]!.prompt);
  expect(grouping).toContain("Cart total never updates");
  expect(grouping).toContain("A plant is ordered.");
  const md = renderReport(summary);
  expect(md.match(/^### /gm)).toHaveLength(2);
  expect(md).toContain("Also reported, as the same defect:\n- Lee / browse: Cart total never updates\n\nReplay: carried out every step. Stale");
  expect(md).not.toContain("### Cart total never updates");
});

test("when the replay of a group's first report writes no report, the next report of the group is replayed and stands for the group", async () => {
  const agent = scriptedModel([...reportsOfOneCause, text("lost"), text("still lost"), text("gone"), toolCall("report_replay", { completed: true, observed: "Stale", blockedAt: null }), toolCall("report_replay", { completed: true, observed: "Nothing", blockedAt: null })]);
  const judgeModel = scriptedModel([toolCall("report_groups", { groups: [["f1", "f3"], ["f2"]] }), text(JSON.stringify({ verdict: "confirmed" })), text(JSON.stringify({ verdict: "refuted" }))]);
  const summary = await localRun({ project: shop, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser });
  expect(summary.jobs.map((j) => j.jobId)).toEqual(["role:ana", "role:lee", "group", "replay:f1", "replay:f3", "judge:f3", "replay:f2", "judge:f2"]);
  expect(summary.sameAs).toEqual({ f1: "f3" });
  expect(summary.verdicts).toEqual({ f3: "confirmed", f2: "refuted" });
  const md = renderReport(summary);
  expect(md).toMatch(/## Confirmed defects\n\n### Cart total never updates[\s\S]*Also reported, as the same defect:\n- Ana \/ order: Total stale after quantity change/);
});

test("a grouping that fails leaves every report to be replayed on its own, and one report is not sent to be grouped", async () => {
  const agent = scriptedModel([...reportsOfOneCause, ...["Stale", "Nothing", "Stale"].map((observed) => toolCall("report_replay", { completed: true, observed, blockedAt: null }))]);
  const judgeModel = scriptedModel([text("no"), text("no"), ...Array.from({ length: 3 }, () => text(JSON.stringify({ verdict: "confirmed" })))]);
  const summary = await localRun({ project: shop, agentModel: agent, agentModelId: "a", judgeModel, judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser });
  expect(summary.sameAs).toEqual({});
  expect(Object.keys(summary.verdicts)).toEqual(["f1", "f2", "f3"]);

  const single = scriptedModel([toolCall("browser_snapshot", {}), toolCall("submit_finding", { kind: "defect", goal: "order", title: "One", observed: "o", reproduction: ["a"], severity: "high" }), ...reached("order"), ...reached("browse"), toolCall("report_replay", { completed: true, observed: "x", blockedAt: null })]);
  const once = await localRun({ project: shop, agentModel: single, agentModelId: "a", judgeModel: scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]), judgeModelId: "j", budgetUsd: 5, maxSteps: 10, replaySteps: 10, emit: () => {}, openBrowser: shopBrowser });
  expect(once.jobs.map((j) => j.jobId)).not.toContain("group");
});
