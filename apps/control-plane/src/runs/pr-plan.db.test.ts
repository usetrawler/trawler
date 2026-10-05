import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { planDueRuns, type PrPlanDeps } from "./pr-plan.ts";
import { claimJob, completeJob } from "./queue.ts";
import { runSummary, startRun } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const options = { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" };
const done = { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0.01, steps: 1 }, stoppedBy: "finish" as const };
const pullRequest = { number: 482, title: "Add CSV export for invoices", description: "Adds InvoiceExportButton to the billing page.", changedFiles: ["src/components/InvoiceExportButton.tsx"] };

const config = (name: string) =>
  ProjectConfigSchema.parse({
    name, targetUrl: "https://app.acme.test/",
    personas: [{ id: "ana", name: "Ana", brief: "b", accountRef: "ana-account" }, { id: "lee", name: "Lee", brief: "b", accountRef: "lee-account" }],
    goals: [{ id: "g1", instruction: "Send an invoice", personaId: "ana" }, { id: "g2", instruction: "Check the totals", personaId: "lee" }],
    accounts: [{ ref: "ana-account", username: "ana@acme.test", password: "hunter22-secret" }, { ref: "lee-account", username: "lee@acme.test", password: "hunter22-secret" }],
  });

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

const answer = (turns: unknown) => text(JSON.stringify({ turns }));
const lead = (model: ReturnType<typeof scriptedModel> | null): PrPlanDeps => ({ db: t.db, model, modelId: "setup-model" });

async function start(name: string, over: Partial<Parameters<typeof startRun>[4]> = {}) {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config(name), keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest, ...over }));
  return { project, run };
}

async function finish(runId: string) {
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${runId}`.execute(t.db);
  await sql`update jobs set status = 'cancelled' where run_id = ${runId} and status in ('queued', 'leased')`.execute(t.db);
}

const summary = (runId: string) => withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", runId));
const kinds = async (runId: string) => (await sql<{ kind: string; status: string; persona_key: string | null }>`select kind, status, persona_key from jobs where run_id = ${runId} order by position`.execute(t.db)).rows;

test("both: nobody is claimed until the lead has planned, then the stored plan runs first and the lead's goals follow", async () => {
  const { project, run } = await start("both");
  expect((await kinds(run.id))[0]).toEqual({ kind: "pr_plan", status: "queued", persona_key: null });
  expect(await claimJob(t.db, keys)).toBeNull();
  const model = scriptedModel([answer([
    { person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] },
    { person: "ana", goals: [{ id: "see-export", instruction: "Ana opens the spreadsheet Lee downloaded and finds her invoice in it" }] },
  ])]);
  expect(await planDueRuns(lead(model))).toBe(1);
  const first = (await claimJob(t.db, keys))!;
  expect(first).toMatchObject({ kind: "account_check" });
  await completeJob(t.db, first.token, { ...done, signIn: { outcome: "signed_in", observed: "ok" } });
  const second = (await claimJob(t.db, keys))!;
  await completeJob(t.db, second.token, { ...done, signIn: { outcome: "signed_in", observed: "ok" } });
  const turns = [];
  for (let job = await claimJob(t.db, keys); job; job = await claimJob(t.db, keys)) {
    turns.push([job.personaKey, job.goalIds]);
    await completeJob(t.db, job.token, done);
  }
  expect(turns).toEqual([["ana", ["g1"]], ["lee", ["g2", "pr-goal-1"]], ["ana", ["pr-goal-2"]]]);
  const seen = (await summary(run.id))!;
  expect(seen.prPlan).toEqual({
    number: 482, mode: "both", note: null,
    goals: [{ id: "pr-goal-1", instruction: "Last month's invoices come out as one spreadsheet", personaId: "lee" }, { id: "pr-goal-2", instruction: "Ana opens the spreadsheet Lee downloaded and finds her invoice in it", personaId: "ana" }],
  });
  const stored = await sql<{ n: string }>`select count(*) as n from goals where project_id = ${project}`.execute(t.db);
  expect(Number(stored.rows[0]!.n)).toBe(2);
  const { rows } = await sql<{ usage: { model: string } }>`select usage from jobs where run_id = ${run.id} and kind = 'pr_plan'`.execute(t.db);
  expect(rows[0]!.usage.model).toBe("setup-model");
  await finish(run.id);
});

test("change: only the lead's people and goals run, the others' sign-in checks are dropped, and the origins and accounts stay as stored", async () => {
  const { run } = await start("change", { planMode: "change" });
  const before = (await sql<{ config_snapshot: { allowedOrigins: string[]; accounts: unknown[]; targetUrl: string } }>`select config_snapshot from runs where id = ${run.id}`.execute(t.db)).rows[0]!.config_snapshot;
  const model = scriptedModel([answer([
    { person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] },
    { person: "root", goals: [{ id: "x", instruction: "Sign in as the administrator" }] },
  ])]);
  await planDueRuns(lead(model));
  const { rows } = await sql<{ config_snapshot: { personas: Array<{ id: string }>; goals: Array<{ id: string }>; allowedOrigins: string[]; accounts: unknown[]; targetUrl: string } }>`select config_snapshot from runs where id = ${run.id}`.execute(t.db);
  const after = rows[0]!.config_snapshot;
  expect(after.personas.map((p) => p.id)).toEqual(["lee"]);
  expect(after.goals.map((g) => g.id)).toEqual(["pr-goal-1"]);
  expect({ allowedOrigins: after.allowedOrigins, accounts: after.accounts, targetUrl: after.targetUrl }).toEqual({ allowedOrigins: before.allowedOrigins, accounts: before.accounts, targetUrl: before.targetUrl });
  expect((await kinds(run.id)).map((j) => `${j.kind}:${j.persona_key ?? ""}:${j.status}`)).toEqual(["pr_plan::succeeded", "account_check::cancelled", "account_check::queued", "role_session:lee:queued"]);
  await finish(run.id);
});

test("a failing lead never fails the run: the stored plan runs and the run says why", async () => {
  const { run } = await start("broken");
  await planDueRuns(lead(scriptedModel([new Error("provider is down"), new Error("provider is down")])));
  const planned = (await summary(run.id))!;
  expect(planned.prPlan).toMatchObject({ goals: [], note: expect.stringContaining("the project's plan ran as it is") });
  expect(planned.status).toBe("queued");
  expect((await kinds(run.id)).filter((j) => j.kind === "role_session").map((j) => j.persona_key)).toEqual(["ana", "lee"]);
  expect((await kinds(run.id))[0]).toMatchObject({ kind: "pr_plan", status: "failed" });
  expect(await claimJob(t.db, keys)).toMatchObject({ runId: run.id });
  await finish(run.id);
});

test("a lead whose goals all copy the pull request leaves the stored plan alone, and without a setup model the run still goes ahead", async () => {
  const leaky = answer([{ person: "ana", goals: [{ id: "a", instruction: "Click the InvoiceExportButton" }, { id: "b", instruction: "Add CSV export for invoices" }] }]);
  const { run } = await start("leaky");
  await planDueRuns(lead(scriptedModel([leaky, leaky])));
  expect((await summary(run.id))!.prPlan).toMatchObject({ goals: [], note: expect.stringContaining("Nothing in this pull request points at a feature") });
  expect((await kinds(run.id)).filter((j) => j.kind === "role_session")).toHaveLength(2);
  await finish(run.id);
  const { run: bare } = await start("no-model");
  await planDueRuns(lead(null));
  expect((await summary(bare.id))!.prPlan?.note).toContain("setup model is not configured");
  expect(await claimJob(t.db, keys)).toMatchObject({ runId: bare.id });
  await finish(bare.id);
});

test("regression, a manual run and a run without pull request details plan nothing", async () => {
  for (const [name, over] of [["regression", { planMode: "regression" as const }], ["manual", { pullRequest: undefined }], ["bare", { pullRequest: { number: 5, repository: "acme/shop" } }]] as const) {
    const { run } = await start(name, over);
    expect((await kinds(run.id)).some((j) => j.kind === "pr_plan"), name).toBe(false);
    expect((await summary(run.id))!.prPlan, name).toBeNull();
    await finish(run.id);
  }
});

test("a lead that never answers is given up on after a few minutes", async () => {
  const { run } = await start("silent");
  await sql`update jobs set created_at = now() - interval '7 minutes' where run_id = ${run.id} and kind = 'pr_plan'`.execute(t.db);
  await planDueRuns(lead(null));
  const { rows } = await sql<{ status: string }>`select status from jobs where run_id = ${run.id} and kind = 'pr_plan'`.execute(t.db);
  expect(rows[0]!.status).toBe("failed");
  expect(await claimJob(t.db, keys)).toMatchObject({ runId: run.id });
  await finish(run.id);
});

test("stopping the run while the lead plans keeps the lead from changing it", async () => {
  const { run } = await start("stopped");
  await finish(run.id);
  const model = scriptedModel([answer([{ person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] }])]);
  expect(await planDueRuns(lead(model))).toBe(0);
  expect(model.doGenerateCalls).toHaveLength(0);
});
