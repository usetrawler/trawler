import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema, type RunEvent } from "@usetrawler/protocol";
import { setModelKey } from "../credentials/credentials.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { monthlyBudget, setMonthlyBudget } from "./limits.ts";
import { FIRST_RUN_ON_US } from "./models.ts";
import { claimJob, completeJob, ingestEvents, llmCallFor, recordLlmUsage } from "./queue.ts";
import { cancelLiveRuns, cancelRun, FirstRunOnUsUsed, firstRunOnUsLeft, judgeAgain, refusalToStart, startRun, TooManyForFirstRun, type StartRunOptions } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, brief: "b" }));
const configFor = (n: number) => ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: people(n), goals: [{ id: "g", instruction: "Get in." }] });
const onUs: StartRunOptions = {
  budgetUsd: FIRST_RUN_ON_US.budgetUsd, agentModel: FIRST_RUN_ON_US.model, judgeModel: FIRST_RUN_ON_US.model, maxSteps: 30, replaySteps: 20, createdBy: "u1",
  provider: "openrouter", price: { promptUsdPerMtok: 1, completionUsdPerMtok: 1 }, paidBy: "trawler",
};
const usage = { model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0, steps: 1 };
const defect = { id: "f1", kind: "defect", goal: "g", title: "Broken save", observed: "500", reproduction: ["Open /x", "Click Save"], severity: "high" } as const;

async function clearQueue() {
  await sql`update jobs set status = 'cancelled', token_hash = null, lease_until = null, finished_at = now() where status in ('queued', 'leased')`.execute(t.db);
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where status in ('queued', 'running')`.execute(t.db);
}
beforeAll(clearQueue);
afterEach(clearQueue);

let orgs = 0;
async function workspace(persons = 2) {
  const org = `org-${++orgs}`;
  await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  const project = () => withOrg(t.db, org, (tx) => createProject(tx, org, configFor(persons), keys));
  return { org, project, start: async (projectId: string, options: StartRunOptions = onUs) => withOrg(t.db, org, (tx) => startRun(tx, org, projectId, keys, options)) };
}

const left = (org: string) => withOrg(t.db, org, (tx) => firstRunOnUsLeft(tx, org));
const runRow = (id: string) => sql<{ paid_by: string; status: string }>`select paid_by, status from runs where id = ${id}`.execute(t.db).then((r) => r.rows[0]!);

test("a workspace without a model key starts one run on Trawler, and the second is refused without leaving a run behind", async () => {
  const w = await workspace();
  expect(await left(w.org)).toBe(true);
  const first = await w.start(await w.project());
  expect(await runRow(first.id)).toMatchObject({ paid_by: "trawler", status: "queued" });
  expect(await left(w.org)).toBe(false);

  const other = await w.project();
  await expect(w.start(other)).rejects.toBeInstanceOf(FirstRunOnUsUsed);
  const runs = await sql<{ n: string }>`select count(*) as n from runs where org_id = ${w.org}`.execute(t.db);
  expect(runs.rows[0]!.n).toBe("1");
});

test("two Starts at once on two projects use the allowance once", async () => {
  const w = await workspace();
  const [a, b] = [await w.project(), await w.project()];
  const outcomes = await Promise.allSettled([w.start(a), w.start(b)]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === "rejected").map((o) => (o as PromiseRejectedResult).reason)).toEqual([expect.any(FirstRunOnUsUsed)]);
  expect((await sql<{ n: string }>`select count(*) as n from runs where org_id = ${w.org}`.execute(t.db)).rows[0]!.n).toBe("1");
});

test(`the first run on Trawler takes up to ${FIRST_RUN_ON_US.maxPeople} people`, async () => {
  const w = await workspace(FIRST_RUN_ON_US.maxPeople + 1);
  await expect(w.start(await w.project())).rejects.toBeInstanceOf(TooManyForFirstRun);
  expect(await left(w.org)).toBe(true);
  const fits = await workspace(FIRST_RUN_ON_US.maxPeople);
  await expect(fits.start(await fits.project())).resolves.toMatchObject({ number: 1 });
});

test("a run on Trawler that ends before its first model call gives the allowance back, and one stopped while its first call is still being answered keeps it used", async () => {
  const w = await workspace(1);
  const stopped = await w.start(await w.project());
  await withOrg(t.db, w.org, (tx) => cancelRun(tx, w.org, stopped.id, "stopped"));
  expect(await left(w.org)).toBe(true);

  const failed = await w.start(await w.project());
  const failedJob = (await claimJob(t.db, keys))!;
  expect(failedJob.runId).toBe(failed.id);
  await completeJob(t.db, failedJob.token, { usage, stoppedBy: "error", error: "the browser did not open" });
  expect(await runRow(failed.id)).toMatchObject({ status: "failed" });
  expect(await left(w.org)).toBe(true);

  await withOrg(t.db, w.org, (tx) => setModelKey(tx, w.org, { provider: "openrouter", key: `sk-or-v1-${"a".repeat(40)}` }, "u1", keys));
  const withAccount = ProjectConfigSchema.parse({ ...configFor(1), accounts: [{ ref: "acct", username: "ana@shop.test", password: "pw-1234567" }], personas: [{ id: "p0", name: "Person 0", brief: "b", accountRef: "acct" }] });
  const refusedProject = await withOrg(t.db, w.org, (tx) => createProject(tx, w.org, withAccount, keys));
  const refusedRun = await w.start(refusedProject);
  const check = (await claimJob(t.db, keys))!;
  expect(check.runId).toBe(refusedRun.id);
  await completeJob(t.db, check.token, { usage, stoppedBy: "finish", signIn: { outcome: "refused", observed: "Wrong password" } });
  expect(await runRow(refusedRun.id)).toMatchObject({ status: "cancelled" });
  expect(await left(w.org)).toBe(true);

  const used = await w.start(await w.project());
  const job = (await claimJob(t.db, keys))!;
  expect(job.runId).toBe(used.id);
  const call = await llmCallFor(t.db, job.token);
  expect(call.paidBy).toBe("trawler");
  await withOrg(t.db, w.org, (tx) => cancelRun(tx, w.org, used.id, "stopped"));
  expect(await left(w.org)).toBe(false);
  await recordLlmUsage(t.db, call, { model: FIRST_RUN_ON_US.model, inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
  expect((await sql<{ paid_by: string }>`select paid_by from llm_usage where run_id = ${used.id}`.execute(t.db)).rows).toEqual([{ paid_by: "trawler" }]);
});

test("Trawler's spending is not the workspace's: it neither counts toward the monthly budget nor is stopped by it, and removing the workspace key leaves the run going", async () => {
  const w = await workspace(1);
  await withOrg(t.db, w.org, (tx) => setModelKey(tx, w.org, { provider: "openrouter", key: `sk-or-v1-${"a".repeat(40)}` }, "u1", keys));
  const own = await w.project();
  await w.start(own, { ...onUs, paidBy: "workspace", budgetUsd: 2 });
  const ownJob = (await claimJob(t.db, keys))!;
  await recordLlmUsage(t.db, await llmCallFor(t.db, ownJob.token), { model: "m", inputTokens: 1, outputTokens: 1, costUsd: 1 });
  await completeJob(t.db, ownJob.token, { usage, stoppedBy: "finish" });
  await withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 1, "u1"));
  expect(await withOrg(t.db, w.org, (tx) => refusalToStart(tx, w.org, own))).not.toBeNull();

  const onTrawler = await w.start(await w.project());
  const job = (await claimJob(t.db, keys))!;
  expect(job.runId).toBe(onTrawler.id);
  const call = await llmCallFor(t.db, job.token);
  expect(call.remainingUsd).toBeCloseTo(FIRST_RUN_ON_US.budgetUsd, 6);
  await recordLlmUsage(t.db, call, { model: FIRST_RUN_ON_US.model, inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
  expect(await runRow(onTrawler.id)).toMatchObject({ status: "running" });
  expect(await withOrg(t.db, w.org, (tx) => monthlyBudget(tx, w.org))).toEqual({ limitUsd: 1, spentUsd: 1 });

  expect(await asSystem(t.db, (tx) => cancelLiveRuns(tx, w.org, "key_removed"))).toBe(0);
  expect(await runRow(onTrawler.id)).toMatchObject({ status: "running" });
});

test("a finished run on Trawler can be judged again without a workspace key", async () => {
  const w = await workspace(1);
  const run = await w.start(await w.project());
  const claim = async () => {
    const job = (await claimJob(t.db, keys))!;
    expect(job.runId).toBe(run.id);
    return job;
  };
  const session = await claim();
  await ingestEvents(t.db, session.token, [{ type: "finding", jobId: session.jobId, seq: 1, at: new Date().toISOString(), finding: defect } as unknown as RunEvent]);
  await completeJob(t.db, session.token, { usage, stoppedBy: "finish" });
  await completeJob(t.db, (await claim()).token, { usage, stoppedBy: "report", observation: { completed: true, observed: "500", blockedAt: null } });
  await completeJob(t.db, (await claim()).token, { usage, stoppedBy: "error", error: "No output generated." });
  expect(await runRow(run.id)).toMatchObject({ status: "succeeded" });
  await expect(withOrg(t.db, w.org, (tx) => judgeAgain(tx, w.org, run.id, "p0:f1", "u1", keys))).resolves.toBeUndefined();
});
