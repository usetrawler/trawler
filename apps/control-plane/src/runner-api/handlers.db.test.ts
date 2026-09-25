import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, ProjectConfigSchema } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelRun, startRun } from "../runs/runs.ts";
import { claimJob, releaseJob } from "../runs/queue.ts";
import { handleClaim, handleComplete, handleEvents, type RunnerApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const RUNNER_TOKEN = "runner-token-" + "x".repeat(40);
const deps: RunnerApiDeps = { db: t.db, keys, runnerToken: RUNNER_TOKEN, claimWaitMs: 300, pollMs: 50 };

const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "x" }] });

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://cp.test${url}`, { method: "POST", headers: { "content-type": "application/json", [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers }, body: JSON.stringify(body) });
const runner = { authorization: `Bearer ${RUNNER_TOKEN}` };

test("claiming needs the runner token and a supported protocol", async () => {
  expect((await handleClaim(post("/api/runner/claim", {}), deps)).status).toBe(401);
  expect((await handleClaim(post("/api/runner/claim", {}, { authorization: "Bearer wrong" }), deps)).status).toBe(401);
  expect((await handleClaim(post("/api/runner/claim", {}, { ...runner, [PROTOCOL_HEADER]: "0" }), deps)).status).toBe(426);
});

test("an empty queue answers 204 after waiting", async () => {
  const started = Date.now();
  const res = await handleClaim(post("/api/runner/claim", {}, runner), deps);
  expect(res.status).toBe(204);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
});

test("a job is claimed, streamed and completed over HTTP with its own token only", async () => {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" }));
  const claimed = await handleClaim(post("/api/runner/claim", {}, runner), deps);
  expect(claimed.status).toBe(200);
  const job = await claimed.json();
  expect(job).toMatchObject({ kind: "role_session", personaKey: "ana" });
  const auth = { authorization: `Bearer ${job.token}` };
  const at = new Date().toISOString();
  const events = { events: [{ seq: 1, at, jobId: job.jobId, type: "note", text: "hi" }] };

  expect((await handleEvents(post(`/api/jobs/${job.jobId}/events`, events), job.jobId, deps)).status).toBe(401);
  expect((await handleEvents(post(`/api/jobs/${job.runId}/events`, events, auth), job.runId, deps)).status).toBe(401);
  expect((await handleEvents(post(`/api/jobs/${job.jobId}/events`, { events: [{ seq: 1, at, jobId: job.jobId, type: "step", step: 1, tool: null, costUsd: -5 }] }, auth), job.jobId, deps)).status).toBe(400);
  expect((await handleEvents(post(`/api/jobs/${job.jobId}/events`, { events: Array.from({ length: 201 }, (_, i) => ({ seq: i + 1, at, jobId: job.jobId, type: "note", text: "x" })) }, auth), job.jobId, deps)).status).toBe(400);

  const accepted = await handleEvents(post(`/api/jobs/${job.jobId}/events`, events, auth), job.jobId, deps);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ cancel: false });

  const done = { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0.01, steps: 1 }, stoppedBy: "finish" };
  expect((await handleComplete(post(`/api/jobs/${job.jobId}/complete`, done, auth), job.jobId, deps)).status).toBe(200);
  expect((await handleComplete(post(`/api/jobs/${job.jobId}/complete`, done, auth), job.jobId, deps)).status).toBe(200);
  const { rows } = await sql<{ status: string }>`select status from runs`.execute(t.db);
  expect(rows[0]!.status).toBe("succeeded");
});

test("malformed bodies are rejected without touching the queue", async () => {
  expect((await handleEvents(new Request("http://cp.test/x", { method: "POST", headers: { [PROTOCOL_HEADER]: "1", authorization: `Bearer ${"t".repeat(40)}` }, body: "{not json" }), "00000000-0000-0000-0000-000000000000", deps)).status).toBe(400);
});

test("oversized bodies are refused before parsing", async () => {
  const big = JSON.stringify({ events: [{ seq: 1, at: new Date().toISOString(), jobId: "x", type: "note", text: "a".repeat(2_100_000) }] });
  const res = await handleEvents(new Request("http://cp.test/x", { method: "POST", headers: { [PROTOCOL_HEADER]: "1", authorization: `Bearer ${"t".repeat(40)}` }, body: big }), "00000000-0000-0000-0000-000000000000", deps);
  expect(res.status).toBe(413);
});

async function startAndClaim() {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" }));
  return run;
}

test("a runner that hangs up while its claim is being prepared leaves the job in the queue", async () => {
  const run = await startAndClaim();
  let checks = 0;
  const signal = { get aborted() { return ++checks > 1; } };
  const req = post("/api/runner/claim", {}, runner);
  const hungUp = new Proxy(req, { get: (target, prop) => (prop === "signal" ? signal : Reflect.get(target, prop, target)) });
  expect((await handleClaim(hungUp, deps)).status).toBe(204);
  const { rows } = await sql<{ status: string; token_hash: string | null }>`select status, token_hash from jobs where run_id = ${run.id}`.execute(t.db);
  expect(rows).toEqual([{ status: "queued", token_hash: null }]);
  const { rows: runs } = await sql<{ status: string }>`select status from runs where id = ${run.id}`.execute(t.db);
  expect(runs[0]!.status).toBe("queued");
  const again = await handleClaim(post("/api/runner/claim", {}, runner), deps);
  expect(again.status).toBe(200);
  const job = await again.json();
  expect(job.runId).toBe(run.id);
  await handleComplete(post(`/api/jobs/${job.jobId}/complete`, { usage: { model: "a", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "finish" }, { authorization: `Bearer ${job.token}` }), job.jobId, deps);
});

test("text the database cannot store is cleaned instead of failing the batch, and reported costs never count", async () => {
  const run = await startAndClaim();
  const job = await (await handleClaim(post("/api/runner/claim", {}, runner), deps)).json();
  expect(job.runId).toBe(run.id);
  const auth = { authorization: `Bearer ${job.token}` };
  const at = new Date().toISOString();
  const split = ("a".repeat(3999) + "😀 tail").slice(0, 4000);
  const events = { events: [
    { seq: 1, at, jobId: job.jobId, type: "note", text: split },
    { seq: 2, at, jobId: job.jobId, type: "note", text: "nul\u0000byte" },
    { seq: 3, at, jobId: job.jobId, type: "goal_status", outcome: { goal: "g", status: "failed", note: "bad\u0000note" } },
  ] };
  expect((await handleEvents(post(`/api/jobs/${job.jobId}/events`, events, auth), job.jobId, deps)).status).toBe(200);
  const { rows: notes } = await sql<{ text: string }>`select payload->>'text' as text from run_events where job_id = ${job.jobId} and type = 'note' order by seq`.execute(t.db);
  expect(notes.map((n) => n.text)).toEqual(["a".repeat(3999) + "\ufffd", "nulbyte"]);
  const { rows: goals } = await sql<{ note: string }>`select note from goal_outcomes where run_id = ${run.id}`.execute(t.db);
  expect(goals[0]!.note).toBe("badnote");

  const done = (costUsd: number) => ({ usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd, steps: 1 }, stoppedBy: "finish" });
  await handleComplete(post(`/api/jobs/${job.jobId}/complete`, done(0.02), auth), job.jobId, deps);
  await handleComplete(post(`/api/jobs/${job.jobId}/complete`, done(5), auth), job.jobId, deps);
  const { rows } = await sql<{ cost_usd: string }>`select cost_usd from runs where id = ${run.id}`.execute(t.db);
  expect(Number(rows[0]!.cost_usd)).toBe(0);
});

test("a claim released after its run was cancelled is cancelled, not queued forever", async () => {
  const run = await startAndClaim();
  const job = await claimJob(t.db, keys);
  expect(job?.runId).toBe(run.id);
  await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id));
  await releaseJob(t.db, job!);
  const { rows } = await sql<{ status: string }>`select status from jobs where run_id = ${run.id}`.execute(t.db);
  expect(rows).toEqual([{ status: "cancelled" }]);
});
