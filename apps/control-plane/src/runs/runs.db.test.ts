import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ProjectConfigSchema, type RunEvent } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { setModelKey } from "../credentials/credentials.ts";
import { createProject } from "../projects/projects.ts";
import { cancelRun, CannotJudgeAgain, judgeAgain, runSummary, startRun, type StartRunOptions } from "./runs.ts";
import { claimJob, completeJob, ingestEvents, InvalidJobToken, llmCallFor, LlmRefused, recordLlmUsage, releaseJob } from "./queue.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b", accountRef: "ana" }, { id: "lee", name: "Lee", brief: "b" }],
  goals: [{ id: "g", instruction: "Get in." }],
  accounts: [{ ref: "ana", username: "ana@acme.test", password: "hunter22-secret" }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
let project = "";
let other = "";

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  other = await withOrg(t.db, "org-b", (tx) => createProject(tx, "org-b", config, keys));
});

let seq = 0;
const ev = <T extends Omit<RunEvent, "seq" | "at">>(e: T) => ({ ...e, seq: ++seq, at: new Date().toISOString() }) as unknown as RunEvent;
const usage = (costUsd: number) => ({ model: "m/agent", inputTokens: 10, outputTokens: 5, costUsd, steps: 1 });
const defect = { id: "f1", kind: "defect", goal: "g", title: "Broken save", observed: "500", reproduction: ["Open /x", "Click Save"], severity: "high" } as const;

async function drain() {
  while (true) {
    const job = await claimJob(t.db, keys);
    if (!job) return;
    seq = 0;
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
  }
}

describe("a whole run", () => {
  test("roles, then a replay and a judge per defect, then the run finishes", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    expect(run.number).toBe(1);

    const first = (await claimJob(t.db, keys))!;
    expect(first).toMatchObject({ kind: "role_session", runId: run.id, personaKey: "ana", maxSteps: 30, agentModel: "m/agent" });
    expect(first.config.accounts).toEqual([{ ref: "ana", username: "ana@acme.test", password: "hunter22-secret" }]);
    expect(await claimJob(t.db, keys)).toBeNull();

    seq = 0;
    const events = [
      ev({ type: "job_started", jobId: first.jobId, kind: "role_session" }),
      ev({ type: "step", jobId: first.jobId, step: 1, tool: "browser_snapshot", costUsd: 0.01 }),
      ev({ type: "finding", jobId: first.jobId, finding: defect }),
      ev({ type: "goal_status", jobId: first.jobId, outcome: { goal: "g", status: "failed", note: "500" } }),
    ];
    expect(await ingestEvents(t.db, first.token, events)).toEqual({ cancel: false });
    expect(await ingestEvents(t.db, first.token, events)).toEqual({ cancel: false });
    await completeJob(t.db, first.token, { usage: usage(0.01), stoppedBy: "finish" });
    await completeJob(t.db, first.token, { usage: usage(0.01), stoppedBy: "finish" });

    const second = (await claimJob(t.db, keys))!;
    expect(second).toMatchObject({ kind: "role_session", personaKey: "lee" });
    await completeJob(t.db, second.token, { usage: usage(0), stoppedBy: "finish" });

    const replay = (await claimJob(t.db, keys))!;
    expect(replay).toMatchObject({ kind: "replay", finding: { id: "ana:f1", title: "Broken save" }, accountRef: "ana", maxSteps: 20 });
    await completeJob(t.db, replay.token, { usage: usage(0.02), stoppedBy: "report", observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });

    const judge = (await claimJob(t.db, keys))!;
    expect(judge).toMatchObject({ kind: "judge", finding: { id: "ana:f1" }, observation: { completed: true }, judgeModel: "m/judge" });
    seq = 0;
    await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "confirmed", observed: "Internal Server Error" })]);
    await completeJob(t.db, judge.token, { usage: usage(0.001), stoppedBy: "done" });

    expect(await claimJob(t.db, keys)).toBeNull();
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary).toMatchObject({ status: "succeeded", costUsd: 0 });
    expect(summary!.findings).toEqual([expect.objectContaining({ key: "ana:f1", personaKey: "ana", verdict: "confirmed", replay: { completed: true, observed: "Internal Server Error", blockedAt: null } })]);
    expect(summary!.goals).toEqual([{ personaKey: "ana", goal: "g", status: "failed", note: "500" }]);
    expect(summary!.personas).toEqual([{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee" }]);
    expect(summary!.goalTexts).toEqual([{ id: "g", instruction: "Get in." }]);
    expect(summary!.activity.map((a) => [a.personaKey, a.text])).toEqual([
      [null, "Confirmed: Broken save"],
      ["ana", "Goal not reached: Get in."],
      ["ana", "Reported a defect: Broken save"],
    ]);
  });

  test("a defect whose replay wrote no report is not judged", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const first = (await claimJob(t.db, keys))!;
    seq = 0;
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: defect })]);
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimJob(t.db, keys))!.token, { usage: usage(0), stoppedBy: "finish" });
    const replay = (await claimJob(t.db, keys))!;
    await completeJob(t.db, replay.token, { usage: usage(0), stoppedBy: "error", observation: { completed: false, observed: "the replay session wrote no report", blockedAt: null } });
    expect(await claimJob(t.db, keys)).toBeNull();
  });
});

describe("safety", () => {
  test("an unknown or stolen token is refused", async () => {
    await expect(ingestEvents(t.db, "not-a-token", [])).rejects.toBeInstanceOf(InvalidJobToken);
    await expect(completeJob(t.db, "not-a-token", { usage: usage(0), stoppedBy: "finish" })).rejects.toBeInstanceOf(InvalidJobToken);
  });

  test("events for another job are refused", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    seq = 0;
    await expect(ingestEvents(t.db, job.token, [ev({ type: "note", jobId: "someone-else", text: "x" })])).rejects.toThrow(/another job/);
    await drain();
  });

  test("spending the budget stops the run and cancels what is left", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, budgetUsd: 0.05 }));
    const job = (await claimJob(t.db, keys))!;
    const call = await llmCallFor(t.db, job.token);
    expect(call.remainingUsd).toBeCloseTo(0.05, 6);
    await recordLlmUsage(t.db, call, { model: "m/agent", inputTokens: 1000, outputTokens: 10, costUsd: 0.06 });
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    seq = 0;
    const res = await ingestEvents(t.db, job.token, [ev({ type: "step", jobId: job.jobId, step: 1, tool: null, costUsd: 0.06 })]);
    expect(res).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0.06), stoppedBy: "budget" });
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.costUsd).toBeCloseTo(0.06, 6);
    expect(await claimJob(t.db, keys)).toBeNull();
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.status).toBe("stopped_budget");
  });

  test("a cancelled run hands out no more jobs and tells the runner to stop", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id));
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "error", error: "cancelled" });
    expect(await claimJob(t.db, keys)).toBeNull();
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.status).toBe("cancelled");
  });

  test("two claimers never get two jobs of the same run", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const claims = await Promise.all([claimJob(t.db, keys), claimJob(t.db, keys), claimJob(t.db, keys)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await drain();
  });

  test("while one claimer is mid-claim on a run, nobody else takes another job of that run", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const holder = new pg.Client({ connectionString: t.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM runs WHERE id = $1 FOR UPDATE", [run.id]);
      await holder.query("SELECT 1 FROM jobs WHERE run_id = $1 AND position = 0 FOR UPDATE", [run.id]);
      expect(await claimJob(t.db, keys)).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    await drain();
  });

  test("another organisation cannot see or cancel the run, or start one on a foreign project", async () => {
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    expect(await withOrg(t.db, "org-b", (tx) => runSummary(tx, "org-b", run.id))).toBeNull();
    await expect(withOrg(t.db, "org-b", (tx) => cancelRun(tx, "org-b", run.id))).rejects.toThrow(/not found/);
    await expect(withOrg(t.db, "org-b", (tx) => startRun(tx, "org-b", project, keys, options))).rejects.toThrow(/not found/);
    void other;
    await drain();
  });

  test("the stored snapshot carries no secrets", async () => {
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const { rows } = await sql<{ snap: unknown }>`select config_snapshot as snap from runs where id = ${run.id}`.execute(t.db);
    expect(JSON.stringify(rows[0]!.snap)).not.toContain("hunter22-secret");
    await drain();
  });
});

describe("review round 1", () => {
  test("two personas may use the same finding id; both findings survive", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    for (const title of ["Ana bug", "Lee bug"]) {
      const job = (await claimJob(t.db, keys))!;
      seq = 0;
      await ingestEvents(t.db, job.token, [ev({ type: "finding", jobId: job.jobId, finding: { ...defect, title } })]);
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
    }
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary!.findings.map((f) => [f.key, f.title])).toEqual([["ana:f1", "Ana bug"], ["lee:f1", "Lee bug"]]);
    await drain();
  });

  test("the database refuses a second leased job in one run", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    await claimJob(t.db, keys);
    await expect(sql`update jobs set status = 'leased' where run_id = ${run.id} and status = 'queued'`.execute(t.db)).rejects.toThrow(/duplicate key|unique/);
    await drain();
  });

  test("an expired lease no longer works and the run moves on", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const stale = (await claimJob(t.db, keys))!;
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${stale.jobId}`.execute(t.db);
    await expect(ingestEvents(t.db, stale.token, [])).rejects.toBeInstanceOf(InvalidJobToken);
    const next = (await claimJob(t.db, keys))!;
    expect(next).toMatchObject({ runId: run.id, personaKey: "lee" });
    const { rows } = await sql<{ status: string; error: string }>`select status, error from jobs where id = ${stale.jobId}`.execute(t.db);
    expect(rows[0]).toMatchObject({ status: "failed" });
    await drain();
  });

  test("invalid events are refused as a whole and never poison later batches", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    seq = 0;
    const bad = [ev({ type: "finding", jobId: job.jobId, finding: { ...defect, id: "x".repeat(101) } })];
    await expect(ingestEvents(t.db, job.token, bad)).rejects.toThrow();
    await expect(ingestEvents(t.db, job.token, [ev({ type: "step", jobId: job.jobId, step: 1, tool: null, costUsd: 1e9 })])).rejects.toThrow();
    await expect(ingestEvents(t.db, job.token, [ev({ type: "finding", jobId: job.jobId, finding: { ...defect, reproduction: ["only one"] } })])).rejects.toThrow();
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "fine" })])).toEqual({ cancel: false });
    await drain();
  });

  test("a job that cannot be prepared fails instead of blocking everyone's queue", async () => {
    await drain();
    await sql`insert into organization (id, name, slug, "createdAt") values ('org-z', 'z', 'z', now())`.execute(t.db);
    const zProject = await withOrg(t.db, "org-z", (tx) => createProject(tx, "org-z", config, keys));
    const broken = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    await sql`update runs set config_snapshot = '{"broken": true}' where id = ${broken.id}`.execute(t.db);
    const healthy = await withOrg(t.db, "org-z", (tx) => startRun(tx, "org-z", zProject, keys, options));
    const claimed = await claimJob(t.db, keys);
    const again = claimed ?? (await claimJob(t.db, keys));
    expect(again?.runId).toBe(healthy.id);
    const { rows } = await sql<{ status: string }>`select status from jobs where run_id = ${broken.id} order by position limit 1`.execute(t.db);
    expect(rows[0]!.status).toBe("failed");
    await drain();
  });

  test("events after a cancel are not projected", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id));
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "finding", jobId: job.jobId, finding: defect })])).toEqual({ cancel: true });
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.findings).toEqual([]);
    await drain();
  });
});

describe("review round 2", () => {
  test("a long persona key and finding id still get their replay", async () => {
    await drain();
    const longConfig = ProjectConfigSchema.parse({ ...config, personas: [{ id: "p".repeat(60), name: "P", brief: "b" }], accounts: [] });
    const longProject = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", longConfig, keys));
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", longProject, keys, options));
    const role = (await claimJob(t.db, keys))!;
    seq = 0;
    await ingestEvents(t.db, role.token, [ev({ type: "finding", jobId: role.jobId, finding: { ...defect, id: "f".repeat(100) } })]);
    await completeJob(t.db, role.token, { usage: usage(0), stoppedBy: "finish" });
    const replay = (await claimJob(t.db, keys))!;
    expect(replay).toMatchObject({ kind: "replay", finding: { id: `${"p".repeat(60)}:${"f".repeat(100)}` } });
    await drain();
  });

  test("an expired lease in a cancelled run plans nothing new", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const ana = (await claimJob(t.db, keys))!;
    seq = 0;
    await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: defect })]);
    await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
    const lee = (await claimJob(t.db, keys))!;
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id));
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${lee.jobId}`.execute(t.db);
    await claimJob(t.db, keys);
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary!.jobs.map((j) => j.status)).not.toContain("queued");
    await drain();
  });

  test("only proxied model calls count toward the cost; what a runner reports never does", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    seq = 0;
    await ingestEvents(t.db, job.token, [ev({ type: "step", jobId: job.jobId, step: 1, tool: null, costUsd: 0.4 })]);
    await recordLlmUsage(t.db, await llmCallFor(t.db, job.token), { model: "m/agent", inputTokens: 5000, outputTokens: 100, costUsd: 0.012 });
    await completeJob(t.db, job.token, { usage: usage(3), stoppedBy: "finish" });
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary!.costUsd).toBeCloseTo(0.012, 6);
    const { rows } = await sql<{ model: string; input_tokens: number; cost_usd: string }>`select model, input_tokens, cost_usd from llm_usage where run_id = ${run.id}`.execute(t.db);
    expect(rows).toEqual([{ model: "m/agent", input_tokens: 5000, cost_usd: "0.012000" }]);
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    await drain();
  });

  test("a model call needs a live job of an active run and names the run's models", async () => {
    await drain();
    await expect(llmCallFor(t.db, "x".repeat(43))).rejects.toBeInstanceOf(InvalidJobToken);
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    expect(await llmCallFor(t.db, job.token)).toMatchObject({ orgId: "org-a", runId: run.id, jobId: job.jobId, models: ["m/agent", "m/judge"] });
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id));
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    await drain();
  });
});

test("a finished job's token cannot raise the run's cost afterwards", async () => {
  await drain();
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
  const job = (await claimJob(t.db, keys))!;
  await completeJob(t.db, job.token, { usage: usage(0.1), stoppedBy: "finish" });
  await completeJob(t.db, job.token, { usage: usage(4.9), stoppedBy: "finish" });
  expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.costUsd).toBe(0);
  await drain();
});

test("a queued run never pairs its snapshot's username with a different account's password", async () => {
  await drain();
  const own = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", own, keys, options));
  await sql`update target_accounts set username = 'someone-else@acme.test' where project_id = ${own} and ref = 'ana'`.execute(t.db);
  const job = (await claimJob(t.db, keys))!;
  expect(job.config.accounts).toEqual([]);
  expect(job.config.personas.find((p) => p.id === "ana")!.accountRef).toBeUndefined();
  await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
});

describe("judge again", () => {
  const openRouterKey = { provider: "openrouter" as const, key: `sk-or-v1-${"a".repeat(40)}` };
  const summaryOf = (runId: string) => withOrg(t.db, "org-a", async (tx) => (await runSummary(tx, "org-a", runId))!);
  const again = (runId: string, findingKey = "ana:f1") => withOrg(t.db, "org-a", (tx) => judgeAgain(tx, "org-a", runId, findingKey, "u2", keys));
  const refused = async (attempt: Promise<unknown>, reason: RegExp) => {
    const err = await attempt.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CannotJudgeAgain);
    expect((err as Error).message).toMatch(reason);
  };
  const queuedJudges = async (runId: string) => (await sql<{ n: number }>`select count(*)::int as n from jobs where run_id = ${runId} and kind = 'judge' and status = 'queued'`.execute(t.db)).rows[0]!.n;

  async function runUpToTheJudge(over: Partial<StartRunOptions> = {}) {
    await drain();
    await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", openRouterKey, "u1", keys));
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, ...over }));
    const ana = (await claimJob(t.db, keys))!;
    seq = 0;
    await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: defect })]);
    await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimJob(t.db, keys))!.token, { usage: usage(0), stoppedBy: "finish" });
    const replay = (await claimJob(t.db, keys))!;
    await completeJob(t.db, replay.token, { usage: usage(0), stoppedBy: "report", observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });
    return { run, judge: (await claimJob(t.db, keys))! };
  }

  async function runWithFailedJudge(over: Partial<StartRunOptions> = {}) {
    const { run, judge } = await runUpToTheJudge(over);
    seq = 0;
    await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "inconclusive", observed: "Internal Server Error" })]);
    await completeJob(t.db, judge.token, { usage: usage(0), stoppedBy: "error", error: "No output generated." });
    return run;
  }

  test("a failed judge runs again on the finished run, which stays finished", async () => {
    const run = await runWithFailedJudge();
    const before = await summaryOf(run.id);
    expect(before.status).toBe("succeeded");

    await again(run.id);
    expect((await summaryOf(run.id)).findings[0]!.verdict).toBeNull();
    expect(await queuedJudges(run.id)).toBe(1);
    const job = (await claimJob(t.db, keys))!;
    expect(job).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1", title: "Broken save" }, observation: { completed: true, observed: "Internal Server Error" }, judgeModel: "m/judge" });
    expect(job.budgetUsd).toBeCloseTo(2, 6);
    expect((await summaryOf(run.id)).status).toBe("succeeded");

    const call = await llmCallFor(t.db, job.token);
    await recordLlmUsage(t.db, call, { model: "m/judge", inputTokens: 900, outputTokens: 40, costUsd: 0.002 });
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "verdict", jobId: job.jobId, findingId: "ana:f1", verdict: "confirmed", observed: "Internal Server Error" })])).toEqual({ cancel: false });
    await completeJob(t.db, job.token, { usage: usage(0.002), stoppedBy: "done" });

    const after = await summaryOf(run.id);
    expect(after).toMatchObject({ status: "succeeded", finishedAt: before.finishedAt });
    expect(after.costUsd).toBeCloseTo(0.002, 6);
    expect(after.findings[0]!.verdict).toBe("confirmed");
    expect(after.jobs.filter((j) => j.kind === "judge").map((j) => j.status)).toEqual(["failed", "succeeded"]);
    const { rows } = await sql<{ requested_by: string | null }>`select requested_by from jobs where run_id = ${run.id} and kind = 'judge' order by position`.execute(t.db);
    expect(rows.map((r) => r.requested_by)).toEqual([null, "u2"]);
    expect(await claimJob(t.db, keys)).toBeNull();
  });

  test("a judge that is judged again and fails again can be asked once more", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    const first = (await claimJob(t.db, keys))!;
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "error", error: "No output generated." });
    await again(run.id);
    expect(await claimJob(t.db, keys)).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1" } });
    await drain();
  });

  test("is refused while the run is live, and once the judge has given a verdict", async () => {
    const { run, judge } = await runUpToTheJudge();
    await sql`update jobs set status = 'failed' where id = ${judge.jobId}`.execute(t.db);
    await refused(again(run.id), /still going/);
    await sql`update jobs set status = 'leased' where id = ${judge.jobId}`.execute(t.db);
    seq = 0;
    await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "refuted", observed: "It worked" })]);
    await completeJob(t.db, judge.token, { usage: usage(0), stoppedBy: "done" });
    expect((await summaryOf(run.id)).status).toBe("succeeded");
    await refused(again(run.id), /gave no verdict/);
    await refused(again(run.id, "ana:nope"), /gave no verdict/);
  });

  test("is refused while a judge again is pending", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    await refused(again(run.id), /already/);
    await claimJob(t.db, keys);
    await refused(again(run.id), /already/);
    await drain();
  });

  test("is refused when the run has spent its cap", async () => {
    const run = await runWithFailedJudge();
    await sql`update runs set cost_usd = budget_usd where id = ${run.id}`.execute(t.db);
    await refused(again(run.id), /cap/);
    const capped = await runWithFailedJudge();
    await sql`update runs set token_cap = 1000, tokens_used = 1000 where id = ${capped.id}`.execute(t.db);
    await refused(again(capped.id), /cap/);
  });

  test("is refused when the workspace key is gone or belongs to another provider", async () => {
    const run = await runWithFailedJudge();
    await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "openai", key: `sk-proj-${"b".repeat(40)}` }, "u1", keys));
    await refused(again(run.id), /key/);
    await sql`delete from credentials where org_id = 'org-a'`.execute(t.db);
    await refused(again(run.id), /key/);
    expect(await queuedJudges(run.id)).toBe(0);
  });

  test("a judge again that the proxy refused can be judged again once the problem is fixed", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    const refusedJob = (await claimJob(t.db, keys))!;
    await completeJob(t.db, refusedJob.token, { usage: usage(0), stoppedBy: "error", error: "the provider account behind the workspace key is out of credits" });
    const summary = await summaryOf(run.id);
    expect(summary.jobs.filter((j) => j.kind === "judge").map((j) => [j.status, j.stopped_by, j.error, j.requested])).toEqual([
      ["failed", "error", "No output generated.", false],
      ["failed", "error", "the provider account behind the workspace key is out of credits", true],
    ]);
    await again(run.id);
    expect(await claimJob(t.db, keys)).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1" } });
    await drain();
  });

  test("an old inconclusive written when the proxy refused the judge can be judged again", async () => {
    const { run, judge } = await runUpToTheJudge();
    seq = 0;
    await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "inconclusive", observed: "x" })]);
    await completeJob(t.db, judge.token, { usage: usage(0), stoppedBy: "budget" });
    await again(run.id);
    expect(await queuedJudges(run.id)).toBe(1);
    await drain();
  });

  test("two clicks at once queue one judge again", async () => {
    const run = await runWithFailedJudge();
    await Promise.all([sql`select pg_sleep(0.05)`.execute(t.db), sql`select pg_sleep(0.05)`.execute(t.db)]);
    const outcomes = await Promise.allSettled([again(run.id), again(run.id)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason as Error).message).toMatch(/already/);
    expect(await queuedJudges(run.id)).toBe(1);
    await drain();
  });

  test("is refused when a custom endpoint moved to another address", async () => {
    const run = await runWithFailedJudge({ provider: "custom", providerBaseUrl: "https://llm.example.com/v1", tokenCap: 1_000_000 });
    await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "custom", key: `sk-${"c".repeat(40)}`, baseUrl: "https://other.example.com/v1" }, "u1", keys));
    await refused(again(run.id), /key/);
    expect(await queuedJudges(run.id)).toBe(0);
    await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "custom", key: `sk-${"c".repeat(40)}`, baseUrl: "https://llm.example.com/v1" }, "u1", keys));
    await again(run.id);
    expect(await queuedJudges(run.id)).toBe(1);
    await drain();
  });

  test("another organisation cannot judge the run again", async () => {
    const run = await runWithFailedJudge();
    await refused(withOrg(t.db, "org-b", (tx) => judgeAgain(tx, "org-b", run.id, "ana:f1", "u9", keys)), /not found/);
    expect(await queuedJudges(run.id)).toBe(0);
  });

  test("a runner that stops during a judge again hands it back to the queue", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    const job = (await claimJob(t.db, keys))!;
    await releaseJob(t.db, { jobId: job.jobId, runId: run.id, token: job.token });
    expect(await claimJob(t.db, keys)).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1" } });
    expect((await summaryOf(run.id)).status).toBe("succeeded");
    await drain();
  });

  test("a judge again whose runner stops answering fails without reopening the run", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    const job = (await claimJob(t.db, keys))!;
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${job.jobId}`.execute(t.db);
    expect(await claimJob(t.db, keys)).toBeNull();
    const summary = await summaryOf(run.id);
    expect(summary.status).toBe("succeeded");
    expect(summary.jobs.filter((j) => j.kind === "judge").map((j) => j.status)).toEqual(["failed", "failed"]);
  });

  test("a judge again stops when it spends the rest of the cap", async () => {
    const run = await runWithFailedJudge({ budgetUsd: 0.1 });
    await again(run.id);
    const job = (await claimJob(t.db, keys))!;
    await recordLlmUsage(t.db, await llmCallFor(t.db, job.token), { model: "m/judge", inputTokens: 900, outputTokens: 40, costUsd: 0.2 });
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0.2), stoppedBy: "budget" });
    expect((await summaryOf(run.id)).status).toBe("succeeded");
  });

  test("stopping a run still stops the judge that was running in it", async () => {
    const { run, judge } = await runUpToTheJudge();
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id));
    seq = 0;
    expect(await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "confirmed", observed: "x" })])).toEqual({ cancel: true });
    await expect(llmCallFor(t.db, judge.token)).rejects.toBeInstanceOf(LlmRefused);
    expect((await summaryOf(run.id)).findings[0]!.verdict).toBeNull();
    await completeJob(t.db, judge.token, { usage: usage(0), stoppedBy: "budget" });
  });
});
