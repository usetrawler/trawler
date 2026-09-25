import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import { PROTOCOL_HEADER } from "@usetrawler/protocol";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { workOnce, type WorkerDeps } from "./worker.ts";

const token = "job-token-" + "x".repeat(40);
const config = {
  name: "Acme", targetUrl: "https://a.test/", description: "", allowedOrigins: ["https://a.test"],
  personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "x" }],
  accounts: [], extraHeaders: {}, secretHeaders: {},
};
const baseJob = { jobId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", token, config, maxSteps: 10, budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge" };

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function fakeControlPlane(job: unknown, opts: { cancelAfter?: number; failEvents?: number; eventsStatus?: number; completeStatus?: number } = {}) {
  const seen = { claims: 0, events: [] as Array<{ seq: number; type: string }>, completions: [] as unknown[], headers: [] as Array<string | undefined>, auth: [] as Array<string | undefined> };
  let batches = 0;
  let failures = opts.failEvents ?? 0;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.headers.push(req.headers[PROTOCOL_HEADER] as string | undefined);
    seen.auth.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/runner/claim") {
      seen.claims++;
      if (seen.claims > 1 || !job) { res.statusCode = 204; return res.end(); }
      return res.end(JSON.stringify(job));
    }
    if (req.url?.endsWith("/events")) {
      if (failures-- > 0) { res.statusCode = opts.eventsStatus ?? 503; return res.end("{}"); }
      batches++;
      seen.events.push(...body.events);
      return res.end(JSON.stringify({ cancel: opts.cancelAfter !== undefined && batches >= opts.cancelAfter }));
    }
    if (req.url?.endsWith("/complete")) {
      seen.completions.push(body);
      if (opts.completeStatus) { res.statusCode = opts.completeStatus; return res.end("{}"); }
      return res.end(JSON.stringify({ ok: true }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise<{ url: string; seen: typeof seen }>((resolve) => server!.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, seen })));
}

const browser = async () => ({ tools: {}, fillField: async () => "typed", close: async () => {} });

function deps(url: string, model: ReturnType<typeof scriptedModel>, over: Partial<WorkerDeps> = {}): WorkerDeps {
  return { controlPlane: url, runnerToken: "runner-" + "r".repeat(40), model: () => model, openBrowser: browser, log: () => {}, flushMs: 20, retryBaseMs: 10, ...over };
}

test("with nothing to do, a claim comes back idle", async () => {
  const { url, seen } = await fakeControlPlane(null);
  expect(await workOnce(deps(url, scriptedModel([])))).toBe("idle");
  expect(seen.headers[0]).toBe("1");
  expect(seen.auth[0]).toBe("Bearer runner-" + "r".repeat(40));
});

test("a role session runs, streams numbered events with the job token and completes", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  expect(await workOnce(deps(url, model))).toBe("done");
  expect(seen.events.map((e) => e.seq)).toEqual(seen.events.map((_, i) => i + 1));
  expect(new Set(seen.events.map((e) => (e as unknown as { jobId: string }).jobId))).toEqual(new Set([baseJob.jobId]));
  const types = seen.events.map((e) => e.type);
  expect(types[0]).toBe("job_started");
  expect(types.at(-1)).toBe("job_finished");
  expect(types.filter((t) => t === "step")).toHaveLength(2);
  expect(types).toContain("goal_status");
  expect(seen.auth.filter((a) => a === `Bearer ${token}`).length).toBeGreaterThanOrEqual(2);
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "finish", usage: expect.objectContaining({ steps: 2 }) })]);
});

test("a failing events endpoint is retried and nothing is lost", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { failEvents: 2 });
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  await workOnce(deps(url, model));
  expect(seen.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
});

test("a cancel from the control plane stops the session early", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", maxSteps: 30 }, { cancelAfter: 1 });
  const model = scriptedModel(Array.from({ length: 30 }, () => toolCall("note", { text: "busy" })), 0.001);
  const original = model.doGenerate.bind(model);
  model.doGenerate = async (options) => (await new Promise((r) => setTimeout(r, 30)), original(options));
  await workOnce(deps(url, model, { flushMs: 1 }));
  expect(model.doGenerateCalls.length).toBeLessThan(30);
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "budget" })]);
});

test("a replay reports its observation, a judge its verdict", async () => {
  const finding = { id: "ana:f1", kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" };
  const replay = await fakeControlPlane({ ...baseJob, kind: "replay", finding });
  await workOnce(deps(replay.url, scriptedModel([toolCall("report_replay", { completed: true, observed: "Internal Server Error", blockedAt: null })])));
  expect(replay.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "report", observation: { completed: true, observed: "Internal Server Error", blockedAt: null } })]);
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  const judged = await fakeControlPlane({ ...baseJob, kind: "judge", finding, observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });
  await workOnce(deps(judged.url, scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))])));
  expect(judged.seen.events.find((e) => e.type === "verdict")).toMatchObject({ findingId: "ana:f1", verdict: "confirmed" });
  expect(judged.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "done" })]);
});

test("a browser that will not start completes the job as an error", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  await workOnce(deps(url, scriptedModel([]), { openBrowser: async () => { throw new Error("no chromium"); } }));
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: "no chromium" })]);
});

test("a long quiet job keeps its lease with empty heartbeat batches", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  let beats = 0;
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  const original = model.doGenerate.bind(model);
  model.doGenerate = async (options) => (await new Promise((r) => setTimeout(r, 120)), original(options));
  const counting: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/events") && JSON.parse(String(init?.body)).events.length === 0) beats++;
    return fetch(input, init);
  };
  await workOnce(deps(url, model, { heartbeatMs: 40, fetch: counting }));
  expect(beats).toBeGreaterThan(0);
  expect(seen.completions).toHaveLength(1);
});

const role = { ...baseJob, kind: "role_session", personaKey: "ana" };
const endless = () => scriptedModel(Array.from({ length: 40 }, () => toolCall("note", { text: "still going" })));

test("events the control plane keeps refusing stop the job instead of crashing the runner, and usage is still reported", async () => {
  for (const eventsStatus of [401, 503]) {
    const { url, seen } = await fakeControlPlane(role, { failEvents: 1000, eventsStatus });
    const lines: string[] = [];
    expect(await workOnce(deps(url, endless(), { attempts: 2, log: (l) => lines.push(l) }))).toBe("done");
    expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: expect.stringMatching(/could not report events/) })]);
    expect((seen.completions[0] as { usage: { steps: number } }).usage.steps).toBeLessThan(40);
    expect(lines.some((l) => l.includes("could not report events"))).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

test("a refused completion is logged, not reported as finished", async () => {
  const { url } = await fakeControlPlane(role, { completeStatus: 400 });
  const lines: string[] = [];
  await workOnce(deps(url, scriptedModel([toolCall("finish", { summary: "done" })]), { log: (l) => lines.push(l) }));
  expect(lines.some((l) => l.includes("could not report back") && l.includes("HTTP 400"))).toBe(true);
  expect(lines.some((l) => l.includes("finished"))).toBe(false);
});

test("a very long model error is cut to what the protocol accepts", async () => {
  const { url, seen } = await fakeControlPlane(role);
  const failing = { specificationVersion: "v3", provider: "x", modelId: "x", supportedUrls: {}, doGenerate: async () => { throw new Error("provider said: " + "e".repeat(3000)); }, doStream: async () => { throw new Error("no"); } };
  await workOnce(deps(url, failing as unknown as ReturnType<typeof scriptedModel>, { secrets: ["sk-or-secret-key-123456"] }));
  const completion = seen.completions[0] as { error?: string };
  expect(completion.error!.length).toBeLessThanOrEqual(2000);
  const finished = seen.events.find((e) => e.type === "job_finished") as unknown as { error?: string } | undefined;
  expect((finished?.error ?? "").length).toBeLessThanOrEqual(2000);
});

test("a job this runner cannot read is completed as an error, not left leased", async () => {
  const { url, seen } = await fakeControlPlane({ ...role, kind: "time_travel" });
  expect(await workOnce(deps(url, scriptedModel([])))).toBe("done");
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: expect.stringMatching(/cannot read the job/) })]);
});

test("stopping the runner abandons a claim that is still waiting", async () => {
  const stop = new AbortController();
  const hanging: typeof fetch = (_url, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  const pending = workOnce(deps("http://127.0.0.1:1", scriptedModel([]), { fetch: hanging }), stop.signal);
  stop.abort();
  expect(await pending).toBe("idle");
});
