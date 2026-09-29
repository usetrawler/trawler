import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ProjectConfigSchema, type RunEvent } from "@usetrawler/protocol";
import { setModelKey } from "../credentials/credentials.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { monthlyBudget, removeMonthlyBudget, setMonthlyBudget } from "./limits.ts";
import { claimJob, completeJob, ingestEvents, llmCallFor, LlmRefused, recordLlmUsage, stopRunsPastLimits, type JobAssignment } from "./queue.ts";
import { runView } from "./report.ts";
import { cancelRun, CannotJudgeAgain, judgeAgain, pauseProject, refusalToStart, resumeProject, RunInProgress, RunRefused, runSummary, startRun, WorkspaceBudgetSpent } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
afterEach(() => vi.unstubAllEnvs());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
  goals: [{ id: "g", instruction: "Get in." }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/agent", maxSteps: 30, replaySteps: 20, createdBy: "u1", price: { promptUsdPerMtok: 1, completionUsdPerMtok: 1 } };
const defect = { id: "f1", kind: "defect", goal: "g", title: "Broken save", observed: "500", reproduction: ["Open /x", "Click Save"], severity: "high" } as const;
const usage = (costUsd: number) => ({ model: "m/agent", inputTokens: 10, outputTokens: 5, costUsd, steps: 1 });

let seq = 0;
const ev = <T extends Omit<RunEvent, "seq" | "at">>(e: T) => ({ ...e, seq: ++seq, at: new Date().toISOString() }) as unknown as RunEvent;

let orgs = 0;
async function workspace() {
  const org = `org-${++orgs}`;
  await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await withOrg(t.db, org, (tx) => setModelKey(tx, org, { provider: "openrouter", key: `sk-or-v1-${"a".repeat(40)}` }, "u1", keys));
  const project = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
  return { org, project, start: () => withOrg(t.db, org, (tx) => startRun(tx, org, project, keys, options)) };
}

const statusOf = async (org: string, runId: string) => {
  const run = (await withOrg(t.db, org, (tx) => runSummary(tx, org, runId)))!;
  return { status: run.status, cancelReason: run.cancelReason };
};

async function claimFor(runId: string): Promise<JobAssignment> {
  const job = await claimJob(t.db, keys);
  expect(job?.runId).toBe(runId);
  return job!;
}

async function clearQueue() {
  await sql`update jobs set status = 'cancelled', token_hash = null, lease_until = null, finished_at = now() where status in ('queued', 'leased')`.execute(t.db);
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where status in ('queued', 'running')`.execute(t.db);
}

beforeAll(clearQueue);

describe("one active run per project", () => {
  test("a second start on a project with a live run names that run, and starts once it has ended", async () => {
    const w = await workspace();
    const first = await w.start();
    const refused = await w.start().then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(RunInProgress);
    expect((refused as RunInProgress).run).toEqual({ id: first.id, number: first.number });
    expect((refused as Error).message).toBe("Run 0001 is still going on this project. Wait for it to finish or stop it, then start again.");
    expect(await withOrg(t.db, w.org, (tx) => refusalToStart(tx, w.org, w.project))).toBeInstanceOf(RunInProgress);

    await withOrg(t.db, w.org, (tx) => cancelRun(tx, w.org, first.id, "stopped"));
    expect(await withOrg(t.db, w.org, (tx) => refusalToStart(tx, w.org, w.project))).toBeNull();
    expect((await w.start()).number).toBe(2);
    await clearQueue();
  });

  test("another project of the same workspace starts while the first one is live", async () => {
    const w = await workspace();
    await w.start();
    const second = await withOrg(t.db, w.org, (tx) => createProject(tx, w.org, config, keys));
    await expect(withOrg(t.db, w.org, (tx) => startRun(tx, w.org, second, keys, options))).resolves.toMatchObject({ number: 2 });
    await clearQueue();
  });

  test("the database refuses a second queued or running run of one project, even from a write that skips the check", async () => {
    const w = await workspace();
    const first = await w.start();
    const copy = sql`insert into runs (org_id, project_id, number, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by)
      select org_id, project_id, 99, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by from runs where id = ${first.id}`;
    await expect(copy.execute(t.db)).rejects.toThrow(/runs_one_active_per_project/);
    await withOrg(t.db, w.org, (tx) => cancelRun(tx, w.org, first.id, "stopped"));
    await expect(copy.execute(t.db)).resolves.toBeDefined();
    await clearQueue();
  });
});

describe("the run time limit", () => {
  test("a run past three hours stops on its next events round-trip, cancelled for the time limit, with its findings kept", async () => {
    const w = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "finding", jobId: job.jobId, finding: defect })])).toEqual({ cancel: false });
    await sql`update runs set started_at = now() - interval '2 hours 59 minutes' where id = ${run.id}`.execute(t.db);
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "still here" })])).toEqual({ cancel: false });

    await sql`update runs set started_at = now() - interval '3 hours 1 minute' where id = ${run.id}`.execute(t.db);
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "and now" })])).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "budget" });
    const summary = (await withOrg(t.db, w.org, (tx) => runSummary(tx, w.org, run.id)))!;
    expect({ status: summary.status, cancelReason: summary.cancelReason }).toEqual({ status: "cancelled", cancelReason: "time_limit" });
    expect(summary.findings.map((f) => f.title)).toEqual(["Broken save"]);
    expect(summary.jobs.map((j) => j.status)).toEqual(["succeeded", "cancelled"]);
    expect(runView(summary).headline).toBe("Stopped after 3 hours, the longest a run may take. What it found until then is kept.");
    expect(await claimJob(t.db, keys)).toBeNull();
  });

  test("a model call of a run past its time is refused and stops the run", async () => {
    const w = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    await sql`update runs set started_at = now() - interval '4 hours' where id = ${run.id}`.execute(t.db);
    await expect(llmCallFor(t.db, job.token)).rejects.toThrow(new LlmRefused("the run is no longer active"));
    expect(await statusOf(w.org, run.id)).toEqual({ status: "cancelled", cancelReason: "time_limit" });
  });

  test("a run past its time between two jobs gets no next job and stops", async () => {
    const w = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
    await sql`update runs set started_at = now() - interval '4 hours' where id = ${run.id}`.execute(t.db);
    expect(await claimJob(t.db, keys)).toBeNull();
    expect(await statusOf(w.org, run.id)).toEqual({ status: "cancelled", cancelReason: "time_limit" });
  });

  test("the sweep stops a run past its time that nothing reports on, and leaves a queued run and a younger one alone", async () => {
    const quiet = await workspace();
    const young = await workspace();
    const waiting = await workspace();
    const stale = await quiet.start();
    await claimFor(stale.id);
    const fresh = await young.start();
    await claimFor(fresh.id);
    const queued = await waiting.start();
    await sql`update runs set started_at = now() - interval '5 hours' where id = ${stale.id}`.execute(t.db);
    await sql`update runs set created_at = now() - interval '5 hours' where id = ${queued.id}`.execute(t.db);

    expect(await stopRunsPastLimits(t.db)).toBe(1);
    expect(await statusOf(quiet.org, stale.id)).toEqual({ status: "cancelled", cancelReason: "time_limit" });
    expect(await statusOf(young.org, fresh.id)).toEqual({ status: "running", cancelReason: null });
    expect(await statusOf(waiting.org, queued.id)).toEqual({ status: "queued", cancelReason: null });
    await clearQueue();
  });
});

describe("the monthly workspace budget", () => {
  test("a model call may spend only what is left of the month's budget, and the call that reaches it stops the run", async () => {
    const w = await workspace();
    await withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 1, "u1"));
    const run = await w.start();
    const job = await claimFor(run.id);
    const call = await llmCallFor(t.db, job.token);
    expect(call.remainingUsd).toBeCloseTo(1, 6);
    await recordLlmUsage(t.db, call, { model: "m/agent", inputTokens: 10, outputTokens: 5, costUsd: 0.7 });
    const next = await llmCallFor(t.db, job.token);
    expect(next.remainingUsd).toBeCloseTo(0.3, 6);
    await recordLlmUsage(t.db, next, { model: "m/agent", inputTokens: 10, outputTokens: 5, costUsd: 0.35 });

    expect(await statusOf(w.org, run.id)).toEqual({ status: "cancelled", cancelReason: "workspace_budget" });
    await expect(llmCallFor(t.db, job.token)).rejects.toThrow(LlmRefused);
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    const summary = (await withOrg(t.db, w.org, (tx) => runSummary(tx, w.org, run.id)))!;
    expect(runView(summary).headline).toBe("Stopped when the workspace reached its monthly budget. What it found until then is kept.");
  });

  test("a spent budget refuses a new run and says how much went where; raising it lets the run start", async () => {
    const w = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    await recordLlmUsage(t.db, await llmCallFor(t.db, job.token), { model: "m/agent", inputTokens: 10, outputTokens: 5, costUsd: 1.25 });
    await completeJob(t.db, job.token, { usage: usage(1.25), stoppedBy: "finish" });
    await withOrg(t.db, w.org, (tx) => cancelRun(tx, w.org, run.id, "stopped"));

    await withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 1, "u1"));
    const refused = await w.start().then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(WorkspaceBudgetSpent);
    const month = new Date().toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
    expect((refused as Error).message).toBe(`This workspace has spent its $1.00 monthly budget: $1.25 since ${month} 1. An owner or admin can raise it in Settings.`);

    await withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 5, "u2"));
    expect(await withOrg(t.db, w.org, (tx) => monthlyBudget(tx, w.org))).toEqual({ limitUsd: 5, spentUsd: 1.25 });
    await expect(w.start()).resolves.toMatchObject({ number: 2 });
    await clearQueue();
  });

  test("only this calendar month's spend of this workspace counts, and no budget means no limit", async () => {
    const w = await workspace();
    const other = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    const theirs = await other.start();
    await recordLlmUsage(t.db, await llmCallFor(t.db, job.token), { model: "m/agent", inputTokens: 1, outputTokens: 1, costUsd: 0.4 });
    await sql`insert into llm_usage (org_id, run_id, job_id, model, input_tokens, output_tokens, cost_usd, created_at)
      values (${w.org}, ${run.id}, ${job.jobId}, 'm/agent', 1, 1, 50, date_trunc('month', now(), 'UTC') - interval '1 second')`.execute(t.db);
    await sql`insert into llm_usage (org_id, run_id, job_id, model, input_tokens, output_tokens, cost_usd)
      select ${other.org}, id, (select id from jobs where run_id = ${theirs.id} limit 1), 'm/agent', 1, 1, 70 from runs where id = ${theirs.id}`.execute(t.db);

    expect(await withOrg(t.db, w.org, (tx) => monthlyBudget(tx, w.org))).toBeNull();
    await withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 10, "u1"));
    expect(await withOrg(t.db, w.org, (tx) => monthlyBudget(tx, w.org))).toEqual({ limitUsd: 10, spentUsd: 0.4 });
    await withOrg(t.db, w.org, (tx) => removeMonthlyBudget(tx, w.org));
    expect(await withOrg(t.db, w.org, (tx) => monthlyBudget(tx, w.org))).toBeNull();
    await clearQueue();
  });

  test("the database keeps a budget between $1 and $100,000, one per workspace, hidden from other workspaces", async () => {
    const w = await workspace();
    const other = await workspace();
    await expect(withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 0.5, "u1"))).rejects.toThrow(/workspace_budgets_monthly_usd_check/);
    await expect(withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 100_001, "u1"))).rejects.toThrow(/workspace_budgets_monthly_usd_check/);
    await withOrg(t.db, w.org, (tx) => setMonthlyBudget(tx, w.org, 20, "u1"));
    expect(await withOrg(t.db, other.org, (tx) => monthlyBudget(tx, w.org))).toBeNull();
    await expect(withOrg(t.db, other.org, (tx) => setMonthlyBudget(tx, w.org, 30, "u1"))).rejects.toThrow(/row-level security/);
  });
});

describe("pausing a project", () => {
  test("stops the project's live run, refuses a new one until it is resumed, and leaves other projects alone", async () => {
    const w = await workspace();
    const other = await withOrg(t.db, w.org, (tx) => createProject(tx, w.org, config, keys));
    const run = await w.start();
    const job = await claimFor(run.id);
    const elsewhere = await withOrg(t.db, w.org, (tx) => startRun(tx, w.org, other, keys, options));

    expect(await withOrg(t.db, w.org, (tx) => pauseProject(tx, w.org, w.project, "u2"))).toBe(1);
    expect(await statusOf(w.org, run.id)).toEqual({ status: "cancelled", cancelReason: "paused" });
    expect(await statusOf(w.org, elsewhere.id)).toEqual({ status: "queued", cancelReason: null });
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    const summary = (await withOrg(t.db, w.org, (tx) => runSummary(tx, w.org, run.id)))!;
    expect(runView(summary).headline).toBe("Stopped when runs on this project were paused.");

    const refused = await w.start().then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(RunRefused);
    expect((refused as Error).message).toBe("Runs on this project are paused. Resume them at the top of the project, then start again.");
    expect(await withOrg(t.db, w.org, (tx) => pauseProject(tx, w.org, w.project, "u3"))).toBe(0);
    const paused = await t.db.selectFrom("projects").select(["paused_by"]).where("id", "=", w.project).executeTakeFirstOrThrow();
    expect(paused.paused_by).toBe("u2");

    await withOrg(t.db, w.org, (tx) => resumeProject(tx, w.org, w.project));
    await expect(w.start()).resolves.toMatchObject({ number: 3 });
    await clearQueue();
  });

  test("a queued judge again of a paused project waits, and runs once the project is resumed", async () => {
    const w = await workspace();
    const run = await w.start();
    const ana = await claimFor(run.id);
    seq = 0;
    await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: defect })]);
    await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimFor(run.id)).token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimFor(run.id)).token, { usage: usage(0), stoppedBy: "report", observation: { completed: true, observed: "500", blockedAt: null } });
    await completeJob(t.db, (await claimFor(run.id)).token, { usage: usage(0), stoppedBy: "error", error: "No output generated." });
    await withOrg(t.db, w.org, (tx) => judgeAgain(tx, w.org, run.id, "ana:f1", "u2", keys));

    await withOrg(t.db, w.org, (tx) => pauseProject(tx, w.org, w.project, "u2"));
    expect(await claimJob(t.db, keys)).toBeNull();
    await expect(withOrg(t.db, w.org, (tx) => judgeAgain(tx, w.org, run.id, "ana:f1", "u2", keys))).rejects.toThrow(CannotJudgeAgain);
    await withOrg(t.db, w.org, (tx) => resumeProject(tx, w.org, w.project));
    expect(await claimJob(t.db, keys)).toMatchObject({ kind: "judge", runId: run.id });
    await clearQueue();
  });

  test("another workspace cannot pause or resume the project", async () => {
    const w = await workspace();
    const other = await workspace();
    await expect(withOrg(t.db, other.org, (tx) => pauseProject(tx, other.org, w.project, "u9"))).rejects.toThrow(/not found/i);
    await expect(withOrg(t.db, other.org, (tx) => resumeProject(tx, other.org, w.project))).rejects.toThrow(/not found/i);
    await expect(asSystem(t.db, (tx) => pauseProject(tx, other.org, w.project, "u9"))).rejects.toThrow(/not found/i);
    expect((await t.db.selectFrom("projects").select("paused_at").where("id", "=", w.project).executeTakeFirstOrThrow()).paused_at).toBeNull();
  });
});

describe("the global kill switch", () => {
  test("stops a live run within one events round-trip, hands out no jobs and refuses to start runs, until it is off", async () => {
    const w = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    const queued = await (await workspace()).start();

    vi.stubEnv("TRAWLER_HALT_RUNS", "1");
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    expect(await statusOf(w.org, run.id)).toEqual({ status: "cancelled", cancelReason: "halted" });
    expect(await claimJob(t.db, keys)).toBeNull();
    const refused = await w.start().then(() => null, (e: unknown) => e);
    expect((refused as Error).message).toBe("Trawler has paused hosted runs for now. Try again later, or run it on your own machine with the local runner.");
    expect(await stopRunsPastLimits(t.db)).toBe(1);
    expect((await t.db.selectFrom("runs").select(["status", "cancel_reason"]).where("id", "=", queued.id).executeTakeFirstOrThrow())).toEqual({ status: "cancelled", cancel_reason: "halted" });

    vi.stubEnv("TRAWLER_HALT_RUNS", "0");
    const again = await w.start();
    expect(await claimJob(t.db, keys)).toMatchObject({ runId: again.id });
    await clearQueue();
  });

  test("a model call of a live run is refused while it is on", async () => {
    const w = await workspace();
    const run = await w.start();
    const job = await claimFor(run.id);
    vi.stubEnv("TRAWLER_HALT_RUNS", "true");
    await expect(llmCallFor(t.db, job.token)).rejects.toThrow(LlmRefused);
    expect(await statusOf(w.org, run.id)).toEqual({ status: "cancelled", cancelReason: "halted" });
  });
});
