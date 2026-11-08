import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { startRun } from "../runs/runs.ts";
import { createProject, listPlans } from "./projects.ts";
import { openFindings, projectCounts, projectPullRequests, runResult } from "./project-home.ts";
import { runLinesByIds, type RunLine } from "./overview.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
  goals: [{ id: "sign-in", instruction: "Get in." }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };

type Finding = { key: string; verdict?: "confirmed" | "refuted"; kind?: "defect" | "friction"; severity?: string; persona?: string; sameAs?: string };
type Seed = { status: string; pr?: { number: number; title?: string; repository?: string; url?: string }; prPlan?: { id: string; version: number }; cancelReason?: string; findings?: Finding[] };

let acme = "";
let other = "";
let plan1 = "";
let prPlan = "";

async function seedRun(projectId: string, seed: Seed) {
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", projectId, keys, options));
  await asSystem(t.db, async (tx) => {
    await tx.updateTable("runs").set({
      status: seed.status,
      cancel_reason: seed.cancelReason ?? null,
      pull_request: seed.pr ? JSON.stringify(seed.pr) : null,
      pr_plan: seed.prPlan ? JSON.stringify({ mode: "change", goalIds: [], prPlanId: seed.prPlan.id, version: seed.prPlan.version }) : null,
    }).where("id", "=", run.id).execute();
    await tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", run.id).execute();
    const job = await tx.selectFrom("jobs").select("id").where("run_id", "=", run.id).where("persona_key", "=", "ana").executeTakeFirstOrThrow();
    if (seed.findings?.length) {
      await tx.insertInto("findings").values(seed.findings.map((f) => ({
        org_id: "org-a", run_id: run.id, job_id: job.id, key: f.key, persona_key: f.persona ?? "ana", kind: f.kind ?? "defect", goal: "sign-in",
        title: `Finding ${f.key}`, observed: "o", reproduction: JSON.stringify(["Open /"]), severity: f.severity ?? "medium", verdict: f.verdict ?? "confirmed", same_as: f.sameAs ?? null,
      }))).execute();
    }
  });
  return run;
}

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'org-a', 'org-a', now())`.execute(t.db);
  acme = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  other = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "Other", targetUrl: "https://other.acme.test/" }, keys));
  plan1 = (await withOrg(t.db, "org-a", (tx) => listPlans(tx, "org-a", acme)))[0]!.id;
  prPlan = (await asSystem(t.db, (tx) => tx.insertInto("plans").values({ org_id: "org-a", project_id: acme, name: "PR #21", kind: "pull_request", source_plan_id: plan1, repo: "acme/app", pr_number: 21, version: 3, inputs_hash: "h", account_flow: "provided", last_used_at: new Date() }).returning("id").executeTakeFirstOrThrow())).id;
});

test("open findings are the confirmed defects of the latest finished run of each pull request and of each plan, highest severity first", async () => {
  await seedRun(acme, { status: "succeeded", findings: [{ key: "ana:old" }] });
  await seedRun(acme, { status: "succeeded", findings: [{ key: "ana:plan", severity: "low" }, { key: "ana:refuted", verdict: "refuted" }, { key: "ana:friction", kind: "friction" }] });
  await seedRun(acme, { status: "failed", findings: [{ key: "ana:failed" }] });
  await seedRun(acme, { status: "succeeded", pr: { number: 21, repository: "Acme/App" }, findings: [{ key: "ana:pr21-old" }] });
  const pr21 = await seedRun(acme, { status: "stopped_budget", pr: { number: 21, repository: "acme/app" }, findings: [{ key: "lee:pr21", severity: "high", persona: "lee" }, { key: "ana:same", sameAs: "lee:pr21" }] });
  const pr22 = await seedRun(acme, { status: "succeeded", pr: { number: 22, repository: "acme/app" }, findings: [{ key: "ana:dismissed" }, { key: "ana:rejudging" }, { key: "ana:pr22" }] });
  await seedRun(other, { status: "succeeded", findings: [{ key: "ana:other" }] });
  await asSystem(t.db, async (tx) => {
    await tx.insertInto("finding_dismissals").values({ org_id: "org-a", run_id: pr22.id, finding_key: "ana:dismissed", dismissed_by: "u1", reason: "not_a_bug" }).execute();
    await tx.insertInto("jobs").values({ org_id: "org-a", run_id: pr22.id, kind: "judge", position: 10, finding_key: "ana:rejudging", requested_by: "u1", status: "queued" }).execute();
  });

  const open = await withOrg(t.db, "org-a", (tx) => openFindings(tx, "org-a", acme));
  expect(open.map((f) => [f.key, f.source, f.runNumber])).toEqual([
    ["lee:pr21", "PR #21", pr21.number],
    ["ana:pr22", "PR #22", pr22.number],
    ["ana:plan", "Plan 1", expect.any(Number)],
  ]);
  expect(open[0]).toMatchObject({ title: "Finding lee:pr21", severity: "high", person: "Lee" });
  expect((await withOrg(t.db, "org-a", (tx) => runLinesByIds(tx, "org-a", [pr21.id]))).get(pr21.id)!.confirmed).toBe(1);
  expect(await withOrg(t.db, "org-a", (tx) => openFindings(tx, "org-b", acme))).toEqual([]);
});

test("each pull request is listed once, newest run first, with its title, the plan the run used and the run's result", async () => {
  const skipped = await seedRun(acme, { status: "cancelled", cancelReason: "nothing_to_test", pr: { number: 23, title: "chore: store amounts as grosze", repository: "acme/app" } });
  const latest21 = await seedRun(acme, { status: "succeeded", pr: { number: 21, title: "feat: filter by cycle", repository: "acme/app", url: "https://github.com/acme/app/pull/21" }, prPlan: { id: prPlan, version: 3 }, findings: [{ key: "ana:x" }] });
  await seedRun(acme, { status: "succeeded", pr: { number: 21, repository: "acme/other" }, prPlan: { id: "00000000-0000-4000-8000-000000000000", version: 1 } });
  await seedRun(acme, { status: "running", pr: { number: 22, repository: "acme/app" } });

  const prs = await withOrg(t.db, "org-a", (tx) => projectPullRequests(tx, "org-a", acme));
  expect(prs.map((p) => [p.number, p.run.number])).toEqual([[22, expect.any(Number)], [21, expect.any(Number)], [21, latest21.number], [23, skipped.number]]);
  expect(prs[2]).toMatchObject({ title: "feat: filter by cycle", url: "https://github.com/acme/app/pull/21", plan: { id: prPlan, label: "v3", ofPullRequest: true } });
  expect(runResult(prs[2]!.run)).toBe("1 confirmed");
  expect(prs[1]!.plan).toEqual({ id: null, label: "v1", ofPullRequest: true });
  expect(prs[3]).toMatchObject({ title: "chore: store amounts as grosze", plan: { id: plan1, label: "Plan 1", ofPullRequest: false } });
  expect(runResult(prs[3]!.run)).toBe("Skipped: nothing to test in the UI");
  expect(runResult(prs[0]!.run)).toBe("Running");
  expect((await withOrg(t.db, "org-a", (tx) => projectPullRequests(tx, "org-a", acme, 2))).map((p) => p.run.number)).toEqual(prs.slice(0, 2).map((p) => p.run.number));
  expect(await withOrg(t.db, "org-a", (tx) => projectCounts(tx, "org-a", acme))).toEqual({ runs: 10, finished: 7, pullRequests: 4 });
  expect((await withOrg(t.db, "org-a", (tx) => openFindings(tx, "org-a", acme))).find((f) => f.source === "PR #22")?.key).toBe("ana:pr22");
  expect(await withOrg(t.db, "org-a", (tx) => projectCounts(tx, "org-a", other))).toEqual({ runs: 1, finished: 1, pullRequests: 0 });
});

test("a run's result reads the way the pull request list shows it", () => {
  const run = (patch: Partial<RunLine>) => ({ status: "succeeded", confirmed: 0, unchecked: false, ...patch }) as RunLine;
  expect(runResult(run({}))).toBe("No defect confirmed");
  expect(runResult(run({ confirmed: 2 }))).toBe("2 confirmed");
  expect(runResult(run({ unchecked: true }))).toBe("Not checked: every replay failed");
  expect(runResult(run({ status: "stopped_budget", confirmed: 1 }))).toBe("Stopped at cap · 1 confirmed");
  expect(runResult(run({ status: "failed" }))).toBe("Failed");
  expect(runResult(run({ status: "cancelled" }))).toBe("Cancelled");
  expect(runResult(run({ status: "queued" }))).toBe("Queued");
});
