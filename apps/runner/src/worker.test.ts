import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import { PROTOCOL_HEADER } from "@usetrawler/protocol";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { workLoop, workOnce, type LogFields, type WorkerDeps } from "./worker.ts";

const token = "job-token-" + "x".repeat(40);
const config = {
  name: "Acme", targetUrl: "https://a.test/", description: "", allowedOrigins: ["https://a.test"],
  personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "x" }],
  accounts: [], extraHeaders: {}, secretHeaders: {},
};
const baseJob = { jobId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", token, config, maxSteps: 10, budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge" };

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function fakeControlPlane(job: unknown, opts: { cancelAfter?: number; failEvents?: number; eventsStatus?: number; eventsBody?: string; completeStatus?: number; completeBody?: string } = {}) {
  const seen = { claims: 0, events: [] as Array<{ seq: number; type: string }>, completions: [] as unknown[], releases: 0, headers: [] as Array<string | undefined>, auth: [] as Array<string | undefined> };
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
      if (failures-- > 0) { res.statusCode = opts.eventsStatus ?? 503; return res.end(opts.eventsBody ?? "{}"); }
      batches++;
      seen.events.push(...body.events);
      return res.end(JSON.stringify({ cancel: opts.cancelAfter !== undefined && batches >= opts.cancelAfter }));
    }
    if (req.url?.endsWith("/release")) {
      seen.releases++;
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url?.endsWith("/complete")) {
      seen.completions.push(body);
      if (opts.completeStatus) { res.statusCode = opts.completeStatus; return res.end(opts.completeBody ?? "{}"); }
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

test("a judge that gives no verdict completes as an error and reports no verdict", async () => {
  const finding = { id: "ana:f1", kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" };
  const judged = await fakeControlPlane({ ...baseJob, kind: "judge", finding, observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });
  await workOnce(deps(judged.url, scriptedModel([text("not sure"), text("still not sure")])));
  expect(judged.seen.events.map((e) => e.type)).toEqual(["job_started", "job_finished"]);
  expect(judged.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: "the model gave no verdict (2 tries)" })]);
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
    const lines: Array<[string, LogFields | undefined]> = [];
    const reports: string[] = [];
    expect(await workOnce(deps(url, endless(), { attempts: 2, log: (l, f) => lines.push([l, f]), report: (m) => void reports.push(m) }))).toBe("done");
    expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: expect.stringMatching(/could not report events/) })]);
    expect((seen.completions[0] as { usage: { steps: number } }).usage.steps).toBeLessThan(40);
    expect(lines.find(([l]) => l.includes("could not report events"))?.[1]?.level).toBe("error");
    expect(reports).toEqual([expect.stringMatching(/finished \(error\): the runner could not report events/)]);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

test("events refused with an answer that echoes the job's secrets are logged and reported masked", async () => {
  const withPassword = { ...config, accounts: [{ ref: "account-1", username: "ana@a.test", password: "correct-horse-battery" }] };
  const { url } = await fakeControlPlane({ ...baseJob, config: withPassword, kind: "role_session", personaKey: "ana", accountRef: "account-1" }, {
    failEvents: 1000, eventsStatus: 400, eventsBody: `{"error":"refused correct-horse-battery for ${token}"}`,
  });
  const lines: string[] = [];
  const reports: string[] = [];
  await workOnce(deps(url, endless(), { attempts: 1, log: (l) => void lines.push(l), report: (m) => void reports.push(m) }));
  expect(lines.find((l) => l.includes("could not report events"))).toContain('HTTP 400 {"error":"refused ••• for •••"}');
  expect(JSON.stringify([lines, reports])).not.toContain("correct-horse-battery");
  expect(JSON.stringify([lines, reports])).not.toContain(token);
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
  const reports: Array<[string, LogFields]> = [];
  expect(await workOnce(deps(url, scriptedModel([]), { report: (m, f) => void reports.push([m, f]) }))).toBe("done");
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: expect.stringMatching(/cannot read the job/) })]);
  expect(reports).toEqual([[expect.stringMatching(/cannot read the job/), { jobId: baseJob.jobId }]]);
});

test("stopping the runner abandons a claim that is still waiting", async () => {
  const stop = new AbortController();
  const hanging: typeof fetch = (_url, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  const pending = workOnce(deps("http://127.0.0.1:1", scriptedModel([]), { fetch: hanging }), stop.signal);
  stop.abort();
  expect(await pending).toBe("idle");
});

test("a runner told to stop mid-session hands the job back instead of failing it", async () => {
  const { url, seen } = await fakeControlPlane(role);
  const slow = endless();
  const original = slow.doGenerate.bind(slow);
  slow.doGenerate = async (o) => { await new Promise((r) => setTimeout(r, 30)); return original(o); };
  const stop = new AbortController();
  const lines: Array<[string, LogFields | undefined]> = [];
  const reports: string[] = [];
  const pending = workOnce(deps(url, slow, { log: (l, f) => lines.push([l, f]), report: (m) => void reports.push(m) }), stop.signal);
  await new Promise((r) => setTimeout(r, 150));
  stop.abort();
  expect(await pending).toBe("done");
  expect(seen.releases).toBe(1);
  expect(seen.completions).toEqual([]);
  expect(lines.find(([l]) => l.includes("handed back to the queue"))?.[1]?.level).toBe("info");
  expect(reports).toEqual([]);
});

test("a failed job is reported and logged as an error with its ids, without the job's secrets", async () => {
  const withPassword = { ...config, accounts: [{ ref: "account-1", username: "ana@a.test", password: "correct-horse-battery" }] };
  const { url } = await fakeControlPlane({ ...baseJob, config: withPassword, kind: "role_session", personaKey: "ana", accountRef: "account-1" });
  const reports: Array<[string, LogFields]> = [];
  const logs: Array<[string, LogFields | undefined]> = [];
  await workOnce(deps(url, scriptedModel([]), {
    openBrowser: async () => { throw new Error(`no chromium for correct-horse-battery with ${token}`); },
    report: (message, fields) => void reports.push([message, fields]),
    log: (line, fields) => void logs.push([line, fields]),
  }));
  const ids = { jobId: baseJob.jobId, runId: baseJob.runId, kind: "role_session" };
  expect(reports).toEqual([[expect.stringContaining("no chromium for ••• with •••"), expect.objectContaining(ids)]]);
  const finished = logs.find(([line]) => line.includes("finished"))!;
  expect(finished[1]).toEqual({ ...ids, level: "error" });
  expect(JSON.stringify([reports, logs])).not.toContain("correct-horse-battery");
  expect(JSON.stringify([reports, logs])).not.toContain(token);
});

test("before the browser opens, reporting gets the job's scrubber, so what it catches by itself is masked too", async () => {
  const withPassword = { ...config, accounts: [{ ref: "account-1", username: "ana@a.test", password: "correct-horse-battery" }] };
  const { url } = await fakeControlPlane({ ...baseJob, config: withPassword, kind: "role_session", personaKey: "ana", accountRef: "account-1" });
  const seen: string[] = [];
  await workOnce(deps(url, scriptedModel([]), {
    maskReportsWith: (scrubber) => void seen.push(scrubber.scrub(`correct-horse-battery ${token}`)),
    openBrowser: async () => { seen.push("browser opened"); throw new Error("no chromium"); },
  }));
  expect(seen).toEqual(["••• •••", "browser opened"]);
});

test("a job that finishes normally is logged with its ids and not reported", async () => {
  const { url } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  const reports: string[] = [];
  const logs: Array<[string, LogFields | undefined]> = [];
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  await workOnce(deps(url, model, { report: (m) => void reports.push(m), log: (line, fields) => void logs.push([line, fields]) }));
  expect(reports).toEqual([]);
  expect(logs.map(([, fields]) => fields)).toEqual([
    { jobId: baseJob.jobId, runId: baseJob.runId, kind: "role_session", level: "info" },
    { jobId: baseJob.jobId, runId: baseJob.runId, kind: "role_session", level: "info" },
  ]);
});

test("a control plane that keeps failing claims is reported once, and again after it recovered and failed anew", async () => {
  const statuses = [503, 502, 503, 204, 502, 503];
  let claims = 0;
  server = createServer((req, res) => {
    const status = statuses[claims++] ?? 204;
    res.statusCode = status;
    res.end(status === 204 ? undefined : "{}");
  });
  const url = await new Promise<string>((resolve) => server!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`)));
  const reports: string[] = [];
  const stop = new AbortController();
  const looping = workLoop(deps(url, scriptedModel([]), { attempts: 1, claimRetryMs: 1, report: (m) => void reports.push(m) }), stop.signal);
  while (claims < statuses.length + 1) await new Promise((r) => setTimeout(r, 5));
  stop.abort();
  await looping;
  expect(reports).toEqual(["claim failed: HTTP 503 from /api/runner/claim", "claim failed: HTTP 502 from /api/runner/claim"]);
});

test("a completion the control plane refuses is reported, masking the job's secrets its answer echoes", async () => {
  const withPassword = { ...config, accounts: [{ ref: "account-1", username: "ana@a.test", password: "correct-horse-battery" }] };
  const { url } = await fakeControlPlane({ ...baseJob, config: withPassword, kind: "role_session", personaKey: "ana", accountRef: "account-1" }, {
    completeStatus: 400, completeBody: `{"error":"refused correct-horse-battery for ${token}"}`,
  });
  const reports: string[] = [];
  const logs: string[] = [];
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  await workOnce(deps(url, model, { report: (m) => void reports.push(m), log: (l) => void logs.push(l) }));
  expect(reports).toEqual([expect.stringContaining('could not report back: the control plane rejected the completion: HTTP 400 {"error":"refused ••• for •••"}')]);
  expect(JSON.stringify([reports, logs])).not.toContain("correct-horse-battery");
  expect(JSON.stringify([reports, logs])).not.toContain(token);
});

test("a claim failure is logged as an error and reported without the runner token", async () => {
  const runnerToken = "runner-" + "r".repeat(40);
  const reports: string[] = [];
  const logs: Array<[string, LogFields | undefined]> = [];
  const stop = new AbortController();
  const failing = (async () => { throw new Error(`connection refused while sending ${runnerToken}`); }) as unknown as typeof fetch;
  const looping = workLoop(deps("http://127.0.0.1:1", scriptedModel([]), {
    fetch: failing, attempts: 1, claimRetryMs: 1, report: (m) => { reports.push(m); stop.abort(); }, log: (l, f) => void logs.push([l, f]),
  }), stop.signal);
  await looping;
  expect(reports).toEqual(["claim failed: connection refused while sending •••"]);
  expect(logs[0]).toEqual(["claim failed: connection refused while sending •••", { level: "error" }]);
});
