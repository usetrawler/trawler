import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ProjectConfigSchema, type RunEvent } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelRun, runSummary, startRun } from "./runs.ts";
import { claimJob, completeJob, ingestEvents, InvalidJobToken } from "./queue.ts";

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
    expect(replay).toMatchObject({ kind: "replay", finding: { id: "f1", title: "Broken save" }, accountRef: "ana", maxSteps: 20 });
    await completeJob(t.db, replay.token, { usage: usage(0.02), stoppedBy: "report", observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });

    const judge = (await claimJob(t.db, keys))!;
    expect(judge).toMatchObject({ kind: "judge", finding: { id: "f1" }, observation: { completed: true }, judgeModel: "m/judge" });
    seq = 0;
    await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "f1", verdict: "confirmed", observed: "Internal Server Error" })]);
    await completeJob(t.db, judge.token, { usage: usage(0.001), stoppedBy: "done" });

    expect(await claimJob(t.db, keys)).toBeNull();
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary).toMatchObject({ status: "succeeded", costUsd: 0.031 });
    expect(summary!.findings).toEqual([expect.objectContaining({ key: "f1", personaKey: "ana", verdict: "confirmed", replay: { completed: true, observed: "Internal Server Error", blockedAt: null } })]);
    expect(summary!.goals).toEqual([{ personaKey: "ana", goal: "g", status: "failed", note: "500" }]);
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
    seq = 0;
    const res = await ingestEvents(t.db, job.token, [ev({ type: "step", jobId: job.jobId, step: 1, tool: null, costUsd: 0.06 })]);
    expect(res).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0.06), stoppedBy: "budget" });
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
