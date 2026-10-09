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
  const { project, run } = await start("both", { planMode: "both" });
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
    number: 482, mode: "both", note: null, version: 1, reused: false, createdByRun: run.number,
    goals: [{ id: "pr-goal-1", instruction: "Last month's invoices come out as one spreadsheet", personaId: "lee" }, { id: "pr-goal-2", instruction: "Ana opens the spreadsheet Lee downloaded and finds her invoice in it", personaId: "ana" }],
  });
  const stored = await sql<{ n: string }>`select count(*) as n from goals g join plans p on p.id = g.plan_id where g.project_id = ${project} and p.kind = 'standard'`.execute(t.db);
  expect(Number(stored.rows[0]!.n)).toBe(2);
  expect((await sql<{ plan_name: string }>`select plan_name from runs where id = ${run.id}`.execute(t.db)).rows[0]!.plan_name).toBe("Plan 1");
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

const planRows = async (project: string) => (await sql<{ id: string; name: string; kind: string; version: number | null; updated_at: Date }>`select id, name, kind, version, updated_at from plans where project_id = ${project} order by created_at, id`.execute(t.db)).rows;
const peopleOf = async (planId: string) => (await sql<{ key: string; name: string; brief: string; signs_in: boolean; account_ref: string | null }>`select key, name, brief, signs_in, account_ref from personas where plan_id = ${planId} order by position`.execute(t.db)).rows;
const goalsOf = async (planId: string) => (await sql<{ key: string; persona_key: string; instruction: string }>`select key, persona_key, instruction from goals where plan_id = ${planId} order by position`.execute(t.db)).rows;
const runPlan = async (runId: string) => (await sql<{ plan_id: string | null; plan_name: string }>`select plan_id, plan_name from runs where id = ${runId}`.execute(t.db)).rows[0]!;

test("change: the first run with details makes a pull request plan of its own with copies of the chosen people and the lead's goals, and runs on it while Plan 1 stays as it was", async () => {
  const { project, run } = await start("own-plan");
  const [standing] = await planRows(project);
  const before = { people: await peopleOf(standing!.id), goals: await goalsOf(standing!.id) };
  await planDueRuns(lead(scriptedModel([answer([
    { person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] },
    { person: "ana", goals: [{ id: "see-export", instruction: "Ana opens the spreadsheet Lee downloaded and finds her invoice in it" }] },
  ])])));
  const rows = await planRows(project);
  expect(rows.map((r) => [r.name, r.kind, r.version])).toEqual([["Plan 1", "standard", null], ["PR #482", "pull_request", 1]]);
  const made = rows[1]!;
  expect(await runPlan(run.id)).toEqual({ plan_id: made.id, plan_name: "PR #482 v1" });
  expect(await peopleOf(made.id)).toEqual([
    { key: "ana", name: "Ana", brief: "b", signs_in: true, account_ref: "ana-account" },
    { key: "lee", name: "Lee", brief: "b", signs_in: true, account_ref: "lee-account" },
  ]);
  expect(await goalsOf(made.id)).toEqual([
    { key: "pr-goal-1", persona_key: "lee", instruction: "Last month's invoices come out as one spreadsheet" },
    { key: "pr-goal-2", persona_key: "ana", instruction: "Ana opens the spreadsheet Lee downloaded and finds her invoice in it" },
  ]);
  expect((await sql<{ ref: string }>`select ref from target_accounts where plan_id = ${made.id} order by position`.execute(t.db)).rows.map((a) => a.ref)).toEqual(["ana-account", "lee-account"]);
  expect({ people: await peopleOf(standing!.id), goals: await goalsOf(standing!.id), updated: (await planRows(project))[0]!.updated_at }).toEqual({ ...before, updated: standing!.updated_at });
  const turns = [];
  for (let job = await claimJob(t.db, keys); job; job = await claimJob(t.db, keys)) {
    if (job.kind === "role_session") turns.push([job.personaKey, job.goalIds]);
    await completeJob(t.db, job.token, { ...done, ...(job.kind === "account_check" ? { signIn: { outcome: "signed_in" as const, observed: "ok" } } : {}) });
  }
  expect(turns).toEqual([["lee", ["pr-goal-1"]], ["ana", ["pr-goal-2"]]]);
  const seen = (await summary(run.id))!;
  expect(seen).toMatchObject({ planName: "PR #482 v1", prPlan: { mode: "change", version: 1, reused: false } });
  await finish(run.id);
});

test("change: nothing the people can try means no run is spent: the run ends as skipped, nobody is claimed, and the stored plan does not run as a fallback", async () => {
  const { project, run } = await start("nothing");
  expect(await claimJob(t.db, keys)).toBeNull();
  await planDueRuns(lead(scriptedModel([answer([])])));
  const seen = (await summary(run.id))!;
  expect(seen).toMatchObject({ status: "cancelled", cancelReason: "nothing_to_test", prPlan: { mode: "change", goals: [], note: "Nothing in this change can be tested through the product's UI, so Trawler did not start a run." } });
  expect((await kinds(run.id)).filter((j) => j.kind !== "pr_plan").every((j) => j.status === "cancelled")).toBe(true);
  expect(await claimJob(t.db, keys)).toBeNull();
  expect((await planRows(project)).map((r) => r.kind)).toEqual(["standard"]);
  const next = await startOn(project);
  expect(next.id).not.toBe(run.id);
  await finish(next.id);
});

test("change: a lead whose goals were all dropped is not taken for a change with nothing to test", async () => {
  const leaky = answer([{ person: "ana", goals: [{ id: "a", instruction: "Read the reminder in the inbox at http://localhost:8025" }] }]);
  const { run } = await start("all-dropped");
  await planDueRuns(lead(scriptedModel([leaky, leaky])));
  const planned = (await summary(run.id))!;
  expect(planned.cancelReason).not.toBe("nothing_to_test");
  expect(planned.status).toBe("queued");
  expect(planned.prPlan).toMatchObject({ goals: [], note: expect.stringContaining("the project's plan ran as it is") });
  expect((await kinds(run.id)).filter((j) => j.kind === "role_session").map((j) => j.persona_key)).toEqual(["ana", "lee"]);
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

test("both: a lead whose goals all name code or addresses leaves the stored plan alone, and without a setup model the run still goes ahead", async () => {
  const leaky = answer([{ person: "ana", goals: [{ id: "a", instruction: "Click the InvoiceExportButton" }, { id: "b", instruction: "Open https://app.acme.test/export" }] }]);
  const { run } = await start("leaky", { planMode: "both" });
  await planDueRuns(lead(scriptedModel([leaky, leaky])));
  expect((await summary(run.id))!.prPlan).toMatchObject({ goals: [], note: expect.stringContaining("every one of the 2 goals the lead wrote was dropped; the first: \"Click the InvoiceExportButton\" uses a name from the code") });
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

const LEE_GOAL = [{ person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] }];
const startOn = (project: string, over: Partial<Parameters<typeof startRun>[4]> = {}) => withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest, ...over }));
const snapshotOf = async (runId: string) => (await sql<{ config_snapshot: { personas: Array<{ id: string }>; goals: Array<{ id: string; instruction: string }>; brief?: string } }>`select config_snapshot from runs where id = ${runId}`.execute(t.db)).rows[0]!.config_snapshot;
const stored = async (project: string) => (await sql<{ id: string; pr_number: number; version: number; created_by_run_id: string | null }>`select id, pr_number, version, created_by_run_id from plans where project_id = ${project} and kind = 'pull_request' order by pr_number`.execute(t.db)).rows;

async function planned(project: string, answerTurns: unknown, over: Partial<Parameters<typeof startRun>[4]> = {}) {
  const run = await startOn(project, over);
  expect(await planDueRuns(lead(scriptedModel([answer(answerTurns)])))).toBe(1);
  await finish(run.id);
  return run;
}

test("the first run with details stores version 1; an identical pull request reuses its plan without asking the lead and runs the same goals on it", async () => {
  const { project, run: first } = await start("reuse");
  await planDueRuns(lead(scriptedModel([answer(LEE_GOAL)])));
  expect((await summary(first.id))!.prPlan).toMatchObject({ version: 1, reused: false, createdByRun: first.number });
  await finish(first.id);
  const second = await startOn(project);
  expect((await kinds(second.id)).some((j) => j.kind === "pr_plan")).toBe(false);
  expect(await planDueRuns(lead(null))).toBe(0);
  const reused = (await summary(second.id))!;
  expect(reused.prPlan).toMatchObject({ number: 482, version: 1, reused: true, createdByRun: first.number, note: null, goals: [{ id: "pr-goal-1", personaId: "lee" }] });
  const [row] = await stored(project);
  expect(await runPlan(second.id)).toEqual({ plan_id: row!.id, plan_name: "PR #482 v1" });
  const [a, b] = [await snapshotOf(first.id), await snapshotOf(second.id)];
  expect([b.personas, b.goals]).toEqual([a.personas, a.goals]);
  expect((await kinds(second.id)).filter((j) => j.kind === "role_session").map((j) => j.persona_key)).toEqual(["lee"]);
  expect(await stored(project)).toEqual([{ id: row!.id, pr_number: 482, version: 1, created_by_run_id: first.id }]);
  await finish(second.id);
});

test("a changed description updates the same plan to version 2; --replan makes a new version of an unchanged pull request; runs keep the version they ran", async () => {
  const { project, run } = await start("versions");
  await planDueRuns(lead(scriptedModel([answer(LEE_GOAL)])));
  await finish(run.id);
  const changed = { ...pullRequest, description: `${pullRequest.description} It also adds a schedule.` };
  const second = await planned(project, [{ person: "ana", goals: [{ id: "x", instruction: "Ana sees the spreadsheet in her downloads" }] }], { pullRequest: changed });
  const [v2] = await stored(project);
  expect(v2).toMatchObject({ pr_number: 482, version: 2 });
  expect(await goalsOf(v2!.id)).toEqual([{ key: "pr-goal-1", persona_key: "ana", instruction: "Ana sees the spreadsheet in her downloads" }]);
  expect((await planRows(project)).filter((r) => r.kind === "pull_request")).toHaveLength(1);
  expect((await runPlan(run.id)).plan_name).toBe("PR #482 v1");
  expect(await runPlan(second.id)).toEqual({ plan_id: v2!.id, plan_name: "PR #482 v2" });
  const spaced = { ...changed, title: ` ${changed.title}  `, changedFiles: [...changed.changedFiles].reverse() };
  const third = await startOn(project, { pullRequest: spaced });
  expect((await kinds(third.id)).some((j) => j.kind === "pr_plan")).toBe(false);
  await finish(third.id);
  const replanned = await startOn(project, { pullRequest: changed, replan: true });
  expect((await kinds(replanned.id))[0]).toMatchObject({ kind: "pr_plan", status: "queued" });
  await planDueRuns(lead(scriptedModel([answer(LEE_GOAL)])));
  expect(await stored(project)).toEqual([expect.objectContaining({ id: v2!.id, version: 3 })]);
  expect((await summary(replanned.id))!.prPlan).toMatchObject({ version: 3, reused: false, createdByRun: replanned.number });
  expect((await summary(run.id))!.prPlan).toMatchObject({ version: 1, createdByRun: run.number });
  expect((await summary(third.id))!.prPlan).toMatchObject({ version: 2, reused: true, createdByRun: second.number });
  expect(await runPlan(replanned.id)).toEqual({ plan_id: v2!.id, plan_name: "PR #482 v3" });
  await finish(replanned.id);
});

test("a failed or empty lead stores nothing, so the next run asks again", async () => {
  const { project, run } = await start("not-stored");
  await planDueRuns(lead(scriptedModel([new Error("provider is down"), new Error("provider is down")])));
  await finish(run.id);
  const empty = await startOn(project);
  await planDueRuns(lead(scriptedModel([answer([])])));
  expect((await summary(empty.id))!.cancelReason).toBe("nothing_to_test");
  expect(await stored(project)).toEqual([]);
  const again = await startOn(project);
  expect((await kinds(again.id))[0]).toMatchObject({ kind: "pr_plan", status: "queued" });
  await finish(again.id);
});

test("a person removed from the stored plan is dropped on reuse, and goals follow the plan's current people", async () => {
  const { project, run } = await start("removed");
  await planDueRuns(lead(scriptedModel([answer([...LEE_GOAL, { person: "ana", goals: [{ id: "see", instruction: "Ana finds her invoice in the spreadsheet" }] }])])));
  await finish(run.id);
  await sql`delete from goals where project_id = ${project} and persona_key = 'lee' and plan_id = (select id from plans where project_id = ${project} and kind = 'standard')`.execute(t.db);
  await sql`delete from personas where project_id = ${project} and key = 'lee' and plan_id = (select id from plans where project_id = ${project} and kind = 'standard')`.execute(t.db);
  const next = await startOn(project);
  const reused = (await summary(next.id))!.prPlan;
  expect(reused).toMatchObject({ reused: true, goals: [{ id: "pr-goal-1", personaId: "ana", instruction: "Ana finds her invoice in the spreadsheet" }] });
  expect((await snapshotOf(next.id)).personas.map((p) => p.id)).toEqual(["ana"]);
  await finish(next.id);
});

test("two pull requests of one project keep separate plans", async () => {
  const { project, run } = await start("two-prs");
  await planDueRuns(lead(scriptedModel([answer(LEE_GOAL)])));
  await finish(run.id);
  const other = { ...pullRequest, number: 483 };
  await planned(project, [{ person: "ana", goals: [{ id: "x", instruction: "Ana sees the spreadsheet in her downloads" }] }], { pullRequest: other });
  const back = await startOn(project);
  expect((await summary(back.id))!.prPlan).toMatchObject({ number: 482, version: 1, reused: true, goals: [{ personaId: "lee" }] });
  expect((await runPlan(back.id)).plan_name).toBe("PR #482 v1");
  expect((await stored(project)).map((r) => [r.pr_number, r.version])).toEqual([[482, 1], [483, 1]]);
  await finish(back.id);
});

test("the lead's brief reaches the run's config and its plan view, and is reused with the stored plan", async () => {
  const brief = "Invoices of a month can now be downloaded as one CSV file. Try a month without invoices.";
  const { project, run: first } = await start("brief");
  await planDueRuns(lead(scriptedModel([text(JSON.stringify({ turns: LEE_GOAL, brief }))])));
  expect((await snapshotOf(first.id)).brief).toBe(brief);
  expect((await summary(first.id))!.prPlan).toMatchObject({ brief, reused: false });
  const job = (await claimJob(t.db, keys))!;
  expect(job.config.brief).toBe(brief);
  await finish(first.id);
  const second = await startOn(project);
  expect((await snapshotOf(second.id)).brief).toBe(brief);
  expect((await summary(second.id))!.prPlan).toMatchObject({ brief, reused: true });
  await finish(second.id);
});
