import { createServer, type Server } from "node:http";
import { tool } from "ai";
import { z } from "zod";
import { afterEach, expect, test, vi } from "vitest";
import { PROTOCOL_HEADER } from "@usetrawler/protocol";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { channelFor, workLoop, workOnce, type LogFields, type WorkerDeps } from "./worker.ts";

const token = "job-token-" + "x".repeat(40);
const config = {
  name: "Acme", targetUrl: "https://a.test/", description: "", allowedOrigins: ["https://a.test"],
  personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "x" }],
  accounts: [], extraHeaders: {}, secretHeaders: {},
};
const baseJob = { jobId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", token, config, maxSteps: 10, budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge" };

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? (server.closeAllConnections(), server.close(() => r())) : r())));

type Upload = { url: string | undefined; auth: string | undefined; type: string | undefined; protocol: string | undefined; bytes: Buffer };

function fakeControlPlane(job: unknown, opts: { cancelAfter?: number; cancelOnFinding?: boolean; failEvents?: number; eventsStatus?: number; eventsBody?: string; completeStatus?: number; completeBody?: string; uploadStatuses?: number[]; uploadsHang?: boolean; uploadDelayMs?: number; uploadResets?: number } = {}) {
  const seen = { claims: 0, events: [] as Array<{ seq: number; type: string }>, completions: [] as unknown[], releases: 0, headers: [] as Array<string | undefined>, auth: [] as Array<string | undefined>, uploads: [] as Upload[], order: [] as string[] };
  let batches = 0;
  let failures = opts.failEvents ?? 0;
  const uploadStatuses = [...(opts.uploadStatuses ?? [])];
  let resets = opts.uploadResets ?? 0;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.order.push(req.url?.split("?")[0]?.split("/").at(-1) ?? "");
    if (req.url?.includes("/artifacts?")) {
      seen.uploads.push({ url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], protocol: req.headers[PROTOCOL_HEADER] as string | undefined, bytes: Buffer.concat(chunks) });
      if (opts.uploadsHang) return void res.on("close", () => seen.order.push("upload dropped"));
      if (resets-- > 0) return void req.socket.destroy();
      if (opts.uploadDelayMs) await new Promise((r) => setTimeout(r, opts.uploadDelayMs));
      seen.order.push("artifacts answered");
      res.setHeader("content-type", "application/json");
      res.statusCode = uploadStatuses.shift() ?? 201;
      return res.end(res.statusCode === 201 ? JSON.stringify({ id: "33333333-3333-4333-8333-333333333333" }) : JSON.stringify({ error: "nope" }));
    }
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
      return res.end(JSON.stringify({ cancel: (opts.cancelAfter !== undefined && batches >= opts.cancelAfter) || (!!opts.cancelOnFinding && seen.events.some((e) => e.type === "finding")) }));
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

const browser = async () => ({ tools: {}, fillField: async () => "typed", screenshot: async () => null, pageUrl: () => null, close: async () => {} });

function deps(url: string, model: ReturnType<typeof scriptedModel>, over: Partial<WorkerDeps> = {}): WorkerDeps {
  return { controlPlane: url, runnerToken: "runner-" + "r".repeat(40), model: () => model, openBrowser: browser, log: () => {}, flushMs: 20, retryBaseMs: 10, ...over };
}

const shot = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), contentType: "image/png" as const };
const shooting = async () => ({ tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => "the page" }) }, fillField: async () => "typed", screenshot: async () => shot, pageUrl: () => null, close: async () => {} });
const reportsDefect = () => scriptedModel([
  toolCall("browser_snapshot", {}),
  toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" }),
  toolCall("goal_status", { goal: "g", status: "failed", note: "500" }),
  toolCall("finish", { summary: "done" }),
]);

test("a finding's screenshot is uploaded with the job token, as the image it is, before the job completes", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadDelayMs: 300 });
  await workOnce(deps(url, reportsDefect(), { openBrowser: shooting }));
  expect(seen.uploads).toEqual([{ url: `/api/jobs/${baseJob.jobId}/artifacts?kind=screenshot&finding=f1`, auth: `Bearer ${token}`, type: "image/png", protocol: "8", bytes: Buffer.from(shot.bytes) }]);
  expect(seen.order.slice(0, seen.order.indexOf("complete"))).toContain("artifacts answered");
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "finish" })]);
});

test("a replay uploads a screenshot of where it ended", async () => {
  const finding = { id: "ana:f1", kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" };
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "replay", finding }, { uploadDelayMs: 300 });
  await workOnce(deps(url, scriptedModel([toolCall("report_replay", { completed: true, observed: "Internal Server Error", blockedAt: null })]), { openBrowser: shooting }));
  expect(seen.uploads.map((u) => u.url)).toEqual([`/api/jobs/${baseJob.jobId}/artifacts?kind=screenshot&finding=ana%3Af1`]);
  expect(seen.order.slice(0, seen.order.indexOf("complete"))).toContain("artifacts answered");
});

const namesOfTools = (model: ReturnType<typeof scriptedModel>) => model.doGenerateCalls[0]!.tools!.map((t) => t.name);

test.each([[true, true], [false, false], [undefined, false]])("a role session can look at the page as a picture only when the runner is set to (look %j: %s)", async (look, offered) => {
  const { url } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  const model = scriptedModel([toolCall("look_at_page", {}), toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  await workOnce(deps(url, model, { openBrowser: shooting, ...(look === undefined ? {} : { look: () => look }) }));
  expect(namesOfTools(model).includes("look_at_page")).toBe(offered);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt).includes("call look_at_page")).toBe(offered);
  const pictures = model.doGenerateCalls[1]?.prompt.some((m) => m.role === "user" && m.content.some((p) => p.type === "file")) ?? false;
  expect(pictures).toBe(offered);
});

test.each([[true, true], [false, false], [undefined, false]])("a replay can look at the page as a picture only when the runner is set to (look %j: %s)", async (look, offered) => {
  const finding = { id: "ana:f1", kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" };
  const { url } = await fakeControlPlane({ ...baseJob, kind: "replay", finding });
  const model = scriptedModel([toolCall("look_at_page", {}), toolCall("report_replay", { completed: true, observed: "Internal Server Error", blockedAt: null })]);
  await workOnce(deps(url, model, { openBrowser: shooting, ...(look === undefined ? {} : { look: () => look }) }));
  expect(namesOfTools(model).includes("look_at_page")).toBe(offered);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt).includes("call look_at_page, then call report_replay")).toBe(offered);
});

test("whether people may look is decided by the job's target address", async () => {
  const { url } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  const asked: string[] = [];
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  await workOnce(deps(url, model, { openBrowser: shooting, look: (target) => (asked.push(target), target === "https://a.test/") }));
  expect(asked).toEqual(["https://a.test/"]);
  expect(namesOfTools(model)).toContain("look_at_page");
});

const within = async (condition: () => boolean, ms = 10_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("the condition was not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function longTimersLeftBy(minMs: number, work: () => Promise<unknown>): Promise<number> {
  const pending = new Set<unknown>();
  const { setTimeout: realSet, clearTimeout: realClear } = globalThis;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle: unknown = realSet((...a: unknown[]) => (pending.delete(handle), fn(...a)), ms, ...args);
    if ((ms ?? 0) >= minMs) pending.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => (pending.delete(handle), realClear(handle))) as typeof clearTimeout;
  try {
    await work();
    return pending.size;
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

test("an upload is tried again after a server error or too many requests but not after a refusal, and a lost screenshot never fails the job", async () => {
  const retried = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadStatuses: [503, 429, 201] });
  await workOnce(deps(retried.url, reportsDefect(), { openBrowser: shooting }));
  expect(retried.seen.uploads).toHaveLength(3);
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  const logged: Array<[string, LogFields | undefined]> = [];
  const refused = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadStatuses: [409] });
  await workOnce(deps(refused.url, reportsDefect(), { openBrowser: shooting, log: (line, fields) => void logged.push([line, fields]) }));
  expect(refused.seen.uploads).toHaveLength(1);
  expect(refused.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "finish" })]);
  expect(logged).toContainEqual([expect.stringMatching(/screenshot of f1 could not be uploaded: HTTP 409/), expect.objectContaining({ level: "error", jobId: baseJob.jobId })]);
});

test("an upload whose connection breaks is tried again, and a server without storage (501) or an upload that timed out is not", async () => {
  const logged: string[] = [];
  const reset = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadResets: 1 });
  await workOnce(deps(reset.url, reportsDefect(), { openBrowser: shooting, log: (line) => void logged.push(line) }));
  expect(reset.seen.uploads).toHaveLength(2);
  expect(logged.filter((l) => l.includes("screenshot"))).toEqual([]);
  await new Promise<void>((r) => (server!.closeAllConnections(), server!.close(() => r())));
  server = undefined;

  const unconfigured = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadStatuses: [501] });
  await workOnce(deps(unconfigured.url, reportsDefect(), { openBrowser: shooting, log: (line) => void logged.push(line) }));
  expect(unconfigured.seen.uploads).toHaveLength(1);
  await new Promise<void>((r) => (server!.closeAllConnections(), server!.close(() => r())));
  server = undefined;

  const slow = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadsHang: true });
  await workOnce(deps(slow.url, reportsDefect(), { openBrowser: shooting, uploadTimeoutMs: 200, uploadWaitMs: 3_000, log: (line) => void logged.push(line) }));
  expect(slow.seen.uploads).toHaveLength(1);
  expect(logged.filter((l) => l.includes("screenshot of f1 could not be uploaded"))).toEqual([expect.stringContaining("HTTP 501"), expect.stringMatching(/timeout/i)]);
});

test("an upload that never answers holds the completion only for a while, and is then dropped with a line in the log", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadsHang: true });
  const logged: Array<[string, LogFields | undefined]> = [];
  const started = Date.now();
  await workOnce(deps(url, reportsDefect(), { openBrowser: shooting, uploadWaitMs: 300, log: (line, fields) => void logged.push([line, fields]) }));
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "finish" })]);
  expect(Date.now() - started).toBeLessThan(5_000);
  await within(() => seen.order.includes("upload dropped"));
  expect(logged.filter(([line]) => line.includes("screenshot"))).toEqual([["1 screenshot was still uploading when the job finished, so it was dropped", expect.objectContaining({ level: "error", jobId: baseJob.jobId })]]);
});

test("the last try of an upload is the one that fits in the time the job waits, and its reason is what gets logged", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadStatuses: [503, 503, 503] });
  const logged: string[] = [];
  await workOnce(deps(url, reportsDefect(), { openBrowser: shooting, retryBaseMs: 2_000, uploadWaitMs: 1_000, log: (line) => void logged.push(line) }));
  expect(seen.uploads).toHaveLength(1);
  expect(logged.filter((l) => l.includes("screenshot"))).toEqual([expect.stringMatching(/screenshot of f1 could not be uploaded: HTTP 503/)]);
});

test("an upload that keeps losing its connection gives up with the connection's error code in the log", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadResets: 99 });
  const logged: string[] = [];
  await workOnce(deps(url, reportsDefect(), { openBrowser: shooting, retryBaseMs: 1, log: (line) => void logged.push(line) }));
  expect(seen.uploads).toHaveLength(6);
  expect(logged.filter((l) => l.includes("screenshot"))).toEqual([expect.stringMatching(/screenshot of f1 could not be uploaded: fetch failed \([A-Z_]+\)$/)]);
});

test("a finished job leaves no timer behind, so a runner working once can exit at once", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  expect(await longTimersLeftBy(10_000, () => workOnce(deps(url, reportsDefect(), { openBrowser: shooting, uploadWaitMs: 60_000 })))).toBe(0);
  expect(seen.completions).toHaveLength(1);
});

test("the browser is never given the runner's or the job's token to look for", async () => {
  const { url } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", config: { ...config, accounts: [{ ref: "a", username: "ana", password: "account-pass-1" }] } });
  let given: string[] = [];
  await workOnce(deps(url, reportsDefect(), { openBrowser: async (project, opts) => ((given = opts.scrubber.browserNeedles()), shooting()) }));
  expect(given).toContain("account-pass-1");
  expect(given.some((n) => n.includes("runner-") || n.includes("job-token-"))).toBe(false);
});

test("a finding reported once the run is cancelled uploads no screenshot and leaves nothing in the log about it", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadsHang: true, cancelOnFinding: true });
  const logged: string[] = [];
  const started = Date.now();
  await workOnce(deps(url, reportsDefect(), { openBrowser: shooting, uploadWaitMs: 10_000, log: (line) => void logged.push(line) }));
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(seen.completions).toHaveLength(1);
  await within(() => seen.order.includes("upload dropped"));
  expect(logged.filter((l) => l.includes("screenshot"))).toEqual([]);
});

test("a stop that comes while uploads are pending completes the job at once instead of waiting for them", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" }, { uploadsHang: true });
  const stop = new AbortController();
  const work = workOnce(deps(url, reportsDefect(), { openBrowser: shooting, uploadWaitMs: 10_000 }), stop.signal);
  await within(() => seen.uploads.length > 0 && seen.events.some((e) => e.type === "job_finished"));
  const stopped = Date.now();
  stop.abort();
  await work;
  expect(Date.now() - stopped).toBeLessThan(2_000);
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "finish" })]);
  expect(seen.releases).toBe(0);
  await within(() => seen.order.includes("upload dropped"));
});

test("a stop that comes before the job has started hands it back without opening a browser", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  const stop = new AbortController();
  const stopAfterClaim: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!String(input).endsWith("/api/runner/claim")) return res;
    const body = await res.arrayBuffer();
    stop.abort();
    return new Response(body, { status: res.status, headers: res.headers });
  };
  let browsers = 0;
  await workOnce(deps(url, reportsDefect(), { openBrowser: async () => (browsers++, shooting()), fetch: stopAfterClaim }), stop.signal);
  expect(seen.releases).toBe(1);
  expect(seen.completions).toEqual([]);
  expect(browsers).toBe(0);
});

test("a job handed back because the runner is stopping drops its pending uploads without complaint", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", maxSteps: 30 }, { uploadsHang: true });
  const model = scriptedModel([
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" }),
    ...Array.from({ length: 20 }, () => toolCall("note", { text: "still looking" })),
  ], 0.001);
  const original = model.doGenerate.bind(model);
  model.doGenerate = async (options) => (await new Promise((r) => setTimeout(r, 30)), original(options));
  const stop = new AbortController();
  const logged: string[] = [];
  const work = workOnce(deps(url, model, { openBrowser: shooting, uploadTimeoutMs: 10_000, log: (line) => void logged.push(line) }), stop.signal);
  while (seen.uploads.length === 0) await new Promise((r) => setTimeout(r, 10));
  stop.abort();
  await work;
  await new Promise((r) => setTimeout(r, 600));
  expect(seen.releases).toBe(1);
  expect(seen.uploads).toHaveLength(1);
  expect(seen.order).toContain("upload dropped");
  expect(logged.filter((l) => l.includes("screenshot"))).toEqual([]);
});

test("a job handed back while an upload waits to be tried again leaves no timer behind", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", maxSteps: 30 }, { uploadStatuses: [503, 503, 503] });
  const model = scriptedModel([
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" }),
    ...Array.from({ length: 20 }, () => toolCall("note", { text: "still looking" })),
  ], 0.001);
  const original = model.doGenerate.bind(model);
  model.doGenerate = async (options) => (await new Promise((r) => setTimeout(r, 30)), original(options));
  const stop = new AbortController();
  const left = await longTimersLeftBy(10_000, async () => {
    const work = workOnce(deps(url, model, { openBrowser: shooting, retryBaseMs: 20_000 }), stop.signal);
    await within(() => seen.order.includes("artifacts answered"));
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    await work;
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(left).toBe(0);
  expect(seen.releases).toBe(1);
  expect(seen.uploads).toHaveLength(1);
});

test("a replay handed back because the runner is stopping takes and uploads no screenshot", async () => {
  const finding = { id: "ana:f1", kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Open /", "Click Save"], severity: "high" };
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "replay", finding });
  const model = scriptedModel(Array.from({ length: 20 }, () => toolCall("browser_snapshot", {})), 0.001);
  const original = model.doGenerate.bind(model);
  model.doGenerate = async (options) => (await new Promise((r) => setTimeout(r, 30)), original(options));
  const stop = new AbortController();
  const logged: string[] = [];
  const work = workOnce(deps(url, model, { openBrowser: shooting, log: (line) => void logged.push(line) }), stop.signal);
  await within(() => seen.events.length > 0);
  stop.abort();
  await work;
  await new Promise((r) => setTimeout(r, 200));
  expect(seen.releases).toBe(1);
  expect(seen.uploads).toEqual([]);
  expect(logged.filter((l) => l.includes("screenshot"))).toEqual([]);
});

test("with nothing to do, a claim comes back idle", async () => {
  const { url, seen } = await fakeControlPlane(null);
  expect(await workOnce(deps(url, scriptedModel([])))).toBe("idle");
  expect(seen.headers[0]).toBe("8");
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

test("a turn of a team session plays its goals with the story so far, and numbers its findings by turn", async () => {
  const story = [{ personaId: "lee", name: "Lee", text: "Accepted Ana's pitch." }];
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", goalIds: ["g"], turn: 2, returning: true, story, signUpSeed: "s".repeat(32) });
  const model = scriptedModel([
    toolCall("browser_snapshot", {}),
    toolCall("submit_finding", { kind: "friction", goal: "g", title: "t", observed: "o", reproduction: ["a"], severity: "low" }),
    toolCall("goal_status", { goal: "g", status: "reached", note: "" }),
    toolCall("finish", { summary: "done" }),
  ]);
  expect(await workOnce(deps(url, model, { openBrowser: shooting }))).toBe("done");
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain("Accepted Ana's pitch.");
  expect(prompt).toContain("you started using earlier in this session");
  const finding = seen.events.find((e) => e.type === "finding") as unknown as { finding: { id: string } };
  expect(finding.finding.id).toBe("t2f1");
});

test("a person is told what the project's team marked not a bug", async () => {
  const { url } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", notBugs: [{ title: "Export asks to confirm twice", reason: "Asking twice is on purpose." }] });
  const model = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  expect(await workOnce(deps(url, model))).toBe("done");
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('- \\"Export asks to confirm twice\\": Asking twice is on purpose.');
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

test("a group job groups the run's defects without a browser and completes with the groups; one that cannot completes as an error with none", async () => {
  const report = (key: string, person: string) => ({ key, person, goal: "Get in.", title: `Save broken for ${person}`, observed: "500", reproduction: ["Open /", "Click Save"] });
  const defects = [report("ana:f1", "Ana"), report("lee:f1", "Lee")];
  let opened = 0;
  const grouped = await fakeControlPlane({ ...baseJob, kind: "group", defects });
  await workOnce(deps(grouped.url, scriptedModel([toolCall("report_groups", { groups: [["lee:f1", "ana:f1", "ghost"]] })]), { openBrowser: async () => { opened++; throw new Error("no browser for grouping"); } }));
  expect(opened).toBe(0);
  expect(grouped.seen.events.map((e) => e.type)).toEqual(["job_started", "job_finished"]);
  expect(grouped.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "done", groups: [["lee:f1", "ana:f1"]] })]);
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  const failed = await fakeControlPlane({ ...baseJob, kind: "group", defects });
  await workOnce(deps(failed.url, scriptedModel([text("no idea"), text("still none")])));
  expect(failed.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: "the model did not group the defects (2 tries)" })]);
  expect(failed.seen.completions[0]).not.toHaveProperty("groups");
});

test("a group job with the project's known non-bugs sends back the reports that match one, with the mark they refer to, and none when nothing matches", async () => {
  const defects = [{ key: "ana:f1", person: "Ana", goal: "g", title: "Postcode refused", observed: "o", reproduction: ["a"] }];
  const notBugs = [{ title: "Postcode field rejects its own placeholder example", reason: "We deliver to a fixed list.", ref: "run-3/ana:f2" }];
  const matched = await fakeControlPlane({ ...baseJob, kind: "group", defects, notBugs });
  const model = scriptedModel([toolCall("report_groups", { groups: [["ana:f1"]], notBugs: [{ id: "ana:f1", item: 1 }] })]);
  await workOnce(deps(matched.url, model));
  expect(matched.seen.completions).toEqual([expect.objectContaining({ stoppedBy: "done", groups: [["ana:f1"]], knownNotBugs: [{ key: "ana:f1", ref: "run-3/ana:f2" }] })]);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain("We deliver to a fixed list.");
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  const plain = await fakeControlPlane({ ...baseJob, kind: "group", defects, notBugs });
  await workOnce(deps(plain.url, scriptedModel([toolCall("report_groups", { groups: [["ana:f1"]] })])));
  expect(plain.seen.completions[0]).not.toHaveProperty("knownNotBugs");
});

test("an account check signs in once and completes with what the product said, never with the password", async () => {
  const accounts = [{ ref: "ana", username: "ana@a.test", password: "correct-horse-battery" }];
  const { url, seen } = await fakeControlPlane({ ...baseJob, config: { ...config, accounts }, kind: "account_check", accountRef: "ana", maxSteps: 12 });
  const filled: string[] = [];
  await workOnce(deps(url, scriptedModel([
    toolCall("sign_in", { account: "ana", usernameField: "e1", passwordField: "e2" }),
    toolCall("report_sign_in", { outcome: "refused", observed: "Wrong password for correct-horse-battery" }),
  ]), { openBrowser: async () => ({ ...(await browser()), fillField: async (_ref: string, value: string) => (filled.push(value), "typed") }) }));
  expect(filled).toEqual(["ana@a.test", "correct-horse-battery"]);
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "report", signIn: { outcome: "refused", observed: expect.stringMatching(/^Wrong password for (?!correct-horse-battery)/) } })]);
  expect(seen.events[0]).toMatchObject({ type: "job_started", kind: "account_check" });
  expect(JSON.stringify(seen)).not.toContain("correct-horse-battery");
});

test("a person whose account comes from the CI job signs in with it, and its password never reaches an event, a note or the completion", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", accountRef: undefined, providedAccounts: ["Ana"] });
  const filled: string[] = [];
  await workOnce(deps(url, scriptedModel([
    toolCall("sign_in", { account: "ci:ana", usernameField: "e1", passwordField: "e2" }),
    toolCall("note", { text: "signed in with ci-secret-pass" }),
    toolCall("goal_status", { goal: "g", status: "reached", note: "used ci-secret-pass" }),
    toolCall("finish", { summary: "done with ci-secret-pass" }),
  ]), { accounts: { Ana: { username: "ana@ci.test", password: "ci-secret-pass" } }, openBrowser: async () => ({ ...(await browser()), fillField: async (_ref: string, value: string) => (filled.push(value), "typed") }) }));
  expect(filled).toEqual(["ana@ci.test", "ci-secret-pass"]);
  expect(seen.events.map((e) => e.type)).toEqual(expect.arrayContaining(["note", "goal_status"]));
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "finish" })]);
  expect(JSON.stringify(seen)).not.toContain("ci-secret-pass");
});

test("a person whose account should come from the CI job but is not in the runner's file fails the job early, naming them", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana", providedAccounts: ["Ana"] });
  let opened = false;
  const reports: string[] = [];
  await workOnce(deps(url, scriptedModel([]), { accounts: { Bob: { username: "bob", password: "bob-secret-pass" } }, report: (m) => void reports.push(m), openBrowser: async () => { opened = true; throw new Error("unreachable"); } }));
  expect(opened).toBe(false);
  expect(seen.events).toEqual([]);
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: expect.stringContaining("Ana signs in with an account from the CI job") })]);
  expect(JSON.stringify([seen, reports])).not.toContain("bob-secret-pass");
});

test("an account check that names no account completes as an error", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "account_check" });
  await workOnce(deps(url, scriptedModel([])));
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: "the account check names no account" })]);
});

test("a browser that will not start completes the job as an error", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  await workOnce(deps(url, scriptedModel([]), { openBrowser: async () => { throw new Error("no chromium"); } }));
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: "no chromium" })]);
});

test("what the browser left is cleared before and after every job, even one that fails or whose browser never closes", async () => {
  const order: string[] = [];
  const job = { ...baseJob, kind: "role_session", personaKey: "ana" };
  const finishes = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  const opening = (close: () => Promise<void>) => async () => (order.push("open"), { tools: {}, fillField: async () => "typed", screenshot: async () => null, pageUrl: () => null, close });
  const betweenJobs = async () => void order.push("clean");
  let cp = await fakeControlPlane(job);
  await workOnce(deps(cp.url, finishes, { openBrowser: opening(async () => void order.push("close")), betweenJobs }));
  expect(order).toEqual(["clean", "open", "close", "clean"]);
  order.length = 0;
  server?.close();
  cp = await fakeControlPlane(job);
  await workOnce(deps(cp.url, scriptedModel([]), { openBrowser: async () => { throw new Error("no chromium"); }, betweenJobs }));
  expect(order).toEqual(["clean", "clean"]);
  order.length = 0;
  server?.close();
  cp = await fakeControlPlane(job);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const done = workOnce(deps(cp.url, scriptedModel([toolCall("finish", { summary: "done" })]), { openBrowser: opening(() => new Promise(() => {})), betweenJobs }));
    await vi.waitFor(() => expect(order).toContain("open"));
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await done;
  } finally {
    vi.useRealTimers();
  }
  expect(order).toEqual(["clean", "open", "clean"]);
});

test("a job whose browser's leftovers cannot be cleared first does not start, and completes as an error", async () => {
  const { url, seen } = await fakeControlPlane({ ...baseJob, kind: "role_session", personaKey: "ana" });
  let opened = false;
  await workOnce(deps(url, scriptedModel([]), { openBrowser: async () => { opened = true; throw new Error("unreachable"); }, betweenJobs: async () => { throw new Error("sudo: a password is required"); } }));
  expect(opened).toBe(false);
  expect(seen.completions).toEqual([expect.objectContaining({ stoppedBy: "error", error: expect.stringContaining("could not clear what the last job's browser left, so this job did not start: sudo: a password is required") })]);
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

test("a hosted replay of a defect that needs two people opens a second browser for the second person and closes it", async () => {
  const team = { ...config, personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }] };
  const finding = { id: "ana:f1", kind: "defect", goal: "g", title: "Broken", observed: "500", reproduction: ["Invite Ana", "Open the invite"], by: ["lee", "ana"], severity: "high" };
  const { url } = await fakeControlPlane({ ...baseJob, config: team, kind: "replay", finding });
  let opened = 0;
  let closed = 0;
  const counting = async () => (opened++, { ...(await browser()), close: async () => void closed++ });
  const model = scriptedModel([toolCall("browser_snapshot", {}), toolCall("act_as", { person: "Ana" }), toolCall("browser_snapshot", {}), toolCall("report_replay", { completed: true, observed: "500", blockedAt: null })]);
  await workOnce(deps(url, model, { openBrowser: counting }));
  expect({ opened, closed }).toEqual({ opened: 2, closed: 2 });
});

test("the team channel waits for a new message, then reports whether the others are still working", async () => {
  const message = { id: 5, personaId: "lee", name: "Lee", text: "invite me", at: "2026-10-04T10:00:00.000Z" };
  const answers = [{ messages: [], othersWorking: true }, { messages: [], othersWorking: true }, { messages: [message], othersWorking: true }];
  const urls: string[] = [];
  const fetchStub = (async (url: URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(answers.shift()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const channel = channelFor({ controlPlane: "http://cp.test", fetch: fetchStub, channelPollMs: 1 } as WorkerDeps, baseJob as never);
  expect(channel.othersWorking?.()).toBeUndefined();
  expect(await channel.read(2, 5)).toEqual([message]);
  expect(urls).toHaveLength(3);
  expect(urls[0]).toContain("after=2");
  expect(channel.othersWorking?.()).toBe(true);
});

test("the team channel stops waiting when the others have finished, and does not wait without being asked", async () => {
  const bodies = [{ messages: [], othersWorking: false }, { messages: [] }];
  let calls = 0;
  const fetchStub = (async () => {
    calls++;
    return new Response(JSON.stringify(bodies.shift()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const channel = channelFor({ controlPlane: "http://cp.test", fetch: fetchStub, channelPollMs: 1 } as WorkerDeps, baseJob as never);
  expect(await channel.read(0, 30)).toEqual([]);
  expect(channel.othersWorking?.()).toBe(false);
  expect(await channel.read(0)).toEqual([]);
  expect(calls).toBe(2);
  expect(channel.othersWorking?.()).toBeUndefined();
});
