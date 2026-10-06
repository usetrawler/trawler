import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createPlan, createProject, firstPlan, listPlans, listPullRequestPlans, MAX_PLANS, nextPlanName, PlanLimit, PlanReadOnly, removePlan, renamePlan, replacePlan, PlanInUse } from "../projects/projects.ts";
import { planDueRuns } from "./pr-plan.ts";
import { claimJob } from "./queue.ts";
import { RECENT_PR_PLANS, storePrPlan } from "./pr-plan-store.ts";
import { runResultOf } from "./comment.ts";
import { runView } from "./report.ts";
import { runSummary, startRun } from "./runs.ts";
import { workspaceRuns } from "../projects/overview.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const options = { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" };
const pullRequest = { number: 900, title: "Add CSV export for invoices", description: "Adds a button to the billing page.", changedFiles: ["src/billing/export.tsx"] };

const config = (name: string) =>
  ProjectConfigSchema.parse({
    name, targetUrl: "https://app.acme.test/",
    personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
    goals: [{ id: "g1", instruction: "Send an invoice", personaId: "ana" }, { id: "g2", instruction: "Check the totals", personaId: "lee" }],
  });

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

const newProject = (name: string) => withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config(name), keys));
const content = { personas: [{ id: "lee" }], goals: [{ id: "pr-goal-1", instruction: "Last month's invoices come out as one spreadsheet", personaId: "lee" }] };
const store = (project: string, source: string, number: number, runId: string) =>
  withOrg(t.db, "org-a", (tx) => storePrPlan(tx, { orgId: "org-a", projectId: project, sourceId: source, key: { repo: "", number }, hash: `h${number}`, content, accountFlow: "provided", runId }));
const anyRun = async (project: string) => {
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${run.id}`.execute(t.db);
  await sql`update jobs set status = 'cancelled' where run_id = ${run.id}`.execute(t.db);
  return run;
};
const setUsed = (planId: string, minutesAgo: number) => sql`update plans set last_used_at = now() - make_interval(mins => ${minutesAgo}) where id = ${planId}`.execute(t.db);

test("a project keeps the 30 most recently used pull request plans, and a plan a live run is on is spared", async () => {
  const project = await newProject("prune");
  const source = (await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", project))).id;
  const run = await anyRun(project);
  const ids: string[] = [];
  for (let number = 1; number <= RECENT_PR_PLANS; number++) {
    ids.push((await store(project, source, number, run.id)).id);
    await setUsed(ids.at(-1)!, 1000 - number);
  }
  expect(await withOrg(t.db, "org-a", (tx) => listPullRequestPlans(tx, "org-a", project))).toHaveLength(RECENT_PR_PLANS);
  await sql`update runs set status = 'running', cancel_reason = null, finished_at = null, plan_id = ${ids[0]!} where id = ${run.id}`.execute(t.db);
  await store(project, source, 31, run.id);
  await store(project, source, 32, run.id);
  const kept = (await withOrg(t.db, "org-a", (tx) => listPullRequestPlans(tx, "org-a", project))).map((p) => p.number).sort((a, b) => a - b);
  expect(kept).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
  await sql`update runs set status = 'cancelled', finished_at = now() where id = ${run.id}`.execute(t.db);
  await store(project, source, 33, run.id);
  expect((await withOrg(t.db, "org-a", (tx) => listPullRequestPlans(tx, "org-a", project))).map((p) => p.number)).not.toContain(1);
  expect((await sql<{ plan_id: string | null; plan_name: string }>`select plan_id, plan_name from runs where id = ${run.id}`.execute(t.db)).rows[0]!.plan_id).toBeNull();
});

test("pull request plans do not count toward the plans a project can hold, do not rename or number the plans, and are never the default plan", async () => {
  const project = await newProject("limits");
  const source = (await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", project))).id;
  const run = await anyRun(project);
  for (let number = 1; number <= 12; number++) await store(project, source, number, run.id);
  const seat = (key: string) => ({ personas: [{ id: key, name: key, brief: "b" }], goals: [{ id: `${key}-goal`, instruction: "Look around.", personaId: key }] });
  expect(await withOrg(t.db, "org-a", (tx) => nextPlanName(tx, "org-a", project))).toBe("Plan 2");
  for (let n = 2; n <= MAX_PLANS; n++) await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", project, { name: n === 5 ? "pr #5" : `Plan ${n}`, ...seat(`p${n}`) }));
  await expect(withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", project, { name: "One too many", ...seat("extra") }))).rejects.toThrow(PlanLimit);
  expect(await withOrg(t.db, "org-a", (tx) => listPlans(tx, "org-a", project))).toHaveLength(MAX_PLANS);
  expect((await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", project))).id).toBe(source);
});

test("a plan made from a pull request cannot be edited or removed, and removing the plan it came from needs its runs to be over", async () => {
  const project = await newProject("readonly");
  const source = (await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", project))).id;
  const run = await anyRun(project);
  const made = await store(project, source, 7, run.id);
  await expect(withOrg(t.db, "org-a", (tx) => renamePlan(tx, "org-a", project, made.id, "Mine"))).rejects.toThrow(PlanReadOnly);
  await expect(withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", project, made.id))).rejects.toThrow(PlanReadOnly);
  await expect(withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", project, { personas: [{ id: "lee", name: "Lee", brief: "b" }], goals: [{ id: "x", instruction: "Look.", personaId: "lee" }] }, undefined, { planId: made.id }))).rejects.toThrow(PlanReadOnly);
  const seat = { personas: [{ id: "kofi", name: "Kofi", brief: "b" }], goals: [{ id: "k", instruction: "Look around.", personaId: "kofi" }] };
  await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", project, { name: "Plan 2", ...seat }));
  await sql`update runs set status = 'running', cancel_reason = null, finished_at = null, plan_id = ${made.id} where id = ${run.id}`.execute(t.db);
  await expect(withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", project, source))).rejects.toThrow(PlanInUse);
  await sql`update runs set status = 'cancelled', finished_at = now() where id = ${run.id}`.execute(t.db);
  await withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", project, source));
  expect(await withOrg(t.db, "org-a", (tx) => listPullRequestPlans(tx, "org-a", project))).toEqual([]);
});

test("both: a stored pull request plan adds its goals to the stored plan on the next run, without asking the lead, and the run stays on the stored plan", async () => {
  const project = await newProject("both-reuse");
  const first = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest, planMode: "both" }));
  const lead = scriptedModel([text(JSON.stringify({ turns: [{ person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] }] }))]);
  await planDueRuns({ db: t.db, model: lead, modelId: "setup-model" });
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${first.id}`.execute(t.db);
  await sql`update jobs set status = 'cancelled' where run_id = ${first.id}`.execute(t.db);
  const second = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest, planMode: "both" }));
  const seen = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", second.id)))!;
  expect(seen.prPlan).toMatchObject({ mode: "both", reused: true, version: 1, goals: [{ id: "pr-goal-1", personaId: "lee" }] });
  expect(seen.goalTexts.map((g) => g.id)).toEqual(["g1", "g2", "pr-goal-1"]);
  expect(seen.planName).toBeNull();
  expect((await sql<{ plan_name: string }>`select plan_name from runs where id = ${second.id}`.execute(t.db)).rows[0]!.plan_name).toBe("Plan 1");
  expect(await claimJob(t.db, keys)).toMatchObject({ runId: second.id });
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${second.id}`.execute(t.db);
});

test("a run on a pull request plan names the plan in the run list and on the run, and a skipped run is not something that needs attention", async () => {
  const project = await newProject("shown");
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest }));
  await planDueRuns({ db: t.db, model: scriptedModel([text(JSON.stringify({ turns: [{ person: "lee", goals: [{ id: "export", instruction: "Last month's invoices come out as one spreadsheet" }] }] }))]), modelId: "setup-model" });
  expect((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!.planName).toBe("PR #900 v1");
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${run.id}`.execute(t.db);
  const skipped = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest: { ...pullRequest, number: 901 } }));
  await planDueRuns({ db: t.db, model: scriptedModel([text(JSON.stringify({ turns: [] }))]), modelId: "setup-model" });
  const result = runResultOf((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", skipped.id)))!, "https://app.trawler.test");
  expect(result).toMatchObject({ status: "cancelled", finished: true, skipped: true, people: 0, goalsTotal: 0, defects: { confirmed: 0 } });
  expect(result.commentMarkdown).toContain("### Nothing in this change can be tested through the product's UI, so Trawler did not start a run.");
  expect(runView((await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", skipped.id)))!).headline).toBe("Nothing in this change can be tested through the product's UI, so Trawler did not start a run.");
  const lines = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: project }));
  expect(lines.runs.map((r) => [r.number, r.status, r.planName])).toEqual([[skipped.number, "skipped", null], [run.number, "cancelled", "PR #900 v1"]]);
  const attention = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: project, show: "attention" }));
  expect(attention.runs.map((r) => r.number)).toEqual([run.number]);
});

test("the migration lets a run be cancelled for having nothing to test and still keeps the other reasons", async () => {
  const project = await newProject("reasons");
  const run = await anyRun(project);
  for (const reason of ["nothing_to_test", "ci_gone", "stopped"]) await sql`update runs set cancel_reason = ${reason} where id = ${run.id}`.execute(t.db);
  await expect(sql`update runs set cancel_reason = 'bogus' where id = ${run.id}`.execute(t.db)).rejects.toThrow();
});
