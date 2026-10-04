import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ProjectConfigSchema, type RunEvent } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { setModelKey } from "../credentials/credentials.ts";
import { createProject, firstPlan, loadProjectConfig, ProjectNotFound, replacePlan } from "../projects/projects.ts";
import { cancelLiveRuns, cancelRun, CannotJudgeAgain, judgeAgain, NeedsAccount, RunNotFound, runSummary, startRun, type StartRunOptions } from "./runs.ts";
import { dismissFinding, undoDismissal } from "./dismissals.ts";
import { runView } from "./report.ts";
import { workspaceRuns } from "../projects/overview.ts";
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

async function claimPastChecks() {
  let job = await claimJob(t.db, keys);
  while (job?.kind === "account_check") {
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "report", signIn: { outcome: "signed_in", observed: "Signed in." } });
    job = await claimJob(t.db, keys);
  }
  return job;
}

async function claimAndFinishAll() {
  while (true) {
    const job = await claimPastChecks();
    if (!job) return;
    seq = 0;
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
  }
}

async function drain() {
  while (true) {
    const job = await claimPastChecks();
    if (!job) break;
    seq = 0;
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
  }
  await sql`update jobs set status = 'cancelled', token_hash = null, lease_until = null, finished_at = now() where status in ('queued', 'leased') and run_id in (select id from runs where status in ('queued', 'running'))`.execute(t.db);
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where status in ('queued', 'running')`.execute(t.db);
}

describe("a whole run", () => {
  test("roles, then a replay and a judge per defect, then the run finishes", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    expect(run.number).toBe(1);

    const first = (await claimPastChecks())!;
    expect(first).toMatchObject({ kind: "role_session", runId: run.id, personaKey: "ana", maxSteps: 30, agentModel: "m/agent" });
    expect(first.config.accounts).toEqual([{ ref: "ana", username: "ana@acme.test", password: "hunter22-secret" }]);
    expect(await claimPastChecks()).toBeNull();

    seq = 0;
    const events = [
      ev({ type: "job_started", jobId: first.jobId, kind: "role_session" }),
      ev({ type: "step", jobId: first.jobId, step: 1, tool: "browser_snapshot", costUsd: 0.01 }),
      ev({ type: "finding", jobId: first.jobId, finding: { ...defect, url: "https://app.acme.test/x?step=2", quote: "I saved and it just broke." } }),
      ev({ type: "goal_status", jobId: first.jobId, outcome: { goal: "g", status: "failed", note: "500" } }),
    ];
    expect(await ingestEvents(t.db, first.token, events)).toEqual({ cancel: false });
    expect(await ingestEvents(t.db, first.token, events)).toEqual({ cancel: false });
    await completeJob(t.db, first.token, { usage: usage(0.01), stoppedBy: "finish" });
    await completeJob(t.db, first.token, { usage: usage(0.01), stoppedBy: "finish" });

    const second = (await claimPastChecks())!;
    expect(second).toMatchObject({ kind: "role_session", personaKey: "lee" });
    await completeJob(t.db, second.token, { usage: usage(0), stoppedBy: "finish" });

    const stored = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.findings[0]!;
    expect({ url: stored.url, quote: stored.quote }).toEqual({ url: "https://app.acme.test/x?step=2", quote: "I saved and it just broke." });

    const replay = (await claimPastChecks())!;
    expect(replay).toMatchObject({ kind: "replay", finding: { id: "ana:f1", title: "Broken save" }, accountRef: "ana", maxSteps: 20 });
    expect(Object.keys(replay.finding!)).not.toEqual(expect.arrayContaining(["url"]));
    expect(Object.keys(replay.finding!)).not.toEqual(expect.arrayContaining(["quote"]));
    await completeJob(t.db, replay.token, { usage: usage(0.02), stoppedBy: "report", observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });

    const judge = (await claimPastChecks())!;
    expect(judge).toMatchObject({ kind: "judge", finding: { id: "ana:f1" }, observation: { completed: true }, judgeModel: "m/judge" });
    expect(JSON.stringify(judge.finding)).not.toMatch(/acme\.test\/x|just broke/);
    seq = 0;
    await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "confirmed", observed: "Internal Server Error" })]);
    await completeJob(t.db, judge.token, { usage: usage(0.001), stoppedBy: "done" });

    expect(await claimPastChecks()).toBeNull();
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary).toMatchObject({ status: "succeeded", costUsd: 0 });
    expect(summary!.findings).toEqual([expect.objectContaining({ key: "ana:f1", personaKey: "ana", verdict: "confirmed", replay: { completed: true, observed: "Internal Server Error", blockedAt: null } })]);
    expect(summary!.goals).toEqual([{ personaKey: "ana", goal: "g", status: "failed", note: "500" }]);
    expect(summary!.personas).toEqual([{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee" }]);
    expect(summary!.goalTexts).toEqual([{ id: "g", instruction: "Get in.", personaId: "ana" }, { id: "g-lee", instruction: "Get in.", personaId: "lee" }]);
    expect(summary!.activity.map((a) => [a.personaKey, a.text])).toEqual([
      [null, "Confirmed: Broken save"],
      ["ana", "Goal not reached: Get in."],
      ["ana", "Reported a defect: Broken save"],
    ]);
  });

  test("a defect whose replay wrote no report is not judged", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const first = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: defect })]);
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimPastChecks())!.token, { usage: usage(0), stoppedBy: "finish" });
    const replay = (await claimPastChecks())!;
    await completeJob(t.db, replay.token, { usage: usage(0), stoppedBy: "error", observation: { completed: false, observed: "the replay session wrote no report", blockedAt: null } });
    expect(await claimPastChecks()).toBeNull();
  });

  async function rolesReport(found: Record<string, ReadonlyArray<Omit<typeof defect, "id" | "title" | "observed" | "reproduction"> & { id: string; title: string; observed: string; reproduction: readonly string[] }>>) {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    for (let turn = 0; turn < 2; turn++) {
      const role = (await claimPastChecks())!;
      seq = 0;
      const findings = found[role.personaKey!] ?? [];
      if (findings.length) await ingestEvents(t.db, role.token, findings.map((finding) => ev({ type: "finding", jobId: role.jobId, finding })));
      await completeJob(t.db, role.token, { usage: usage(0), stoppedBy: "finish" });
    }
    return run;
  }

  const saveBroken = { ana: [defect, { ...defect, id: "f2", title: "Totals are wrong", reproduction: ["Open /y", "Look at the total"] }], lee: [{ ...defect, title: "Save does nothing", observed: "Nothing happened" }] };

  describe("friction on a goal the person did not reach", () => {
    const balance = { id: "f1", kind: "friction", goal: "g", title: "Balance has no history", observed: "The new account shows $515.50 but its activity says No transactions found", reproduction: ["Open /accounts", "Open the new account"], severity: "medium" } as const;
    const noBalances = { id: "f1", kind: "friction", goal: "g", title: "Confirmation shows no balances", observed: "The transfer confirmation lists no balances", reproduction: ["Open /transfer", "Click Transfer"], severity: "low" } as const;
    const oneStep = { id: "f2", kind: "friction", goal: "g", title: "The menu is hard to find", observed: "Took a while to find it", reproduction: ["Looked around"], severity: "low" } as const;

    async function rolesWithGoals(verdictFor: string) {
      await drain();
      await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "openrouter", key: `sk-or-v1-${"a".repeat(40)}` }, "u1", keys));
      const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
      const ana = (await claimPastChecks())!;
      seq = 0;
      await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: balance }), ev({ type: "finding", jobId: ana.jobId, finding: oneStep }), ev({ type: "goal_status", jobId: ana.jobId, outcome: { goal: "g", status: "failed", note: "the balance makes no sense" } })]);
      await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
      const lee = (await claimPastChecks())!;
      seq = 0;
      await ingestEvents(t.db, lee.token, [ev({ type: "finding", jobId: lee.jobId, finding: noBalances }), ev({ type: "goal_status", jobId: lee.jobId, outcome: { goal: "g", status: "reached", note: "no balances shown" } })]);
      await completeJob(t.db, lee.token, { usage: usage(0), stoppedBy: "finish" });
      const seen: string[] = [];
      for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
        seen.push(`${job.kind} ${job.finding?.id}`);
        if (job.kind === "replay") expect(job.finding).toMatchObject({ kind: "defect", title: "Balance has no history" });
        seq = 0;
        if (job.kind === "judge" && verdictFor === "none") {
          await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "error", error: "No output generated." });
          continue;
        }
        if (job.kind === "judge") await ingestEvents(t.db, job.token, [ev({ type: "verdict", jobId: job.jobId, findingId: job.finding!.id, verdict: verdictFor, observed: "No transactions found" })]);
        await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: job.kind === "judge" ? "done" : "report", observation: { completed: true, observed: "No transactions found", blockedAt: null } });
      }
      expect(seen).toEqual(["replay ana:f1", "judge ana:f1"]);
      return (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    }

    const judgedAgain = async (runId: string, verdict: string) => {
      await withOrg(t.db, "org-a", (tx) => judgeAgain(tx, "org-a", runId, "ana:f1", "u2", keys));
      const job = (await claimJob(t.db, keys))!;
      expect(job).toMatchObject({ kind: "judge", finding: { id: "ana:f1" } });
      seq = 0;
      await ingestEvents(t.db, job.token, [ev({ type: "verdict", jobId: job.jobId, findingId: "ana:f1", verdict, observed: "No transactions found" })]);
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "done" });
      return runView((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", runId)))!);
    };
    const keys_ = (items: Array<{ key: string }>) => items.map((f) => f.key);
    const historyOf = async (runId: string) => (await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: project }))).runs.find((r) => r.id === runId)!;

    test("whose judge gave no verdict can be judged again, and moves to Confirmed when it is confirmed", async () => {
      const summary = await rolesWithGoals("none");
      const before = runView(summary);
      expect(keys_(before.report.couldNotJudge)).toEqual(["ana:f1"]);
      expect(before.report.couldNotJudge[0]).toMatchObject({ action: "judge_again", replayedAsDefect: true, reason: "Model error: No output generated." });
      expect(keys_(before.report.friction)).toEqual(["ana:f2", "lee:f1"]);
      expect([before.reported, before.headline]).toEqual([0, "No defects found."]);
      expect(await historyOf(summary.id)).toMatchObject({ confirmed: 0, unchecked: false });

      const after = await judgedAgain(summary.id, "confirmed");
      expect(keys_(after.report.confirmed)).toEqual(["ana:f1"]);
      expect(after.report.confirmed[0]!.replayedAsDefect).toBe(true);
      expect(after.report.couldNotJudge).toEqual([]);
      expect([after.reported, after.headline]).toEqual([1, "1 defect confirmed by replay."]);
      expect(await historyOf(summary.id)).toMatchObject({ confirmed: 1, unchecked: false });
    });

    test("judged again and not borne out, it goes back to Friction", async () => {
      for (const verdict of ["inconclusive", "refuted"]) {
        const summary = await rolesWithGoals("none");
        const after = await judgedAgain(summary.id, verdict);
        expect(keys_(after.report.friction)).toEqual(["ana:f1", "ana:f2", "lee:f1"]);
        expect(after.report.friction[0]!.replayedAsDefect).toBe(false);
        expect([after.report.couldNotJudge, after.report.inconclusive, after.report.refuted]).toEqual([[], [], []]);
        expect(after.reported).toBe(0);
      }
    });

    test("is replayed and judged, and once confirmed it is a defect that says the person filed it as friction", async () => {
      const summary = await rolesWithGoals("confirmed");
      expect(summary.findings.map((f) => [f.key, f.kind, f.filedAs, f.verdict])).toEqual([["ana:f1", "defect", "friction", "confirmed"], ["ana:f2", "friction", null, null], ["lee:f1", "friction", null, null]]);
    });

    test("stays friction when the replay does not bear it out", async () => {
      for (const verdict of ["refuted", "inconclusive"]) {
        const summary = await rolesWithGoals(verdict);
        expect(summary.findings.map((f) => [f.key, f.kind, f.filedAs, f.verdict])).toEqual([["ana:f1", "friction", "friction", verdict], ["ana:f2", "friction", null, null], ["lee:f1", "friction", null, null]]);
      }
    });

    test("is replayed on its own, never grouped with the defects people reported", async () => {
      await drain();
      await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
      const ana = (await claimPastChecks())!;
      seq = 0;
      await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: defect }), ev({ type: "finding", jobId: ana.jobId, finding: { ...balance, id: "f2" } }), ev({ type: "goal_status", jobId: ana.jobId, outcome: { goal: "g", status: "failed", note: "" } })]);
      await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
      const lee = (await claimPastChecks())!;
      seq = 0;
      await ingestEvents(t.db, lee.token, [ev({ type: "finding", jobId: lee.jobId, finding: { ...defect, title: "Save does nothing" } })]);
      await completeJob(t.db, lee.token, { usage: usage(0), stoppedBy: "finish" });
      const group = (await claimPastChecks())!;
      expect(group.kind).toBe("group");
      expect(group.defects!.map((d) => d.key)).toEqual(["ana:f1", "lee:f1"]);
      await completeJob(t.db, group.token, { usage: usage(0), stoppedBy: "done", groups: [["ana:f1", "lee:f1"]] });
      const replayed: string[] = [];
      for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
        if (job.kind === "replay") replayed.push(job.finding!.id);
        await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "report", observation: { completed: true, observed: "Same", blockedAt: null } });
      }
      expect(replayed).toEqual(["ana:f1", "ana:f2"]);
    });
  });

  test("a replay stopped by bot protection is judged, not handed to the next report, and the run tells which check stopped whom", async () => {
    const run = await rolesReport(saveBroken);
    const group = (await claimPastChecks())!;
    await completeJob(t.db, group.token, { usage: usage(0), stoppedBy: "done", groups: [["ana:f1", "lee:f1"], ["ana:f2"]] });
    const stopped = { completed: false, observed: "The replay could not go on: Cloudflare's bot-protection check at https://app.acme.test/x stopped it.", blockedAt: null, botProtection: { vendor: "Cloudflare", url: "https://app.acme.test/x" } };
    const seen: string[] = [];
    for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
      seen.push(`${job.kind} ${job.finding!.id}`);
      if (job.kind === "judge" && job.finding!.id === "ana:f1") expect(job.observation).toEqual(stopped);
      seq = 0;
      if (job.kind === "replay" && job.finding!.id === "ana:f1") await ingestEvents(t.db, job.token, [ev({ type: "bot_protection", jobId: job.jobId, vendor: "Cloudflare", url: "https://app.acme.test/x" })]);
      if (job.kind === "judge") await ingestEvents(t.db, job.token, [ev({ type: "verdict", jobId: job.jobId, findingId: job.finding!.id, verdict: "inconclusive", observed: stopped.observed })]);
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: job.kind === "judge" ? "done" : "report", observation: job.finding!.id === "ana:f1" ? stopped : { completed: true, observed: "Totals add up", blockedAt: null } });
    }
    expect(seen).toEqual(["replay ana:f1", "replay ana:f2", "judge ana:f1", "judge ana:f2"]);
    const summary = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    expect(summary.findings.find((f) => f.key === "ana:f1")).toMatchObject({ verdict: "inconclusive", replay: stopped });
    expect(summary.botProtection).toEqual({ vendor: "Cloudflare", url: "https://app.acme.test/x" });
  });

  test("a run that met no bot protection says nothing about it", async () => {
    const run = await rolesReport({});
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.botProtection).toBeNull();
  });

  test("once several defects are in, one group job sees them all, and only the first report of each group is replayed; the rest point at it", async () => {
    const run = await rolesReport(saveBroken);
    const group = (await claimPastChecks())!;
    expect(group).toMatchObject({ kind: "group", judgeModel: "m/judge" });
    expect(group.defects).toEqual([
      { key: "ana:f1", person: "Ana", goal: "Get in.", title: "Broken save", observed: "500", reproduction: ["Open /x", "Click Save"] },
      { key: "ana:f2", person: "Ana", goal: "Get in.", title: "Totals are wrong", observed: "500", reproduction: ["Open /y", "Look at the total"] },
      { key: "lee:f1", person: "Lee", goal: "Get in.", title: "Save does nothing", observed: "Nothing happened", reproduction: ["Open /x", "Click Save"] },
    ]);
    await completeJob(t.db, group.token, { usage: usage(0.001), stoppedBy: "done", groups: [["lee:f1", "ana:f1"], ["ana:f2", "made-up"]] });

    const replayed: string[] = [];
    for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
      if (job.kind === "replay") replayed.push(job.finding!.id);
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "report", observation: { completed: true, observed: "Same", blockedAt: null } });
    }
    expect(replayed).toEqual(["ana:f1", "ana:f2"]);
    const summary = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    expect(summary.status).toBe("succeeded");
    expect(summary.findings.map((f) => [f.key, f.sameAs])).toEqual([["ana:f1", null], ["ana:f2", null], ["lee:f1", "ana:f1"]]);
  });

  test("a group job that fails or is never answered leaves every defect on its own, and each is replayed", async () => {
    for (const end of ["failed", "failed with groups", "expired"] as const) {
      await rolesReport(saveBroken);
      const group = (await claimPastChecks())!;
      expect(group.kind).toBe("group");
      if (end === "failed") await completeJob(t.db, group.token, { usage: usage(0), stoppedBy: "error", error: "the model did not group the defects (2 tries)" });
      else if (end === "failed with groups") await completeJob(t.db, group.token, { usage: usage(0), stoppedBy: "error", error: "the runner could not report events", groups: [["ana:f1", "ana:f2", "lee:f1"]] });
      else await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${group.jobId}`.execute(t.db);
      const replayed: string[] = [];
      for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
        if (job.kind === "replay") replayed.push(job.finding!.id);
        await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "error", observation: { completed: false, observed: "no report", blockedAt: null } });
      }
      expect(replayed).toEqual(["ana:f1", "ana:f2", "lee:f1"]);
    }
  });

  test("a group job handed back by a stopping runner is grouped by the next runner", async () => {
    await rolesReport(saveBroken);
    const group = (await claimPastChecks())!;
    await releaseJob(t.db, group);
    const again = (await claimPastChecks())!;
    expect(again).toMatchObject({ kind: "group", jobId: group.jobId });
    await completeJob(t.db, again.token, { usage: usage(0), stoppedBy: "done", groups: [["ana:f1", "lee:f1"]] });
    expect(await claimPastChecks()).toMatchObject({ kind: "replay", finding: { id: "ana:f1" } });
  });

  test("when the first report's steps cannot be followed, the next report of its group is replayed in its place and becomes the one shown", async () => {
    const run = await rolesReport(saveBroken);
    const group = (await claimPastChecks())!;
    await completeJob(t.db, group.token, { usage: usage(0), stoppedBy: "done", groups: [["ana:f1", "lee:f1"], ["ana:f2"]] });
    const lost = { completed: false, observed: "the replay session wrote no report", blockedAt: null };
    const seen: string[] = [];
    for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
      seen.push(`${job.kind} ${job.finding!.id}`);
      const followed = job.kind === "replay" && job.finding!.id === "lee:f1";
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: job.kind === "judge" ? "done" : "report", observation: followed ? { completed: true, observed: "Nothing saved", blockedAt: null } : lost });
    }
    expect(seen).toEqual(["replay ana:f1", "replay ana:f2", "replay lee:f1", "judge lee:f1"]);
    const summary = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    expect(summary.findings.map((f) => [f.key, f.sameAs])).toEqual([["ana:f1", "lee:f1"], ["ana:f2", null], ["lee:f1", null]]);
  });

  test("when no report of a group can be followed, each is replayed once and the run ends; a replay that failed on an error hands over to nobody", async () => {
    const three = { ...saveBroken, ana: saveBroken.ana.slice(0, 1), priya: [] };
    const lost = { completed: false, observed: "the replay session wrote no report", blockedAt: null };
    for (const stoppedBy of ["report", "error"] as const) {
      const run = await rolesReport({ ...three, lee: [...saveBroken.lee, { ...defect, id: "f2", title: "Save ignored" }] });
      const group = (await claimPastChecks())!;
      await completeJob(t.db, group.token, { usage: usage(0), stoppedBy: "done", groups: [["ana:f1", "lee:f1", "lee:f2"]] });
      const seen: string[] = [];
      for (let job = await claimPastChecks(); job && seen.length < 10; job = await claimPastChecks()) {
        seen.push(`${job.kind} ${job.finding!.id}`);
        await completeJob(t.db, job.token, { usage: usage(0), stoppedBy, observation: lost });
      }
      expect(seen).toEqual(stoppedBy === "report" ? ["replay ana:f1", "replay lee:f1", "replay lee:f2"] : ["replay ana:f1"]);
      expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.status).toBe("succeeded");
    }
  });

  test("a single defect goes straight to its replay, with no group job", async () => {
    await rolesReport({ lee: [defect] });
    expect(await claimPastChecks()).toMatchObject({ kind: "replay", finding: { id: "lee:f1" } });
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
    const job = (await claimPastChecks())!;
    seq = 0;
    await expect(ingestEvents(t.db, job.token, [ev({ type: "note", jobId: "someone-else", text: "x" })])).rejects.toThrow(/another job/);
    await drain();
  });

  test("spending the budget stops the run and cancels what is left", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, budgetUsd: 0.05 }));
    const job = (await claimPastChecks())!;
    const call = await llmCallFor(t.db, job.token);
    expect(call.remainingUsd).toBeCloseTo(0.05, 6);
    await recordLlmUsage(t.db, call, { model: "m/agent", inputTokens: 1000, outputTokens: 10, costUsd: 0.06 });
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    seq = 0;
    const res = await ingestEvents(t.db, job.token, [ev({ type: "step", jobId: job.jobId, step: 1, tool: null, costUsd: 0.06 })]);
    expect(res).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0.06), stoppedBy: "budget" });
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.costUsd).toBeCloseTo(0.06, 6);
    expect(await claimPastChecks()).toBeNull();
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.status).toBe("stopped_budget");
  });

  test("a cancelled run hands out no more jobs and tells the runner to stop", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimPastChecks())!;
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id, "stopped"));
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "error", error: "cancelled" });
    expect(await claimPastChecks()).toBeNull();
    expect(await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id))).toMatchObject({ status: "cancelled", cancelReason: "stopped" });
  });

  test("stopping a workspace's live runs cancels the queued and the going ones, and leaves finished runs and other workspaces alone, even without row security", async () => {
    await drain();
    const org = "org-live";
    await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
    const own = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
    const second = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
    const finished = await withOrg(t.db, org, (tx) => startRun(tx, org, own, keys, options));
    await claimAndFinishAll();
    const going = await withOrg(t.db, org, (tx) => startRun(tx, org, own, keys, options));
    const claimed = (await claimPastChecks())!;
    expect(claimed.runId).toBe(going.id);
    const waiting = await withOrg(t.db, org, (tx) => startRun(tx, org, second, keys, options));
    const elsewhere = await withOrg(t.db, "org-b", (tx) => startRun(tx, "org-b", other, keys, options));
    const status = async (orgId: string, id: string) => {
      const run = (await withOrg(t.db, orgId, (tx) => runSummary(tx, orgId, id)))!;
      return { status: run.status, cancelReason: run.cancelReason };
    };
    const before = await status(org, finished.id);

    expect(await asSystem(t.db, (tx) => cancelLiveRuns(tx, org, "key_removed"))).toBe(2);

    expect([await status(org, finished.id), await status(org, going.id), await status(org, waiting.id), await status("org-b", elsewhere.id)]).toEqual([
      before,
      { status: "cancelled", cancelReason: "key_removed" },
      { status: "cancelled", cancelReason: "key_removed" },
      { status: "queued", cancelReason: null },
    ]);
    const jobs = await t.db.selectFrom("jobs").select(["run_id", "status"]).where("run_id", "in", [going.id, waiting.id]).execute();
    expect(jobs.filter((j) => j.run_id === waiting.id).every((j) => j.status === "cancelled")).toBe(true);
    expect(jobs.filter((j) => j.run_id === going.id).map((j) => j.status).sort()).toEqual(["cancelled", "leased", "succeeded"]);
    seq = 0;
    expect(await ingestEvents(t.db, claimed.token, [ev({ type: "note", jobId: claimed.jobId, text: "x" })])).toEqual({ cancel: true });
    await completeJob(t.db, claimed.token, { usage: usage(0), stoppedBy: "error", error: "cancelled" });
    await withOrg(t.db, "org-b", (tx) => cancelRun(tx, "org-b", elsewhere.id, "stopped"));
    await drain();
  });

  test("the database keeps a cancel reason only on a cancelled run, and only one it knows", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    await expect(sql`update runs set cancel_reason = 'stopped' where id = ${run.id}`.execute(t.db)).rejects.toThrow(/runs_cancel_reason_only_when_cancelled/);
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id, "stopped"));
    await expect(sql`update runs set cancel_reason = 'someone' where id = ${run.id}`.execute(t.db)).rejects.toThrow(/runs_cancel_reason_check/);
    await expect(sql`update runs set status = 'running' where id = ${run.id}`.execute(t.db)).rejects.toThrow(/runs_cancel_reason_only_when_cancelled/);
    expect(await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id))).toMatchObject({ status: "cancelled", cancelReason: "stopped" });
  });

  test("two claimers never get two jobs of the same run", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const claims = await Promise.all([claimPastChecks(), claimPastChecks(), claimPastChecks()]);
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
      expect(await claimPastChecks()).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    await drain();
  });

  test("another organisation cannot see or cancel the run, or start one on a foreign project", async () => {
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    expect(await withOrg(t.db, "org-b", (tx) => runSummary(tx, "org-b", run.id))).toBeNull();
    await expect(withOrg(t.db, "org-b", (tx) => cancelRun(tx, "org-b", run.id, "stopped"))).rejects.toThrow(RunNotFound);
    await expect(withOrg(t.db, "org-b", (tx) => startRun(tx, "org-b", project, keys, options))).rejects.toThrow(ProjectNotFound);
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
      const job = (await claimPastChecks())!;
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
    await claimPastChecks();
    await expect(sql`update jobs set status = 'leased' where run_id = ${run.id} and status = 'queued'`.execute(t.db)).rejects.toThrow(/duplicate key|unique/);
    await drain();
  });

  test("an expired lease no longer works and the run moves on", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const stale = (await claimPastChecks())!;
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${stale.jobId}`.execute(t.db);
    await expect(ingestEvents(t.db, stale.token, [])).rejects.toBeInstanceOf(InvalidJobToken);
    const next = (await claimPastChecks())!;
    expect(next).toMatchObject({ runId: run.id, personaKey: "lee" });
    const { rows } = await sql<{ status: string; error: string }>`select status, error from jobs where id = ${stale.jobId}`.execute(t.db);
    expect(rows[0]).toMatchObject({ status: "failed" });
    await drain();
  });

  test("invalid events are refused as a whole and never poison later batches", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimPastChecks())!;
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
    const claimed = await claimPastChecks();
    const again = claimed ?? (await claimPastChecks());
    expect(again?.runId).toBe(healthy.id);
    const { rows } = await sql<{ status: string }>`select status from jobs where run_id = ${broken.id} order by position limit 1`.execute(t.db);
    expect(rows[0]!.status).toBe("failed");
    await drain();
  });

  test("events after a cancel are not projected", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimPastChecks())!;
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id, "stopped"));
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
    const role = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, role.token, [ev({ type: "finding", jobId: role.jobId, finding: { ...defect, id: "f".repeat(100) } })]);
    await completeJob(t.db, role.token, { usage: usage(0), stoppedBy: "finish" });
    const replay = (await claimPastChecks())!;
    expect(replay).toMatchObject({ kind: "replay", finding: { id: `${"p".repeat(60)}:${"f".repeat(100)}` } });
    await drain();
  });

  test("an expired lease in a cancelled run plans nothing new", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const ana = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: defect })]);
    await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
    const lee = (await claimPastChecks())!;
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id, "stopped"));
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${lee.jobId}`.execute(t.db);
    await claimPastChecks();
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary!.jobs.map((j) => j.status)).not.toContain("queued");
    await drain();
  });

  test("only proxied model calls count toward the cost; what a runner reports never does", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimPastChecks())!;
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
    const job = (await claimPastChecks())!;
    expect(await llmCallFor(t.db, job.token)).toMatchObject({ orgId: "org-a", runId: run.id, jobId: job.jobId, models: ["m/agent", "m/judge"] });
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id, "stopped"));
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    await drain();
  });
});

test("a finished job's token cannot raise the run's cost afterwards", async () => {
  await drain();
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
  const job = (await claimPastChecks())!;
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
  const job = (await claimPastChecks())!;
  expect(job.config.accounts).toEqual([]);
  expect(job.config.personas.find((p) => p.id === "ana")!.accountRef).toBeUndefined();
  await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
});

test("a replay has no account when its person's account stopped being usable, like the session it replays", async () => {
  await drain();
  const own = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", own, keys, options));
  await sql`update target_accounts set username = 'someone-else@acme.test' where project_id = ${own} and ref = 'ana'`.execute(t.db);
  const session = (await claimPastChecks())!;
  expect(session).toMatchObject({ kind: "role_session", personaKey: "ana" });
  expect(session.config.personas.find((p) => p.id === "ana")!.accountRef).toBeUndefined();
  seq = 0;
  await ingestEvents(t.db, session.token, [ev({ type: "finding", jobId: session.jobId, finding: defect })]);
  await completeJob(t.db, session.token, { usage: usage(0), stoppedBy: "finish" });
  const lee = (await claimPastChecks())!;
  await completeJob(t.db, lee.token, { usage: usage(0), stoppedBy: "finish" });
  const replay = (await claimPastChecks())!;
  expect(replay).toMatchObject({ kind: "replay", finding: { id: "ana:f1" } });
  expect(replay.accountRef).toBeUndefined();
  await drain();
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
    const ana = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, ana.token, [ev({ type: "finding", jobId: ana.jobId, finding: defect })]);
    await completeJob(t.db, ana.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimPastChecks())!.token, { usage: usage(0), stoppedBy: "finish" });
    const replay = (await claimPastChecks())!;
    await completeJob(t.db, replay.token, { usage: usage(0), stoppedBy: "report", observation: { completed: true, observed: "Internal Server Error", blockedAt: null } });
    return { run, judge: (await claimPastChecks())! };
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
    const job = (await claimPastChecks())!;
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
    expect(await claimPastChecks()).toBeNull();
  });

  test("a judge that is judged again and fails again can be asked once more", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    const first = (await claimPastChecks())!;
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "error", error: "No output generated." });
    await again(run.id);
    expect(await claimPastChecks()).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1" } });
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
    await claimPastChecks();
    await refused(again(run.id), /already/);
    await drain();
  });

  test("is refused for a defect marked not a bug, and allowed again once that is undone", async () => {
    const run = await runWithFailedJudge();
    await withOrg(t.db, "org-a", (tx) => dismissFinding(tx, "org-a", run.id, "ana:f1", "Intended.", "u1"));
    await refused(again(run.id), /marked not a bug/);
    await withOrg(t.db, "org-a", (tx) => undoDismissal(tx, "org-a", run.id, "ana:f1"));
    await again(run.id);
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
    const refusedJob = (await claimPastChecks())!;
    await completeJob(t.db, refusedJob.token, { usage: usage(0), stoppedBy: "error", error: "the provider account behind the workspace key is out of credits" });
    const summary = await summaryOf(run.id);
    expect(summary.jobs.filter((j) => j.kind === "judge").map((j) => [j.status, j.stopped_by, j.error, j.requested])).toEqual([
      ["failed", "error", "No output generated.", false],
      ["failed", "error", "the provider account behind the workspace key is out of credits", true],
    ]);
    await again(run.id);
    expect(await claimPastChecks()).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1" } });
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
    const job = (await claimPastChecks())!;
    await releaseJob(t.db, { jobId: job.jobId, runId: run.id, token: job.token });
    expect(await claimPastChecks()).toMatchObject({ runId: run.id, kind: "judge", finding: { id: "ana:f1" } });
    expect((await summaryOf(run.id)).status).toBe("succeeded");
    await drain();
  });

  test("a judge again whose runner stops answering fails without reopening the run", async () => {
    const run = await runWithFailedJudge();
    await again(run.id);
    const job = (await claimPastChecks())!;
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${job.jobId}`.execute(t.db);
    expect(await claimPastChecks()).toBeNull();
    const summary = await summaryOf(run.id);
    expect(summary.status).toBe("succeeded");
    expect(summary.jobs.filter((j) => j.kind === "judge").map((j) => j.status)).toEqual(["failed", "failed"]);
  });

  test("a judge again stops when it spends the rest of the cap", async () => {
    const run = await runWithFailedJudge({ budgetUsd: 0.1 });
    await again(run.id);
    const job = (await claimPastChecks())!;
    await recordLlmUsage(t.db, await llmCallFor(t.db, job.token), { model: "m/judge", inputTokens: 900, outputTokens: 40, costUsd: 0.2 });
    await expect(llmCallFor(t.db, job.token)).rejects.toBeInstanceOf(LlmRefused);
    seq = 0;
    expect(await ingestEvents(t.db, job.token, [ev({ type: "note", jobId: job.jobId, text: "x" })])).toEqual({ cancel: true });
    await completeJob(t.db, job.token, { usage: usage(0.2), stoppedBy: "budget" });
    expect((await summaryOf(run.id)).status).toBe("succeeded");
  });

  test("stopping a run still stops the judge that was running in it", async () => {
    const { run, judge } = await runUpToTheJudge();
    await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", run.id, "stopped"));
    seq = 0;
    expect(await ingestEvents(t.db, judge.token, [ev({ type: "verdict", jobId: judge.jobId, findingId: "ana:f1", verdict: "confirmed", observed: "x" })])).toEqual({ cancel: true });
    await expect(llmCallFor(t.db, judge.token)).rejects.toBeInstanceOf(LlmRefused);
    expect((await summaryOf(run.id)).findings[0]!.verdict).toBeNull();
    await completeJob(t.db, judge.token, { usage: usage(0), stoppedBy: "budget" });
  });
});

describe("screenshots", () => {
  async function screenshot(job: { jobId: string }, run: string, findingKey: string | null, state: { id?: string; at?: string; stored?: boolean; discarded?: boolean } = {}) {
    const row = await sql<{ id: string }>`insert into artifacts (id, org_id, run_id, job_id, finding_key, kind, content_type, size_bytes, storage_key, created_at, stored_at, discarded_at)
      select k.id, 'org-a', ${run}::uuid, ${job.jobId}::uuid, ${findingKey}, 'screenshot', 'image/png', 10, ${`orgs/org-a/runs/${run}/`} || k.id || '.png',
        ${state.at ?? "2026-09-01T10:05:00Z"}::timestamptz, ${state.stored === false ? null : sql`now()`}, ${state.discarded ? sql`now()` : null}
      from (select coalesce(${state.id ?? null}::uuid, gen_random_uuid()) as id) k returning id`.execute(t.db);
    return row.rows[0]!.id;
  }

  test("a finding carries the latest stored screenshot from its session and from its replay; a pending or discarded one, or one for another finding, never", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const session = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, session.token, [
      ev({ type: "job_started", jobId: session.jobId, kind: "role_session" }),
      ev({ type: "finding", jobId: session.jobId, finding: defect }),
      ev({ type: "finding", jobId: session.jobId, finding: { ...defect, id: "f2", title: "Broken load" } }),
    ]);
    const reported = await screenshot(session, run.id, "ana:f1", { id: "00000000-0000-4000-8000-000000000001", at: "2026-09-01T10:02:00Z" });
    await screenshot(session, run.id, "ana:f1", { id: "ffffffff-ffff-4fff-bfff-ffffffffffff", at: "2026-09-01T10:01:00Z" });
    await screenshot(session, run.id, "ana:f1", { at: "2026-09-01T10:03:00Z", stored: false });
    await screenshot(session, run.id, "ana:f1", { at: "2026-09-01T10:04:00Z", discarded: true });
    await completeJob(t.db, session.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimPastChecks())!.token, { usage: usage(0), stoppedBy: "finish" });
    await completeJob(t.db, (await claimPastChecks())!.token, { usage: usage(0), stoppedBy: "done", groups: [["ana:f1"], ["ana:f2"]] });
    const replay = (await claimPastChecks())!;
    expect(replay.finding?.id).toBe("ana:f1");
    const replayed = await screenshot(replay, run.id, "ana:f1", { id: "00000000-0000-4000-8000-000000000003", at: "2026-09-01T10:06:00Z" });
    await screenshot(replay, run.id, "ana:f1", { id: "00000000-0000-4000-8000-000000000002", at: "2026-09-01T10:06:00Z" });

    const findings = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.findings;
    expect(findings.map((f) => [f.key, f.screenshots])).toEqual([
      ["ana:f1", { reported, replayed }],
      ["ana:f2", { reported: null, replayed: null }],
    ]);
    await drain();

    const next = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const again = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, again.token, [ev({ type: "job_started", jobId: again.jobId, kind: "role_session" }), ev({ type: "finding", jobId: again.jobId, finding: defect })]);
    const own = await screenshot(again, next.id, "ana:f1");
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", next.id)))!.findings.map((f) => f.screenshots)).toEqual([{ reported: own, replayed: null }]);
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.findings[0]!.screenshots).toEqual({ reported, replayed });
    await drain();
  });
});

test("a run does not start while a person who has to sign in has no account, and starts once they have one", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys, { signsIn: ["lee"] }));
  const refused = withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", id, keys, options));
  await expect(refused).rejects.toBeInstanceOf(NeedsAccount);
  await expect(refused).rejects.toThrow("Lee needs a test account to sign in.");
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from runs where project_id = ${id}`.execute(t.db);
  expect(rows[0]!.n).toBe(0);
  const plan = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: plan.personas.map((p) => ({ ...p, accountRef: "ana" })), goals: plan.goals }));
  await expect(withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", id, keys, options))).resolves.toMatchObject({ id: expect.any(String) });
});

describe("a team session", () => {
  const team = ProjectConfigSchema.parse({
    name: "Pitches", targetUrl: "https://pitches.test/",
    personas: [{ id: "priya", name: "Priya", brief: "b" }, { id: "marco", name: "Marco", brief: "b", accountRef: "admin" }],
    goals: [
      { id: "submit", instruction: "Submit a pitch.", personaId: "priya" },
      { id: "review", instruction: "Accept the pitch Priya submitted.", personaId: "marco" },
      { id: "decision", instruction: "See the decision on your pitch.", personaId: "priya" },
    ],
    accounts: [{ ref: "admin", username: "admin@pitches.test", password: "admin-pass-1" }],
  });

  test("people take turns in the plan's order, each turn gets its goals and what happened before, and results stay with each person", async () => {
    await drain();
    const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", team, keys));
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", id, keys, options));

    const first = (await claimPastChecks())!;
    expect(first).toMatchObject({ kind: "role_session", personaKey: "priya", goalIds: ["submit"], turn: 0, story: [] });
    expect(first.signUpSeed).toMatch(/^[\w-]{20,}$/);
    seq = 0;
    await ingestEvents(t.db, first.token, [
      ev({ type: "note", jobId: first.jobId, text: "Submitted pitch EcoLoop." }),
      ev({ type: "finding", jobId: first.jobId, finding: { ...defect, id: "f1", goal: "submit" } }),
      ev({ type: "goal_status", jobId: first.jobId, outcome: { goal: "submit", status: "reached", note: "EcoLoop is in review." } }),
    ]);
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "finish" });

    const second = (await claimPastChecks())!;
    expect(second).toMatchObject({ personaKey: "marco", goalIds: ["review"], turn: 1, signUpSeed: first.signUpSeed });
    expect(second.story).toEqual([
      { personaId: "priya", name: "Priya", text: "Submitted pitch EcoLoop." },
      { personaId: "priya", name: "Priya", goal: "Submit a pitch.", status: "reached", text: "EcoLoop is in review." },
    ]);
    seq = 0;
    await ingestEvents(t.db, second.token, [ev({ type: "goal_status", jobId: second.jobId, outcome: { goal: "review", status: "reached", note: "Accepted EcoLoop." } })]);
    await completeJob(t.db, second.token, { usage: usage(0), stoppedBy: "finish" });

    const third = (await claimPastChecks())!;
    expect(third).toMatchObject({ personaKey: "priya", goalIds: ["decision"], turn: 2 });
    expect(third.story!.map((e) => e.text)).toEqual(["Submitted pitch EcoLoop.", "EcoLoop is in review.", "Accepted EcoLoop."]);
    seq = 0;
    await ingestEvents(t.db, third.token, [
      ev({ type: "finding", jobId: third.jobId, finding: { ...defect, id: "t2f1", goal: "decision", title: "No decision shown" } }),
      ev({ type: "goal_status", jobId: third.jobId, outcome: { goal: "decision", status: "failed", note: "Nothing shown." } }),
    ]);
    await releaseJob(t.db, { jobId: third.jobId, runId: run.id, token: third.token });
    const again = (await claimPastChecks())!;
    expect(again).toMatchObject({ personaKey: "priya", goalIds: ["decision"], turn: 2 });
    let summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary!.goals.map((g) => [g.personaKey, g.goal])).toEqual([["marco", "review"], ["priya", "submit"]]);
    seq = 0;
    await ingestEvents(t.db, again.token, [
      ev({ type: "finding", jobId: again.jobId, finding: { ...defect, id: "t2f1", goal: "decision", title: "No decision shown" } }),
      ev({ type: "goal_status", jobId: again.jobId, outcome: { goal: "decision", status: "failed", note: "Nothing shown." } }),
    ]);
    await completeJob(t.db, again.token, { usage: usage(0), stoppedBy: "finish" });
    summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary!.findings.map((f) => [f.key, f.personaKey]).sort()).toEqual([["priya:f1", "priya"], ["priya:t2f1", "priya"]]);
    expect(summary!.goals.map((g) => [g.personaKey, g.goal, g.status])).toEqual([["marco", "review", "reached"], ["priya", "decision", "failed"], ["priya", "submit", "reached"]]);
    const done = await sql<{ seed: string | null }>`select sign_up_seed as seed from runs where id = ${run.id}`.execute(t.db);
    expect(done.rows[0]!.seed).toBeNull();
    await drain();
  });

  test("the sign-up seed is stored encrypted, not as the runner receives it", async () => {
    await drain();
    const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", team, keys));
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", id, keys, options));
    const job = (await claimPastChecks())!;
    const { rows } = await sql<{ seed: string }>`select sign_up_seed as seed from runs where id = ${run.id}`.execute(t.db);
    expect(rows[0]!.seed).not.toContain(job.signUpSeed!);
    expect(job.returning).toBe(false);
    await drain();
  });

  test("a run started before turns existed plays one session per person as it did", async () => {
    await drain();
    const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", team, keys));
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", id, keys, options));
    await sql`update runs set sign_up_seed = null where id = ${run.id}`.execute(t.db);
    const job = (await claimPastChecks())!;
    expect(job).toMatchObject({ kind: "role_session", personaKey: "priya" });
    expect(job.goalIds).toBeUndefined();
    expect(job.story).toBeUndefined();
    expect(job.signUpSeed).toBeUndefined();
    await drain();
  });
});

describe("account check", () => {
  test("each test account the plan uses is checked before anyone plays, and a refused one stops the run with who and why", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const check = (await claimJob(t.db, keys))!;
    expect(check).toMatchObject({ kind: "account_check", accountRef: "ana", maxSteps: 12 });
    expect(check.config.accounts.find((a) => a.ref === "ana")?.password).toBe("hunter22-secret");
    await completeJob(t.db, check.token, { usage: usage(0.002), stoppedBy: "report", signIn: { outcome: "refused", observed: "Username and password do not match" } });
    expect(await claimJob(t.db, keys)).toBeNull();
    const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
    expect(summary).toMatchObject({ status: "cancelled", cancelReason: "account_refused" });
    expect(summary!.jobs.filter((j) => j.kind === "role_session").every((j) => j.status === "cancelled")).toBe(true);
    expect(summary!.jobs.find((j) => j.kind === "account_check")).toMatchObject({ status: "failed", error: "The product refused the username and password of ana@acme.test: Username and password do not match" });
    const { rows } = await sql<{ seed: string | null }>`select sign_up_seed as seed from runs where id = ${run.id}`.execute(t.db);
    expect(rows[0]!.seed).toBeNull();
  });

  test("with two accounts both are checked before anyone plays, and the refused one is the one named", async () => {
    await drain();
    const two = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", ProjectConfigSchema.parse({
      ...config,
      personas: [...config.personas, { id: "max", name: "Max", brief: "b", accountRef: "max" }],
      accounts: [...config.accounts, { ref: "max", username: "max@acme.test", password: "max-secret-22" }],
    }), keys));
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", two, keys, options));
    const first = (await claimJob(t.db, keys))!;
    expect(first).toMatchObject({ kind: "account_check", accountRef: "ana" });
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "report", signIn: { outcome: "signed_in", observed: "Signed in." } });
    const second = (await claimJob(t.db, keys))!;
    expect(second).toMatchObject({ kind: "account_check", accountRef: "max" });
    await completeJob(t.db, second.token, { usage: usage(0), stoppedBy: "report", signIn: { outcome: "refused", observed: "Unknown user." } });
    const summary = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    expect(summary.status).toBe("cancelled");
    expect(summary.jobs.filter((j) => j.kind === "account_check").map((j) => [j.status, j.error])).toEqual([
      ["succeeded", null],
      ["failed", "The product refused the username and password of max@acme.test: Unknown user."],
    ]);
    expect(summary.jobs.filter((j) => j.kind === "role_session").every((j) => j.status === "cancelled")).toBe(true);
  });

  test("a check handed back is checked again, and a check whose lease runs out lets the people start", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const handed = (await claimJob(t.db, keys))!;
    await releaseJob(t.db, { jobId: handed.jobId, runId: run.id, token: handed.token });
    const again = (await claimJob(t.db, keys))!;
    expect(again).toMatchObject({ kind: "account_check", accountRef: "ana" });
    await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${again.jobId}`.execute(t.db);
    expect(await claimJob(t.db, keys)).toMatchObject({ runId: run.id, kind: "role_session" });
    expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.status).toBe("running");
    await drain();
  });

  test("an account that signs in, or a check that cannot tell, lets the people start", async () => {
    await drain();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const check = (await claimJob(t.db, keys))!;
    await completeJob(t.db, check.token, { usage: usage(0), stoppedBy: "report", signIn: { outcome: "unclear", observed: "No sign-in form found." } });
    expect(await claimJob(t.db, keys)).toMatchObject({ kind: "role_session" });
    await drain();
  });
});

describe("steps per turn", () => {
  test("each turn may take steps for its own goals, up to the run's ceiling, and a run from before turns keeps its flat limit", async () => {
    await drain();
    const planned = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", ProjectConfigSchema.parse({
      name: "Steps", targetUrl: "https://app.acme.test/",
      personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
      goals: [
        { id: "g1", instruction: "One.", personaId: "ana" }, { id: "g2", instruction: "Two.", personaId: "ana" }, { id: "g3", instruction: "Three.", personaId: "ana" },
        { id: "g4", instruction: "Four.", personaId: "lee" },
        { id: "g5", instruction: "Five.", personaId: "ana" }, { id: "g6", instruction: "Six.", personaId: "ana" }, { id: "g7", instruction: "Seven.", personaId: "ana" },
        { id: "g8", instruction: "Eight.", personaId: "ana" }, { id: "g9", instruction: "Nine.", personaId: "ana" }, { id: "g10", instruction: "Ten.", personaId: "ana" },
      ],
    }), keys));
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", planned, keys, { ...options, maxSteps: 120 }));
    const steps: number[] = [];
    for (let job = await claimPastChecks(); job; job = await claimPastChecks()) {
      steps.push(job.maxSteps);
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "finish" });
    }
    expect(steps).toEqual([70, 30, 120]);

    const legacy = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", planned, keys, { ...options, maxSteps: 60 }));
    await sql`update runs set sign_up_seed = null where id = ${legacy.id}`.execute(t.db);
    expect((await claimPastChecks())!.maxSteps).toBe(60);
    await drain();
  });
});

describe("a finding sent again", () => {
  test("a finding its job sends again keeps the page and words of the latest report", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const first = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: { ...defect, url: "https://app.acme.test/x?step=1", quote: "First try." } })]);
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: { ...defect, url: "https://app.acme.test/x?step=2", quote: "Second try." } })]);
    const stored = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.findings[0]!;
    expect({ url: stored.url, quote: stored.quote }).toEqual({ url: "https://app.acme.test/x?step=2", quote: "Second try." });
    await drain();
  });
});

describe("a finding that names who did each step", () => {
  test("is stored with its people, shown with their names, and handed to the replay with them, while a finding without people stays single-person", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const first = (await claimPastChecks())!;
    seq = 0;
    await ingestEvents(t.db, first.token, [
      ev({ type: "finding", jobId: first.jobId, finding: { ...defect, by: ["lee", first.personaKey!] } }),
      ev({ type: "finding", jobId: first.jobId, finding: { ...defect, id: "f2", title: "Alone" } }),
    ]);
    await completeJob(t.db, first.token, { usage: usage(0), stoppedBy: "finish" });
    const second = (await claimPastChecks())!;
    await completeJob(t.db, second.token, { usage: usage(0), stoppedBy: "finish" });
    const summary = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    expect(summary.findings.map((f) => f.stepPeople)).toEqual([["lee", first.personaKey], null]);
    const replays: Array<{ id: string; by: unknown; steps: number }> = [];
    for (let i = 0; i < 6; i++) {
      const job = await claimPastChecks();
      if (!job) break;
      if (job.kind === "replay") replays.push({ id: job.finding!.id, by: job.finding!.by, steps: job.maxSteps });
      await completeJob(t.db, job.token, { usage: usage(0), stoppedBy: "report", observation: { completed: true, observed: "500", blockedAt: null } });
    }
    expect(replays).toEqual(expect.arrayContaining([{ id: `${first.personaKey}:f1`, by: ["lee", first.personaKey], steps: options.replaySteps * 2 }, { id: `${first.personaKey}:f2`, by: undefined, steps: options.replaySteps }]));
    await drain();
  });
});

describe("a finding sent again with other people", () => {
  test("keeps the people of the latest report, and none when the latest names none", async () => {
    await drain();
    const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const first = (await claimPastChecks())!;
    seq = 0;
    const people = async () => (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.findings[0]!.stepPeople;
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: { ...defect, by: ["lee", first.personaKey!] } })]);
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: { ...defect, by: [first.personaKey!, "lee"] } })]);
    expect(await people()).toEqual([first.personaKey, "lee"]);
    await ingestEvents(t.db, first.token, [ev({ type: "finding", jobId: first.jobId, finding: defect })]);
    expect(await people()).toBeNull();
    await drain();
  });
});

test("a run records the name and id of the plan it started from, and keeps the name when the plan is removed", async () => {
  await drain();
  const own = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys, { focus: "Checkout" }));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", own, keys, options));
  const plan = await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", own));
  const stamped = await sql<{ plan_id: string | null; plan_name: string }>`select plan_id, plan_name from runs where id = ${run.id}`.execute(t.db);
  expect(stamped.rows).toEqual([{ plan_id: plan.id, plan_name: "Checkout" }]);
  await sql`delete from plans where id = ${plan.id}`.execute(t.db);
  const kept = await sql<{ plan_id: string | null; plan_name: string; project_id: string }>`select plan_id, plan_name, project_id from runs where id = ${run.id}`.execute(t.db);
  expect(kept.rows).toEqual([{ plan_id: null, plan_name: "Checkout", project_id: own }]);
  await drain();
});
