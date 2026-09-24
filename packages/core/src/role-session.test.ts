import { tool } from "ai";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { ProjectConfigSchema, type RunEventInput } from "@usetrawler/protocol";
import { Budget } from "./llm.ts";
import { runRoleSession } from "./role-session.ts";
import { SecretScrubber } from "./secrets.ts";
import { scriptedModel, toolCall } from "./testing.ts";

const project = ProjectConfigSchema.parse({
  name: "Acme",
  targetUrl: "https://acme.test",
  description: "Invoices.",
  personas: [{ id: "solo", name: "Kwame", brief: "Impatient.", accountRef: "solo" }],
  goals: [{ id: "sign-up", instruction: "Create an account." }, { id: "invoice", instruction: "Send an invoice." }],
  accounts: [{ ref: "solo", username: "k@acme.test", password: "hunter22-secret" }],
});
const snapshot = '- textbox "Password" [ref=e4]\n' + "x".repeat(6000);
const browserTools = {
  browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => ({ content: [{ type: "text", text: snapshot }] }) }),
};
const reached = (goal: string) => toolCall("goal_status", { goal, status: "reached", note: "" });
const finish = toolCall("finish", { summary: "done" });

function run(model: ReturnType<typeof scriptedModel>, over: Partial<Parameters<typeof runRoleSession>[0]> = {}) {
  const events: RunEventInput[] = [];
  let n = 0;
  const promise = runRoleSession({
    model, modelId: "mock", persona: project.personas[0]!, project, browserTools,
    fillField: async (ref, text) => `fill('${text}') into ${ref}`, scrubber: SecretScrubber.forProject(project),
    budget: new Budget(10), maxSteps: 20, emit: (e) => events.push(e), newFindingId: () => `f${++n}`, ...over,
  });
  return { events, promise };
}

describe("runRoleSession", () => {
  test("records findings and goals and stops once finish is accepted", async () => {
    const model = scriptedModel([
      toolCall("browser_snapshot", {}),
      toolCall("submit_finding", { kind: "defect", goal: "sign-up", title: "500", observed: "got a 500", reproduction: ["a", "b"], severity: "high" }),
      toolCall("goal_status", { goal: "sign-up", status: "failed", note: "500 on submit" }),
      reached("invoice"),
      finish,
    ]);
    const { promise, events } = run(model);
    const { result, usage } = await promise;
    expect(result.stoppedBy).toBe("finish");
    expect(result.findings.map((f) => f.id)).toEqual(["f1"]);
    expect(result.goals).toEqual([
      { goal: "sign-up", status: "failed", note: "500 on submit" },
      { goal: "invoice", status: "reached", note: "" },
    ]);
    expect(usage).toMatchObject({ model: "mock", steps: 5, inputTokens: 500, outputTokens: 100 });
    expect(usage.costUsd).toBeCloseTo(0.005, 10);
    expect(events[0]).toMatchObject({ type: "job_started", jobId: "role:solo", kind: "role_session" });
    expect(events.filter((e) => e.type === "step").map((e) => (e as { tool: string | null }).tool)).toEqual(["browser_snapshot", "submit_finding", "goal_status", "goal_status", "finish"]);
    expect(events.at(-1)).toMatchObject({ type: "job_finished", stoppedBy: "finish" });
  });

  test("a refused finish keeps the session going", async () => {
    const model = scriptedModel([finish, reached("sign-up"), reached("invoice"), finish]);
    const { result, usage } = await run(model).promise;
    expect(result.stoppedBy).toBe("finish");
    expect(usage.steps).toBe(4);
  });

  test("reports goals it never reached as not attempted when stopped at maxSteps", async () => {
    const model = scriptedModel([
      toolCall("submit_finding", { kind: "friction", goal: "invoice", title: "lost", observed: "could not find it", reproduction: ["a"], severity: "low" }),
      ...Array.from({ length: 10 }, () => toolCall("browser_snapshot", {})),
    ]);
    const { result } = await run(model, { maxSteps: 3 }).promise;
    expect(result.stoppedBy).toBe("max_steps");
    expect(result.findings).toHaveLength(1);
    expect(result.goals.map((g) => g.status)).toEqual(["not_attempted", "not_attempted"]);
  });

  test("stops when the budget is exceeded", async () => {
    const model = scriptedModel(Array.from({ length: 10 }, () => toolCall("browser_snapshot", {})), 0.5);
    const budget = new Budget(1);
    const { result, usage } = await run(model, { budget }).promise;
    expect(result.stoppedBy).toBe("budget");
    expect(usage.steps).toBe(2);
    expect(budget.spent).toBeCloseTo(1, 10);
  });

  test("a model error ends the session but keeps what was recorded", async () => {
    const model = scriptedModel([toolCall("submit_finding", { kind: "friction", goal: "invoice", title: "lost", observed: "could not find it", reproduction: ["a"], severity: "low" })]);
    const { promise, events } = run(model);
    const { result } = await promise;
    expect(result.stoppedBy).toBe("error");
    expect(result.findings).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "job_finished", stoppedBy: "error" });
  });

  test("never sends the password to the model or into events", async () => {
    const model = scriptedModel([
      toolCall("sign_in", { account: "solo", usernameField: "e3", passwordField: "e4" }),
      toolCall("note", { text: "the page showed hunter22-secret" }),
      reached("sign-up"),
      reached("invoice"),
      finish,
    ]);
    const { promise, events } = run(model);
    await promise;
    const prompts = JSON.stringify(model.doGenerateCalls.map((c) => c.prompt));
    expect(prompts).toContain("fill('•••')");
    expect(prompts).not.toContain("hunter22-secret");
    expect(JSON.stringify(events)).not.toContain("hunter22-secret");
  });

  test("elides old snapshots but keeps the scratchpad and goal table in the system prompt", async () => {
    const model = scriptedModel([
      toolCall("note", { text: "signup form is at /join" }),
      toolCall("browser_snapshot", {}),
      toolCall("browser_snapshot", {}),
      reached("sign-up"),
      reached("invoice"),
      finish,
    ]);
    await run(model).promise;
    const last = JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
    expect(last).toContain("signup form is at /join");
    expect(last).toContain("sign-up: reached");
    expect(last).toContain("browser_snapshot result elided");
    expect(last.split("x".repeat(6000)).length - 1).toBe(1);
  });

  test("tells the persona who they are, where to go and which goals to try", async () => {
    const model = scriptedModel([reached("sign-up"), reached("invoice"), finish]);
    await run(model).promise;
    const system = JSON.stringify(model.doGenerateCalls[0]!.prompt[0]);
    expect(system).toContain("You are Kwame. Impatient.");
    expect(system).toContain("https://acme.test");
    expect(system).toContain("[sign-up] Create an account.");
    expect(system).toContain('account \\"solo\\"');
  });
});
