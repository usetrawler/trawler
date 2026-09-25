import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { modelKey } from "../credentials/credentials.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { claimJob, completeJob, ingestEvents } from "../runs/queue.ts";
import { runSummary, startRun } from "../runs/runs.ts";
import { handleSmokeStart, handleSmokeStatus, SMOKE_ORG, type SmokeDeps } from "./smoke.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const TOKEN = "smoke-" + "s".repeat(40);
const KEY = "sk-or-v1-" + "k".repeat(48);
const deps: SmokeDeps = { db: t.db, keys, smokeToken: TOKEN, modelKey: KEY, model: "deepseek/deepseek-v4.1-flash" };
const call = (method: string, token?: string) => new Request("http://cp.test/api/smoke/runs", { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
const start = async (over: Partial<SmokeDeps> = {}) => handleSmokeStart(call("POST", TOKEN), { ...deps, ...over });
const status = async (runId: string, token = TOKEN) => handleSmokeStatus(call("GET", token), runId, deps);
const summaryOf = (runId: string) => withOrg(t.db, SMOKE_ORG, (tx) => runSummary(tx, SMOKE_ORG, runId));

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-squatter', 'Squatter', 'trawler-smoke', now())`.execute(t.db);
});

test("the smoke endpoints answer 404 without a smoke token", async () => {
  expect((await start({ smokeToken: undefined })).status).toBe(404);
  expect((await handleSmokeStatus(call("GET", TOKEN), "11111111-1111-4111-8111-111111111111", { ...deps, smokeToken: undefined })).status).toBe(404);
});

test("they answer only to the smoke token", async () => {
  expect((await handleSmokeStart(call("POST"), deps)).status).toBe(401);
  expect((await handleSmokeStart(call("POST", "wrong-" + "w".repeat(40)), deps)).status).toBe(401);
  expect((await status("11111111-1111-4111-8111-111111111111", "wrong-" + "w".repeat(40))).status).toBe(401);
});

test("starting says which key is missing", async () => {
  const res = await start({ modelKey: undefined });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: expect.stringMatching(/OPENROUTER_API_KEY/) });
});

test("starts one short run on the demo target in its own workspace, with the smoke key, even when a user took the address trawler-smoke", async () => {
  const res = await start();
  expect(res.status).toBe(201);
  const { runId } = await res.json();
  const summary = await summaryOf(runId);
  expect(summary).toMatchObject({ status: "queued", target: "https://demo.playwright.dev/todomvc/", agentModel: "deepseek/deepseek-v4.1-flash", judgeModel: "deepseek/deepseek-v4.1-flash", budgetUsd: 0.1 });
  expect(summary!.personas).toHaveLength(1);
  expect(summary!.goalTexts).toHaveLength(1);
  const steps = await withOrg(t.db, SMOKE_ORG, (tx) => tx.selectFrom("runs").select(["max_steps", "replay_steps"]).where("id", "=", runId).executeTakeFirstOrThrow());
  expect(steps).toEqual({ max_steps: 12, replay_steps: 8 });
  expect(await withOrg(t.db, SMOKE_ORG, (tx) => modelKey(tx, SMOKE_ORG, keys))).toMatchObject({ provider: "openrouter", key: KEY });
});

test("a run left over from an earlier check is cancelled, so the new one is not stuck behind it", async () => {
  const old = (await (await start()).json()).runId;
  expect((await claimJob(t.db, keys))!.runId).toBe(old);
  expect((await summaryOf(old))!.status).toBe("running");
  expect(await (await status(old)).json()).toMatchObject({ status: "running", finished: false });
  const fresh = (await (await start()).json()).runId;
  expect(fresh).not.toBe(old);
  expect((await summaryOf(old))!.status).toBe("cancelled");
  expect((await summaryOf(fresh))!.status).toBe("queued");
});

test("reports how the run went, job by job", async () => {
  const { runId } = await (await start()).json();
  let res = await status(runId);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ runId, status: "queued", finished: false, jobs: [{ kind: "role_session", status: "queued" }] });

  const job = (await claimJob(t.db, keys))!;
  expect(job.runId).toBe(runId);
  const at = new Date().toISOString();
  await ingestEvents(t.db, job.token, [{ seq: 1, at, jobId: job.jobId, type: "goal_status", outcome: { goal: "add-todo", status: "reached", note: "" } }]);
  await completeJob(t.db, job.token, { usage: { model: deps.model, inputTokens: 10, outputTokens: 5, costUsd: 0, steps: 3 }, stoppedBy: "finish" });

  res = await status(runId);
  expect(await res.json()).toEqual({
    runId, status: "succeeded", finished: true, costUsd: 0, goalsReached: 1, goalsTotal: 1,
    jobs: [{ kind: "role_session", status: "succeeded", stoppedBy: "finish", error: null }],
  });
});

async function finishOnlySession(runId: string, result: { goal?: "reached" | "failed"; stoppedBy: "finish" | "error"; error?: string }) {
  const job = (await claimJob(t.db, keys))!;
  expect(job.runId).toBe(runId);
  if (result.goal) {
    await ingestEvents(t.db, job.token, [{ seq: 1, at: new Date().toISOString(), jobId: job.jobId, type: "goal_status", outcome: { goal: "add-todo", status: result.goal, note: "" } }]);
  }
  await completeJob(t.db, job.token, { usage: { model: deps.model, inputTokens: 10, outputTokens: 5, costUsd: 0, steps: 3 }, stoppedBy: result.stoppedBy, error: result.error });
}

test("a goal the agent did not reach is not counted as reached, although the run succeeded", async () => {
  const { runId } = await (await start()).json();
  await finishOnlySession(runId, { goal: "failed", stoppedBy: "finish" });
  expect(await (await status(runId)).json()).toMatchObject({ status: "succeeded", finished: true, goalsReached: 0, goalsTotal: 1 });
});

test("a run whose session failed is finished, and says why", async () => {
  const { runId } = await (await start()).json();
  await finishOnlySession(runId, { stoppedBy: "error", error: "the browser failed 3 times in a row" });
  expect(await (await status(runId)).json()).toMatchObject({
    status: "failed", finished: true, goalsReached: 0,
    jobs: [{ kind: "role_session", status: "failed", stoppedBy: "error", error: "the browser failed 3 times in a row" }],
  });
});

test("never reports a run of another workspace, or a run that does not exist", async () => {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", ProjectConfigSchema.parse({ name: "A", targetUrl: "https://a.test/", personas: [{ id: "p", name: "P", brief: "b" }], goals: [{ id: "g", instruction: "x" }] }), keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 1, agentModel: "a", judgeModel: "a", maxSteps: 5, replaySteps: 5, createdBy: "u" }));
  expect((await status(run.id)).status).toBe(404);
  expect((await status("22222222-2222-4222-8222-222222222222")).status).toBe(404);
  expect((await status("not-a-uuid")).status).toBe(404);
});
