import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { createModel } from "@usetrawler/core";
import { tool } from "ai";
import { z } from "zod";
import { workOnce } from "../../../runner/src/worker.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { setModelKey } from "../credentials/credentials.ts";
import { resetPriceCache } from "../llm/prices.ts";
import { handleChatCompletions } from "../llm-proxy/proxy.ts";
import { createProject } from "../projects/projects.ts";
import { runSummary, startRun } from "../runs/runs.ts";
import { handleClaim, handleComplete, handleEvents, handleRelease, type RunnerApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const runnerToken = "runner-" + "r".repeat(40);
const deps: RunnerApiDeps = { db: t.db, keys, runnerToken, claimWaitMs: 50, pollMs: 10 };
const ORG_KEY = "sk-or-v1-" + "k".repeat(64);
let server: Server;
let openRouter: Server;
let base = "";
let openRouterBase = "";
const seen: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
let replies: unknown[] = [];

const usage = { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230, cost: 0.001 };
const toolReply = (name: string, args: unknown) => ({
  id: "gen", object: "chat.completion", created: 1, model: "m/agent",
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call-${name}-${seen.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage,
});
const textReply = (content: string) => ({ id: "gen", object: "chat.completion", created: 1, model: "m/judge", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://cp.test${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const match = /^\/api\/jobs\/([^/]+)\/(events|complete|release)$/.exec(req.url ?? "");
    const response = req.url === "/api/llm/v1/chat/completions" ? await handleChatCompletions(request, { db: t.db, keys, openRouterUrl: openRouterBase, retryBaseMs: 1 }) : req.url === "/api/runner/claim" ? await handleClaim(request, deps) : match ? await (match[2] === "events" ? handleEvents : match[2] === "release" ? handleRelease : handleComplete)(request, match[1]!, deps) : new Response(null, { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  openRouter = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/api/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "deepseek/deepseek-v4.1-flash", pricing: { prompt: "0.0000003", completion: "0.0000012" } }] }));
    }
    seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const reply = replies.shift();
    if (reply && typeof reply === "object" && "delayMs" in reply) await new Promise((r) => setTimeout(r, (reply as { delayMs: number }).delayMs));
    res.writeHead(reply ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(reply ?? { error: { message: "no scripted reply" } }));
  });
  await new Promise<void>((r) => openRouter.listen(0, "127.0.0.1", r));
  openRouterBase = `http://127.0.0.1:${(openRouter.address() as { port: number }).port}/api/v1`;
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
  await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "openrouter", key: ORG_KEY }, "u", keys));
  resetPriceCache();
});
afterAll(() => new Promise<void>((r) => server.close(() => openRouter.close(() => r()))));

const worker = () => ({
  controlPlane: base, runnerToken, log: () => {}, flushMs: 5, retryBaseMs: 5,
  model: (modelId: string, jobToken: string) => createModel({ modelId, apiKey: jobToken, baseURL: `${base}/api/llm/v1` }),
  openBrowser: async () => ({ tools: { browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => "the invoice form" }) }, fillField: async () => "typed", close: async () => {} }),
});

test("a run goes from start to a confirmed defect through the real runner API and worker", async () => {
  const config = ProjectConfigSchema.parse({
    name: "Acme", targetUrl: "https://app.acme.test/",
    personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Save an invoice." }],
  });
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 10, replaySteps: 10, createdBy: "u" }));
  replies = [
    toolReply("browser_snapshot", {}),
    toolReply("submit_finding", { kind: "defect", goal: "g", title: "Saving fails", observed: "Save returned an error page", reproduction: ["Open https://app.acme.test/invoices/new", "Click Save"], severity: "high" }),
    toolReply("goal_status", { goal: "g", status: "failed", note: "error page" }),
    toolReply("finish", { summary: "done" }),
    toolReply("report_replay", { completed: true, observed: "An Internal Server Error page appeared", blockedAt: null }),
    toolReply("report_verdict", { verdict: "confirmed" }),
  ];
  seen.length = 0;
  for (let i = 0; i < 3; i++) expect(await workOnce(worker())).toBe("done");
  expect(await workOnce(worker())).toBe("idle");
  const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
  expect(summary).toMatchObject({ status: "succeeded" });
  expect(summary!.findings).toEqual([expect.objectContaining({ key: "ana:f1", title: "Saving fails", verdict: "confirmed", replay: expect.objectContaining({ completed: true }) })]);
  expect(summary!.goals).toEqual([{ personaKey: "ana", goal: "g", status: "failed", note: "error page" }]);
  expect(summary!.costUsd).toBeCloseTo(0.006, 6);
  expect(seen).toHaveLength(6);
  for (const call of seen) {
    expect(call.auth).toBe(`Bearer ${ORG_KEY}`);
    expect(call.body).toMatchObject({ usage: { include: true }, provider: { data_collection: "deny" } });
  }
  expect(seen.map((c) => c.body.model)).toEqual(["m/agent", "m/agent", "m/agent", "m/agent", "m/agent", "m/judge"]);
  expect(seen.at(-1)!.body).toMatchObject({ max_tokens: 8000, tools: [expect.objectContaining({ function: expect.objectContaining({ name: "report_verdict" }) })] });
  const { rows } = await sql<{ n: number; cost: string }>`select count(*)::int as n, sum(cost_usd) as cost from llm_usage where run_id = ${run.id}`.execute(t.db);
  expect(rows[0]).toEqual({ n: 6, cost: "0.006000" });
});

test("a run that spends its cap mid-session is stopped by the proxy, and the job ends as budget", async () => {
  const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "lee", name: "Lee", brief: "b" }], goals: [{ id: "g", instruction: "Look around." }] });
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 0.0015, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 10, replaySteps: 10, createdBy: "u" }));
  replies = Array.from({ length: 5 }, () => toolReply("note", { text: "looking" }));
  seen.length = 0;
  expect(await workOnce(worker())).toBe("done");
  expect(seen).toHaveLength(2);
  const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
  expect(summary).toMatchObject({ status: "stopped_budget" });
  expect(summary!.costUsd).toBeCloseTo(0.002, 6);
  expect(summary!.jobs[0]).toMatchObject({ status: "succeeded", stopped_by: "budget" });
});

test("the proxy refuses a stranger, a model the run did not choose, and streaming", async () => {
  const call = (token: string, body: unknown) => handleChatCompletions(new Request(`${base}/api/llm/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { db: t.db, keys, openRouterUrl: openRouterBase });
  expect((await call("x".repeat(43), { model: "m/agent", messages: [] })).status).toBe(401);
  const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "kim", name: "Kim", brief: "b" }], goals: [{ id: "g", instruction: "x" }] });
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 10, replaySteps: 10, createdBy: "u" }));
  const job = await (await handleClaim(new Request(`${base}/api/runner/claim`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "x-trawler-protocol": "1" } }), deps)).json();
  seen.length = 0;
  expect((await call(job.token, { model: "openai/gpt-5-pro", messages: [] })).status).toBe(400);
  expect((await call(job.token, { model: "m/agent", stream: true, messages: [] })).status).toBe(400);
  expect(seen).toHaveLength(0);
  replies = [textReply("ok")];
  const smuggled = await call(job.token, { model: "m/agent", messages: [{ role: "user", content: "hi" }], models: ["openai/gpt-5-pro"], route: "fallback", plugins: [{ id: "web" }], provider: { data_collection: "allow", order: ["x"] }, n: 5, usage: { include: false } });
  expect(smuggled.status).toBe(200);
  expect(seen[0]!.body).toEqual({ model: "m/agent", messages: [{ role: "user", content: "hi" }], max_tokens: 16_000, usage: { include: true }, provider: { data_collection: "deny", allow_fallbacks: true } });
  await handleComplete(new Request(`${base}/api/jobs/${job.jobId}/complete`, { method: "POST", headers: { authorization: `Bearer ${job.token}`, "x-trawler-protocol": "1", "content-type": "application/json" }, body: JSON.stringify({ usage: { model: "m/agent", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "finish" }) }), job.jobId, deps);
  expect((await call(job.token, { model: "m/agent", messages: [] })).status).toBe(402);
});

test("the proxy bounds a call by what is left of the cap, prices calls OpenRouter reports as free, lets one call run at a time, and never passes a 200 error on", async () => {
  const model = "deepseek/deepseek-v4.1-flash";
  const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "bo", name: "Bo", brief: "b" }], goals: [{ id: "g", instruction: "x" }] });
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 0.01, agentModel: model, judgeModel: model, maxSteps: 10, replaySteps: 10, createdBy: "u", price: { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 } }));
  const job = await (await handleClaim(new Request(`${base}/api/runner/claim`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "x-trawler-protocol": "1" } }), deps)).json();
  expect(job.runId).toBe(run.id);
  const call = (body: Record<string, unknown> = {}) => handleChatCompletions(new Request(`${base}/api/llm/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...body }) }), { db: t.db, keys, openRouterUrl: openRouterBase, retryBaseMs: 1 });

  seen.length = 0;
  replies = [{ ...textReply("ok"), usage: { prompt_tokens: 10_000, completion_tokens: 100 } }];
  expect((await call({ max_tokens: 100_000 })).status).toBe(200);
  expect(seen[0]!.body.max_tokens).toBe(Math.min(16_000, Math.floor((0.01 * 1e6) / 1.2)));
  const cost = async () => Number((await sql<{ cost_usd: string }>`select cost_usd from runs where id = ${run.id}`.execute(t.db)).rows[0]!.cost_usd);
  expect(await cost()).toBeCloseTo((10_000 * 0.3 + 100 * 1.2) / 1e6, 9);

  replies = [{ error: { message: "provider exploded", code: 500 } }];
  const failed = await call();
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: { code: 502, message: "provider exploded" } });

  replies = [{ ...textReply("slow"), delayMs: 300 }];
  const first = call();
  await new Promise((r) => setTimeout(r, 50));
  expect((await call()).status).toBe(429);
  expect((await first).status).toBe(200);
});

test("a run on a direct provider goes to that provider without OpenRouter extras, and an unpriced model stops at its token cap", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-o', 'O', 'o', now())`.execute(t.db);
  await withOrg(t.db, "org-o", (tx) => setModelKey(tx, "org-o", { provider: "openai", key: "sk-proj-" + "p".repeat(40) }, "u", keys));
  const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "oz", name: "Oz", brief: "b" }], goals: [{ id: "g", instruction: "x" }] });
  const project = await withOrg(t.db, "org-o", (tx) => createProject(tx, "org-o", config, keys));
  const run = await withOrg(t.db, "org-o", (tx) => startRun(tx, "org-o", project, keys, { budgetUsd: 5, agentModel: "gpt-5-mini", judgeModel: "gpt-5-mini", maxSteps: 10, replaySteps: 10, createdBy: "u", provider: "openai", tokenCap: 2000 }));
  const job = await (await handleClaim(new Request(`${base}/api/runner/claim`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "x-trawler-protocol": "1" } }), deps)).json();
  expect(job.runId).toBe(run.id);
  const toOpenAi: string[] = [];
  const routed: typeof fetch = (url, init) => {
    const target = String(url);
    if (target.startsWith("https://api.openai.com/v1")) toOpenAi.push(target);
    return fetch(target.replace("https://api.openai.com/v1", openRouterBase), init);
  };
  const call = () => handleChatCompletions(new Request(`${base}/api/llm/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], reasoning: { effort: "high" } }) }), { db: t.db, keys, openRouterUrl: openRouterBase, fetch: routed, retryBaseMs: 1 });
  seen.length = 0;
  replies = [{ ...textReply("ok"), usage: { prompt_tokens: 1500, completion_tokens: 600 } }];
  expect((await call()).status).toBe(200);
  expect(toOpenAi).toEqual(["https://api.openai.com/v1/chat/completions"]);
  expect(seen[0]!.auth).toBe("Bearer sk-proj-" + "p".repeat(40));
  expect(seen[0]!.body).toEqual({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 2000 });
  const summary = await withOrg(t.db, "org-o", (tx) => runSummary(tx, "org-o", run.id));
  expect(summary).toMatchObject({ status: "stopped_budget", costUsd: 0, tokensUsed: 2100, tokenCap: 2000, provider: "openai" });
  expect((await call()).status).toBe(402);
});

test("a session interrupted by a runner shutdown goes back to the queue with its partial work forgotten, and the next runner finishes the run", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-s', 'S', 's', now())`.execute(t.db);
  await withOrg(t.db, "org-s", (tx) => setModelKey(tx, "org-s", { provider: "openrouter", key: ORG_KEY }, "u", keys));
  const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "priya", name: "Priya", brief: "b" }], goals: [{ id: "g", instruction: "x" }] });
  const project = await withOrg(t.db, "org-s", (tx) => createProject(tx, "org-s", config, keys));
  const run = await withOrg(t.db, "org-s", (tx) => startRun(tx, "org-s", project, keys, { budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 10, replaySteps: 10, createdBy: "u" }));
  replies = [
    { ...toolReply("goal_status", { goal: "g", status: "failed", note: "half way" }), delayMs: 0 },
    ...Array.from({ length: 4 }, () => ({ ...toolReply("note", { text: "still going" }), delayMs: 150 })),
  ];
  const stop = new AbortController();
  const first = workOnce({ ...worker(), flushMs: 5 }, stop.signal);
  await new Promise((r) => setTimeout(r, 400));
  stop.abort();
  expect(await first).toBe("done");
  const { rows: jobs } = await sql<{ status: string; token_hash: string | null }>`select status, token_hash from jobs where run_id = ${run.id}`.execute(t.db);
  expect(jobs).toEqual([{ status: "queued", token_hash: null }]);
  expect((await sql`select 1 from run_events where run_id = ${run.id}`.execute(t.db)).rows).toHaveLength(0);
  expect((await sql`select 1 from goal_outcomes where run_id = ${run.id}`.execute(t.db)).rows).toHaveLength(0);

  replies = [toolReply("goal_status", { goal: "g", status: "reached", note: "" }), toolReply("finish", { summary: "done" })];
  expect(await workOnce(worker())).toBe("done");
  const summary = await withOrg(t.db, "org-s", (tx) => runSummary(tx, "org-s", run.id));
  expect(summary).toMatchObject({ status: "succeeded" });
  expect(summary!.goals).toEqual([{ personaKey: "priya", goal: "g", status: "reached", note: "" }]);
  expect(summary!.jobs.map((j) => j.status)).toEqual(["succeeded"]);
});
