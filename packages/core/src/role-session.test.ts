import { APICallError, tool } from "ai";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { JOB_STOPPED, ProjectConfigSchema, RunEventSchema, type RunEventInput } from "@usetrawler/protocol";
import { Budget } from "./llm.ts";
import { sessionStatus } from "./prompts.ts";
import { runRoleSession } from "./role-session.ts";
import { SecretScrubber } from "./secrets.ts";
import { proxyRefusal, scriptedModel, text, toolCall } from "./testing.ts";

const project = ProjectConfigSchema.parse({
  name: "Acme",
  targetUrl: "https://acme.test",
  description: "Invoices.",
  personas: [{ id: "solo", name: "Kwame", brief: "Impatient.", accountRef: "solo" }],
  goals: [{ id: "sign-up", instruction: "Create an account." }, { id: "invoice", instruction: "Send an invoice." }],
  accounts: [{ ref: "solo", username: "k@acme.test", password: "hunter22-secret" }, { ref: "admin", username: "root@acme.test", password: "admin-pass-9" }],
});
const snapshot = '- textbox "Password" [ref=e4]\n' + "x".repeat(6000);
const browserTools = {
  browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => ({ content: [{ type: "text", text: snapshot }] }) }),
};
const reached = (goal: string) => toolCall("goal_status", { goal, status: "reached", note: "" });
const finish = toolCall("finish", { summary: "done" });
const look = toolCall("browser_snapshot", {});

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
    expect(events.filter((e) => e.type === "step").map((e) => (e as { step: number }).step)).toEqual([1, 2, 3, 4, 5]);
    events.forEach((e, i) => expect(() => RunEventSchema.parse({ ...e, seq: i + 1, at: "2026-09-24T10:00:00.000Z" })).not.toThrow());
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
      look,
      toolCall("submit_finding", { kind: "friction", goal: "invoice", title: "lost", observed: "could not find it", reproduction: ["a"], severity: "low" }),
      ...Array.from({ length: 10 }, () => toolCall("browser_snapshot", {})),
    ]);
    const { result, usage } = await run(model, { maxSteps: 3 }).promise;
    expect(result.stoppedBy).toBe("max_steps");
    expect(usage.steps).toBe(3);
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

  test("several tool calls in one step all run before the stop check", async () => {
    const model = scriptedModel([[reached("sign-up"), reached("invoice"), finish]]);
    const { result, usage } = await run(model).promise;
    expect(result.stoppedBy).toBe("finish");
    expect(usage.steps).toBe(1);
  });

  test("a plain-text reply is answered with a nudge and the session goes on", async () => {
    const model = scriptedModel([text("I will open the page now."), reached("sign-up"), reached("invoice"), finish]);
    const { result, usage } = await run(model).promise;
    expect(result.stoppedBy).toBe("finish");
    expect(usage.steps).toBe(4);
    const users = model.doGenerateCalls[1]!.prompt.filter((m) => m.role === "user");
    expect(JSON.stringify(users.at(-1))).toContain("Continue with the goals, and call finish once every goal has a status.");
  });

  test("after a nudge the model still sees everything it did before", async () => {
    const model = scriptedModel([toolCall("note", { text: "signup is at /join" }), toolCall("browser_snapshot", {}), text("thinking"), reached("sign-up"), reached("invoice"), finish]);
    await run(model).promise;
    const afterNudge = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(afterNudge).toContain('"toolName":"note"');
    expect(afterNudge).toContain('"toolName":"browser_snapshot"');
  });

  test("stray text replies between real work do not add up to a stop", async () => {
    const model = scriptedModel([
      text("a"), toolCall("browser_snapshot", {}),
      text("b"), toolCall("browser_snapshot", {}),
      text("c"), reached("sign-up"), reached("invoice"), finish,
    ]);
    const { result } = await run(model).promise;
    expect(result.stoppedBy).toBe("finish");
  });

  test("a reply cut off mid tool call is answered and the session goes on", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    const step = (parts: unknown[], finish: "length" | "tool-calls") => ({ content: parts, finishReason: { unified: finish, raw: undefined }, usage, warnings: [] });
    const call = (id: string, name: string, input: unknown) => ({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) });
    const responses = [
      step([call("c1", "browser_snapshot", {})], "length"),
      step([call("c2", "goal_status", { goal: "sign-up", status: "reached", note: "" })], "tool-calls"),
      step([call("c3", "goal_status", { goal: "invoice", status: "reached", note: "" })], "tool-calls"),
      step([call("c4", "finish", { summary: "x" })], "tool-calls"),
    ];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => responses[i++] as never });
    const { result } = await run(model as never).promise;
    expect(result.stoppedBy).toBe("finish");
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("Your reply was cut off before this tool ran");
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).not.toContain("Continue with the goals");
  });

  test("a cut-off reply mixing a whole call with a truncated one is answered too", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    const step = (parts: unknown[], finish: "length" | "tool-calls") => ({ content: parts, finishReason: { unified: finish, raw: undefined }, usage, warnings: [] });
    const responses = [
      step([{ type: "tool-call", toolCallId: "a", toolName: "browser_snapshot", input: "{}" }, { type: "tool-call", toolCallId: "b", toolName: "note", input: '{"text":"half' }], "length"),
      step([{ type: "tool-call", toolCallId: "c", toolName: "goal_status", input: JSON.stringify({ goal: "sign-up", status: "reached", note: "" }) }], "tool-calls"),
      step([{ type: "tool-call", toolCallId: "d", toolName: "goal_status", input: JSON.stringify({ goal: "invoice", status: "reached", note: "" }) }], "tool-calls"),
      step([{ type: "tool-call", toolCallId: "e", toolName: "finish", input: JSON.stringify({ summary: "x" }) }], "tool-calls"),
    ];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => responses[i++] as never });
    const { result } = await run(model as never).promise;
    expect(result.stoppedBy).toBe("finish");
    const ids = model.doGenerateCalls[1]!.prompt.flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result").map((p) => p.toolCallId) : []));
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  test("cut-offs and text replies spread between real work do not add up to a stop", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    let n = 0;
    const call = (name: string, input: unknown, finish: "tool-calls" | "length" = "tool-calls") => ({ content: [{ type: "tool-call", toolCallId: `k${n++}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: finish, raw: undefined }, usage, warnings: [] });
    const say = (t: string) => ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] });
    const snap = () => call("browser_snapshot", {});
    const cut = () => call("browser_snapshot", {}, "length");
    const responses = [say("a"), say("b"), snap(), snap(), cut(), say("c"), snap(), cut(), snap(), snap(), cut(), snap(), cut(),
      call("goal_status", { goal: "sign-up", status: "reached", note: "" }), call("goal_status", { goal: "invoice", status: "reached", note: "" }), call("finish", { summary: "x" })];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => responses[i++] as never });
    const { result } = await run(model as never, { maxSteps: 40 }).promise;
    expect(result.stoppedBy).toBe("finish");
  });

  test("single truncated calls cut off again and again end the session with a reason", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "tool-call", toolCallId: `t${i++}`, toolName: "note", input: '{"text":"hal' }], finishReason: { unified: "length", raw: undefined }, usage, warnings: [] }) as never });
    const { result, usage: used } = await run(model as never).promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the model's replies were cut off 3 times in a row" });
    expect(used.steps).toBe(3);
  });

  test("a plain-text reply that was cut off is followed by a note telling the model why", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    const prompts: unknown[][] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        prompts.push(prompt as unknown[]);
        return { content: [{ type: "text", text: "I will now" }], finishReason: { unified: "length", raw: undefined }, usage, warnings: [] } as never;
      },
    });
    const { result } = await run(model as never).promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the model's replies were cut off 3 times in a row" });
    const lastOfSecond = prompts[1]!.at(-1) as { role: string; content: Array<{ text?: string }> };
    expect(lastOfSecond.role).toBe("user");
    expect(JSON.stringify(lastOfSecond.content)).toMatch(/cut off/);
  });

  test("a plain-text reply between cut-offs does not reset their count", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    let i = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (i++ % 2 === 0
          ? { content: [{ type: "tool-call", toolCallId: `z${i}`, toolName: "note", input: '{"text":"ha' }], finishReason: { unified: "length", raw: undefined }, usage, warnings: [] }
          : { content: [{ type: "text", text: "thinking" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }) as never,
    });
    const { result, usage: used } = await run(model as never).promise;
    expect(result).toMatchObject({ stoppedBy: "error" });
    expect(used.steps).toBeLessThanOrEqual(5);
  });

  test("replies that keep getting cut off end the session with a reason", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "tool-call", toolCallId: `x${i++}`, toolName: "browser_snapshot", input: "{}" }], finishReason: { unified: "length", raw: undefined }, usage, warnings: [] }) as never });
    const { result, usage: used } = await run(model as never).promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the model's replies were cut off 3 times in a row" });
    expect(used.steps).toBe(3);
  });

  test("a model that keeps answering in plain text ends the session with a reason", async () => {
    const model = scriptedModel([text("a"), text("b"), text("c"), text("d")]);
    const { promise, events } = run(model);
    const { result, usage } = await promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the model stopped calling tools 3 turns in a row" });
    expect(usage.steps).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: "job_finished", stoppedBy: "error", error: "the model stopped calling tools 3 turns in a row" });
  });

  test("does not spend anything when the shared budget is already exceeded", async () => {
    const budget = new Budget(0.1);
    budget.add(0.2);
    const model = scriptedModel([reached("sign-up")]);
    const { result, usage } = await run(model, { budget }).promise;
    expect(result.stoppedBy).toBe("budget");
    expect(usage.steps).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a browser that keeps failing ends the session instead of burning steps", async () => {
    const dead = { browser_snapshot: tool({ inputSchema: z.object({}), execute: async (): Promise<string> => { throw new Error("Target closed"); } }) };
    const model = scriptedModel(Array.from({ length: 10 }, () => toolCall("browser_snapshot", {})));
    const { result, usage } = await run(model, { browserTools: dead }).promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the browser failed 3 times in a row; last error: Target closed" });
    expect(usage.steps).toBe(3);
  });

  test("a browser that recovers resets the crash count", async () => {
    let calls = 0;
    const flaky = { browser_snapshot: tool({ inputSchema: z.object({}), execute: async (): Promise<string> => { calls++; if (calls % 3 === 0) return "ok"; throw new Error("Target closed"); } }) };
    const model = scriptedModel([...Array.from({ length: 6 }, () => toolCall("browser_snapshot", {})), reached("sign-up"), reached("invoice"), finish]);
    const { result } = await run(model, { browserTools: flaky }).promise;
    expect(result.stoppedBy).toBe("finish");
  });

  test("browser calls in one step never overlap, sign_in included", async () => {
    const log: string[] = [];
    const slow = (name: string) => tool({ inputSchema: z.object({}), execute: async () => { log.push(`${name}-start`); await new Promise((r) => setTimeout(r, 20)); log.push(`${name}-end`); return "ok"; } });
    const model = scriptedModel([[toolCall("browser_click", {}), toolCall("browser_hover", {}), toolCall("sign_in", { account: "solo", usernameField: "e3", passwordField: "e4" })], reached("sign-up"), reached("invoice"), finish]);
    const fillField = async (_ref: string, _text: string, kind: string) => { log.push(`fill-${kind}-start`); await new Promise((r) => setTimeout(r, 20)); log.push(`fill-${kind}-end`); return "typed"; };
    await run(model, { browserTools: { browser_click: slow("click"), browser_hover: slow("hover") }, fillField }).promise;
    for (let i = 0; i < log.length; i += 2) expect(log[i + 1]).toBe(log[i]!.replace("-start", "-end"));
  });

  test("results over 1500 characters are elided once a newer one arrives", async () => {
    const medium = { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => ({ content: [{ type: "text", text: "m".repeat(2000) }] }) }) };
    const model = scriptedModel([toolCall("browser_snapshot", {}), toolCall("browser_snapshot", {}), reached("sign-up"), reached("invoice"), finish]);
    await run(model, { browserTools: medium }).promise;
    const last = JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
    expect(last.split("m".repeat(2000)).length - 1).toBe(1);
  });

  test("a failing event sink stops the session with that error", async () => {
    let n = 0;
    const model = scriptedModel([toolCall("browser_snapshot", {}), toolCall("browser_snapshot", {}), toolCall("browser_snapshot", {})]);
    const { result } = await run(model, { emit: (e) => { if (e.type === "step" && ++n === 1) throw new Error("sink down"); } }).promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "sink down" });
  });

  test("a sink that fails at the very end still returns the findings", async () => {
    const model = scriptedModel([look,toolCall("submit_finding", { kind: "friction", goal: "invoice", title: "lost", observed: "could not find it", reproduction: ["a"], severity: "low" }), reached("sign-up"), reached("invoice"), finish]);
    const { result } = await run(model, { emit: (e) => { if (e.type === "job_finished") throw new Error("sink down"); } }).promise;
    expect(result.findings).toHaveLength(1);
    expect(result.stoppedBy).toBe("error");
  });

  test("a persona can only sign in with its own account", async () => {
    const model = scriptedModel([toolCall("sign_in", { account: "admin", usernameField: "e3", passwordField: "e4" }), reached("sign-up"), reached("invoice"), finish]);
    await run(model).promise;
    const second = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(second).toContain("rejected: unknown account admin; known: solo");
    expect(second).not.toContain("admin-pass-9");
  });

  test("rejects a maxSteps that could never stop", async () => {
    await expect(run(scriptedModel([]), { maxSteps: 0 }).promise).rejects.toThrow(RangeError);
  });

  test("a model error ends the session but keeps what was recorded", async () => {
    const model = scriptedModel([look,toolCall("submit_finding", { kind: "friction", goal: "invoice", title: "lost", observed: "could not find it", reproduction: ["a"], severity: "low" })]);
    const { promise, events } = run(model);
    const { result } = await promise;
    expect(result.stoppedBy).toBe("error");
    expect(result.error).toMatch(/scriptedModel has only 2 responses/);
    expect(result.findings).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "job_finished", stoppedBy: "error", error: expect.stringMatching(/scriptedModel/) });
  });

  test("a model call the proxy refuses for the key ends the session with the proxy's reason", async () => {
    const model = scriptedModel([look, proxyRefusal("the provider refused the workspace key; an owner or admin can replace it in Settings")]);
    const { promise, events } = run(model);
    const { result, usage } = await promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the provider refused the workspace key; an owner or admin can replace it in Settings" });
    expect(usage.steps).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "job_finished", stoppedBy: "error", error: "the provider refused the workspace key; an owner or admin can replace it in Settings" });
  });

  test("a model call the proxy refuses because the run stopped the job ends the session as stopped by the budget", async () => {
    const model = scriptedModel([look, proxyRefusal("the run is no longer active", JOB_STOPPED)]);
    const { promise, events } = run(model);
    const { result } = await promise;
    expect(result.stoppedBy).toBe("budget");
    expect(result.error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "job_finished", stoppedBy: "budget" });
  });

  test("a Stop that answers a retried model call still ends the session as stopped by the budget", async () => {
    const busy = new APICallError({ message: "one model call at a time per job", url: "https://cp.test/api/llm/v1/chat/completions", requestBodyValues: {}, statusCode: 429, responseHeaders: { "retry-after-ms": "1" } });
    const model = scriptedModel([look, busy, proxyRefusal("the run is no longer active", JOB_STOPPED)]);
    const { result } = await run(model).promise;
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(result.stoppedBy).toBe("budget");
    expect(result.error).toBeUndefined();
  });

  test("a key refused on a retried model call ends the session with the proxy's reason, not the retry's wording", async () => {
    const busy = new APICallError({ message: "one model call at a time per job", url: "https://cp.test/api/llm/v1/chat/completions", requestBodyValues: {}, statusCode: 429, responseHeaders: { "retry-after-ms": "1" } });
    const model = scriptedModel([look, busy, proxyRefusal("the provider refused the workspace key; an owner or admin can replace it in Settings")]);
    const { result } = await run(model).promise;
    expect(result).toMatchObject({ stoppedBy: "error", error: "the provider refused the workspace key; an owner or admin can replace it in Settings" });
  });

  test("a person without an account is told to sign up with an example.com address and type_own_password, and never sees the password, even when the page shows it", async () => {
    const typed: Array<[string, string, string]> = [];
    const echoing = { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => ({ content: [{ type: "text", text: `- textbox "Password" [ref=e4]\nWelcome! Your password is ${typed[0]?.[1] ?? "not set"}` }] }) }) };
    const model = scriptedModel([look, toolCall("type_own_password", { fields: ["e4", "e5"] }), look, look]);
    await run(model, {
      persona: { id: "ama", name: "Ama", brief: "Brand new." },
      browserTools: echoing,
      fillField: async (ref, text, kind) => (typed.push([ref, text, kind]), `fill('${text}') into ${ref}`),
    }).promise;
    const password = typed[0]![1];
    expect(typed).toEqual([["e4", password, "password"], ["e5", password, "password"]]);
    expect(model.doGenerateCalls[0]!.tools!.map((t) => t.name)).toContain("type_own_password");
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt[0])).toMatch(/You have no account\. If the product lets people sign up, sign up the way a new user would, with the email address ama\.[0-9a-f]{8}@example\.com: it is yours, and no mail sent to it arrives\. If the product refuses that address or asks you to confirm it by email, that is a limit of the address, not a defect: note it and move on\. Fill password fields only with type_own_password: it types a password made up for you, the same one all session, so use it again to sign in to the account you created\. You will never see it\./);
    const later = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(later).toContain("fill('•••') into e4");
    expect(later).toContain("Welcome! Your password is •••");
    expect(JSON.stringify(model.doGenerateCalls.map((c) => c.prompt))).not.toContain(password);
  });

  test("a person with an account is told to sign in with it and is not offered a made-up password", async () => {
    const model = scriptedModel([look]);
    await run(model).promise;
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt[0])).toContain('You have an account \\"solo\\". To sign in');
    expect(model.doGenerateCalls[0]!.tools!.map((t) => t.name)).not.toContain("type_own_password");
  });

  test("a password typed into several fields is one browser action: nothing else from the same reply runs between the fields", async () => {
    const log: string[] = [];
    const click = tool({ inputSchema: z.object({}), execute: async () => (log.push("click"), "clicked") });
    const slowFill = async (ref: string) => (await new Promise((r) => setTimeout(r, 10)), log.push(`fill ${ref}`), "typed");
    const model = scriptedModel([look, [toolCall("type_own_password", { fields: ["e4", "e5"] }), toolCall("browser_click", {})]]);
    await run(model, { persona: { id: "ama", name: "Ama", brief: "Brand new." }, browserTools: { ...browserTools, browser_click: click }, fillField: slowFill }).promise;
    expect(log).toEqual(["fill e4", "fill e5", "click"]);
  });

  test("signing in is one browser action too: a click in the same reply waits for both fields", async () => {
    const log: string[] = [];
    const click = tool({ inputSchema: z.object({}), execute: async () => (log.push("click"), "clicked") });
    const slowFill = async (ref: string) => (await new Promise((r) => setTimeout(r, 10)), log.push(`fill ${ref}`), "typed");
    const model = scriptedModel([look, [toolCall("sign_in", { account: "solo", usernameField: "e3", passwordField: "e4" }), toolCall("browser_click", {})]]);
    await run(model, { browserTools: { ...browserTools, browser_click: click }, fillField: slowFill }).promise;
    expect(log).toEqual(["fill e3", "fill e4", "click"]);
  });

  test("the returned result is scrubbed too", async () => {
    const model = scriptedModel([
      look,
      toolCall("submit_finding", { kind: "friction", goal: "invoice", title: "pw hunter22-secret", observed: "saw hunter22-secret", reproduction: ["typed hunter22-secret"], severity: "low" }),
      toolCall("goal_status", { goal: "sign-up", status: "reached", note: "used hunter22-secret" }),
      reached("invoice"),
      finish,
    ]);
    const { result } = await run(model).promise;
    expect(JSON.stringify(result)).not.toContain("hunter22-secret");
    expect(result.findings[0]!.title).toBe("pw •••");
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
    expect(last).toContain("Step 6 of 20.");
    expect(last).toContain("browser_snapshot result elided");
    expect(last.split("x".repeat(6000)).length - 1).toBe(1);
  });

  test("warns the persona when the steps are running out", async () => {
    const model = scriptedModel(Array.from({ length: 10 }, () => toolCall("browser_snapshot", {})));
    await run(model, { maxSteps: 10 }).promise;
    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt[0]));
    expect(prompts[5]).not.toMatch(/steps left/);
    expect(prompts[7]).toContain("Only 3 steps left: give every open goal a status now (reached or failed) and call finish.");
    expect(prompts[9]).toContain("Only 1 step left");
  });

  test("the step warning leaves room for every open goal and scales with long sessions", async () => {
    expect(sessionStatus([], [{ goal: "a", status: "not_attempted", note: "" }, { goal: "b", status: "not_attempted", note: "" }, { goal: "c", status: "not_attempted", note: "" }, { goal: "d", status: "reached", note: "" }], 16, 20)).toMatch(/Only 4 steps left/);
    expect(sessionStatus([], [], 107, 120)).not.toMatch(/steps left/);
    expect(sessionStatus([], [], 108, 120)).toMatch(/Only 12 steps left/);
  });

  test("tells the persona who they are, where to go and which goals to try", async () => {
    const model = scriptedModel([reached("sign-up"), reached("invoice"), finish]);
    await run(model).promise;
    const system = JSON.stringify(model.doGenerateCalls[0]!.prompt[0]);
    expect(system).toContain("You are Kwame. Impatient.");
    expect(system).toContain("https://acme.test");
    expect(system).toContain("[sign-up] Create an account.");
    expect(system).toContain('account \\"solo\\"');
    expect(system).toContain("as target");
  });
});
