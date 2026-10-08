import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { KNOWN_LIMIT, TRAWLER } from "./dismissals.ts";
import { claimJob, completeJob } from "./queue.ts";
import { runView } from "./report.ts";
import { runSummary, startRun } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Recurro", targetUrl: "https://app.recurro.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Get in." }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const done = { usage: { model: "m/judge", inputTokens: 1, outputTokens: 1, costUsd: 0.001, steps: 1 }, stoppedBy: "done" as const };
const SETUP = "Self-hosted, with no mail server. Accounts come only from an invitation; there is no self sign-up.";

let projects = 0;
beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});
afterEach(async () => {
  await asSystem(t.db, async (tx) => {
    await tx.updateTable("jobs").set({ status: "cancelled", token_hash: null, lease_until: null }).where("status", "in", ["queued", "leased"]).execute();
    await tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped", finished_at: new Date() }).where("status", "in", ["queued", "running"]).execute();
  });
});

async function atLastJudge(environment: string | undefined, findings: Array<{ key: string; verdict: "confirmed" | "refuted" }>) {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: `Recurro ${++projects}` }, keys));
  const pullRequest = environment ? { number: 7, title: "feat: ask to cancel", environment } : undefined;
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, planMode: "regression", ...(pullRequest ? { pullRequest } : {}) }));
  await asSystem(t.db, async (tx) => {
    await tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", run.id).execute();
    await tx.updateTable("runs").set({ status: "running", started_at: new Date() }).where("id", "=", run.id).execute();
    const holder = await tx.selectFrom("jobs").select("id").where("run_id", "=", run.id).executeTakeFirstOrThrow();
    for (const { key, verdict } of findings) {
      await tx.insertInto("findings").values({
        org_id: "org-a", run_id: run.id, job_id: holder.id, key, persona_key: "ana", kind: "defect", goal: "g",
        title: `No way to sign up (${key})`, observed: "Only a sign-in form.", reproduction: JSON.stringify(["Open /", "Look for sign-up"]), severity: "high", verdict,
      }).execute();
    }
    await tx.insertInto("jobs").values({ org_id: "org-a", run_id: run.id, kind: "judge", position: 50, finding_key: findings[0]!.key }).execute();
  });
  return run.id;
}

const statusOf = async (runId: string) => (await sql<{ status: string }>`select status from runs where id = ${runId}`.execute(t.db)).rows[0]!.status;
const dismissals = async (runId: string) => (await sql<{ finding_key: string; reason: string; dismissed_by: string }>`select finding_key, reason, dismissed_by from finding_dismissals where run_id = ${runId} order by finding_key`.execute(t.db)).rows;

test("with a described setup, the lead triages the confirmed defects before the run ends, and what the setup explains is set aside as a known limitation", async () => {
  const runId = await atLastJudge(SETUP, [{ key: "f1", verdict: "confirmed" }, { key: "f2", verdict: "confirmed" }]);
  const judge = (await claimJob(t.db, keys))!;
  expect(judge.kind).toBe("judge");
  await completeJob(t.db, judge.token, done);
  expect(await statusOf(runId)).toBe("running");
  const triage = (await claimJob(t.db, keys))!;
  expect(triage.kind).toBe("triage");
  expect(triage.config.setup).toBe(SETUP);
  expect(triage.defects?.map((d) => d.key)).toEqual(["f1", "f2"]);
  await completeJob(t.db, triage.token, { ...done, knownLimits: [{ key: "f1", reason: "There is no self sign-up in this setup." }, { key: "nope", reason: "Not a finding." }] });
  expect(await dismissals(runId)).toEqual([{ finding_key: "f1", reason: `${KNOWN_LIMIT} There is no self sign-up in this setup.`, dismissed_by: TRAWLER }]);
  expect(await statusOf(runId)).toBe("succeeded");
  const view = runView((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", runId)))!);
  expect(view.report.confirmed.map((f) => f.key)).toEqual(["f2"]);
  expect(view.report.dismissed.map((f) => f.key)).toEqual(["f1"]);
});

test("without a described setup, or with nothing confirmed, the run ends without a triage", async () => {
  for (const [environment, verdict] of [[undefined, "confirmed"], [SETUP, "refuted"]] as const) {
    const runId = await atLastJudge(environment, [{ key: "f1", verdict }]);
    await completeJob(t.db, (await claimJob(t.db, keys))!.token, done);
    expect(await statusOf(runId)).toBe("succeeded");
    expect((await sql<{ n: string }>`select count(*) as n from jobs where run_id = ${runId} and kind = 'triage'`.execute(t.db)).rows[0]!.n).toBe("0");
  }
});

test("a failed triage sets nothing aside and still ends the run", async () => {
  const runId = await atLastJudge(SETUP, [{ key: "f1", verdict: "confirmed" }]);
  await completeJob(t.db, (await claimJob(t.db, keys))!.token, done);
  const triage = (await claimJob(t.db, keys))!;
  await completeJob(t.db, triage.token, { ...done, stoppedBy: "error", error: "the model gave no triage (2 tries)", knownLimits: [{ key: "f1", reason: "x" }] });
  expect(await dismissals(runId)).toEqual([]);
  expect(await statusOf(runId)).toBe("succeeded");
});
