import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { runView } from "../runs/report.ts";
import { runSummary, startRun } from "../runs/runs.ts";
import { projectHead, projectRunCount, runCounts, workspaceNav, workspaceProjects, workspaceRuns } from "./overview.ts";
import { createProject, replacePlan } from "./projects.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
  goals: [{ id: "sign-in", instruction: "Get in." }, { id: "invoice", instruction: "Send an invoice." }, { id: "export", instruction: "Export a year." }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

let acme = "";
let beta = "";
let empty = "";
let fresh = "";
let foreign = "";
type Seeded = { id: string; number: number };
let failed: Seeded;
let capped: Seeded;
let cancelled: Seeded;
let latest: Seeded;
let live: Seeded;
let waiting: Seeded;
let theirs: Seeded;
const nothing = { runs: [], olderThan: null };
const noCounts = { all: 0, completed: 0, attention: 0 };

type Finding = { kind: "defect" | "friction"; verdict: "confirmed" | "refuted" | "inconclusive" | null };

async function seedRun(orgId: string, projectId: string, at: Date, set: { status: string; cost: number; tokenCap?: number; tokensUsed?: number }, findings: Finding[], reached: number, failedGoals: number) {
  const run = await withOrg(t.db, orgId, (tx) => startRun(tx, orgId, projectId, keys, options));
  await asSystem(t.db, async (tx) => {
    await tx.updateTable("runs").set({ status: set.status, cost_usd: set.cost, created_at: at, token_cap: set.tokenCap ?? null, tokens_used: set.tokensUsed ?? 0 }).where("id", "=", run.id).execute();
    await tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", run.id).execute();
    const job = await tx.selectFrom("jobs").select("id").where("run_id", "=", run.id).where("persona_key", "=", "ana").executeTakeFirstOrThrow();
    if (findings.length) {
      await tx.insertInto("findings").values(findings.map((f, i) => ({
        org_id: orgId, run_id: run.id, job_id: job.id, key: `ana:f${i}`, persona_key: "ana", kind: f.kind, goal: "sign-in",
        title: `Finding ${i}`, observed: "o", reproduction: JSON.stringify(["Open /", "Click Save"]), severity: "high", verdict: f.verdict,
      }))).execute();
    }
    const outcomes = [...Array(reached).fill("reached"), ...Array(failedGoals).fill("failed")] as string[];
    const slots = config.personas.flatMap((p) => config.goals.map((g) => [p.id, g.id] as const));
    if (outcomes.length) {
      await tx.insertInto("goal_outcomes").values(outcomes.map((status, i) => ({ org_id: orgId, run_id: run.id, persona_key: slots[i]![0], goal: slots[i]![1], status }))).execute();
    }
  });
  return run;
}

const project = (orgId: string, name: string, targetUrl: string) => withOrg(t.db, orgId, (tx) => createProject(tx, orgId, { ...config, name, targetUrl }, keys));

beforeAll(async () => {
  for (const org of ["org-a", "org-b", "org-c", "org-d"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  acme = await project("org-a", "Acme", "https://app.acme.test/");
  empty = await project("org-a", "Empty", "https://empty.acme.test/");
  fresh = await project("org-a", "Fresh", "https://fresh.acme.test/");
  beta = await project("org-a", "Beta", "https://beta.acme.test/");
  foreign = await project("org-b", "Acme", "https://app.globex.test/");
  await asSystem(t.db, (tx) => tx.updateTable("projects").set({ created_at: hoursAgo(100) }).where("id", "=", acme).execute());
  await asSystem(t.db, (tx) => tx.updateTable("projects").set({ created_at: hoursAgo(12) }).where("id", "=", empty).execute());
  await asSystem(t.db, (tx) => tx.updateTable("projects").set({ created_at: hoursAgo(1) }).where("id", "=", fresh).execute());
  await asSystem(t.db, (tx) => tx.updateTable("projects").set({ created_at: hoursAgo(30) }).where("id", "=", beta).execute());

  failed = await seedRun("org-a", acme, hoursAgo(72), { status: "failed", cost: 0.1 }, [], 0, 0);
  capped = await seedRun("org-a", acme, hoursAgo(48), { status: "stopped_budget", cost: 2, tokenCap: 100_000, tokensUsed: 120_000 }, [
    { kind: "defect", verdict: "confirmed" }, { kind: "defect", verdict: "refuted" }, { kind: "defect", verdict: "inconclusive" }, { kind: "defect", verdict: null }, { kind: "friction", verdict: null },
  ], 2, 1);
  cancelled = await seedRun("org-a", beta, hoursAgo(24), { status: "cancelled", cost: 0.05 }, [], 0, 0);
  latest = await seedRun("org-a", acme, hoursAgo(6), { status: "succeeded", cost: 0.35 }, [
    { kind: "defect", verdict: "confirmed" }, { kind: "defect", verdict: "confirmed" }, { kind: "friction", verdict: null },
  ], 4, 2);
  live = await seedRun("org-a", beta, hoursAgo(2), { status: "running", cost: 0.02 }, [], 0, 0);
  waiting = await seedRun("org-a", beta, hoursAgo(1.5), { status: "queued", cost: 0 }, [], 0, 0);
  theirs = await seedRun("org-b", foreign, hoursAgo(1), { status: "succeeded", cost: 1 }, [{ kind: "defect", verdict: "confirmed" }], 6, 0);
});

test("the home page lists every project of the workspace, the most recently active first, with its last run", async () => {
  const projects = await withOrg(t.db, "org-a", (tx) => workspaceProjects(tx, "org-a"));
  expect(projects.map((p) => p.name)).toEqual(["Fresh", "Beta", "Acme", "Empty"]);
  expect(projects[3]).toEqual({ id: empty, name: "Empty", targetUrl: "https://empty.acme.test/", site: null, lastRun: null });
  expect(projects[2]).toMatchObject({ id: acme, targetUrl: "https://app.acme.test/" });
  expect(projects[2]!.lastRun).toEqual({
    id: latest.id, number: latest.number, status: "succeeded", createdAt: expect.any(Date),
    costUsd: 0.35, tokenCap: null, tokensUsed: 0, confirmed: 2, goalsReached: 4, goalsTotal: 6, projectId: acme, projectName: "Acme", projectSite: null,
  });
  expect(projects[1]!.lastRun).toMatchObject({ id: waiting.id, status: "queued", projectName: "Beta" });
});

test("the workspace's runs are newest first across its projects, each with its project, status, confirmed defects, goals, cost and date", async () => {
  const history = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a"));
  expect(history.runs.map((r) => r.id)).toEqual([waiting.id, live.id, latest.id, cancelled.id, capped.id, failed.id]);
  expect(history.runs[4]).toEqual({
    id: capped.id, number: capped.number, status: "stopped_budget", createdAt: expect.any(Date),
    costUsd: 2, tokenCap: 100_000, tokensUsed: 120_000, confirmed: 1, goalsReached: 2, goalsTotal: 6, projectId: acme, projectName: "Acme", projectSite: null,
  });
  expect(history.runs[3]).toMatchObject({ status: "cancelled", projectId: beta, projectName: "Beta" });
  expect(history.runs[5]).toMatchObject({ status: "failed", confirmed: 0, goalsReached: 0, goalsTotal: 6, costUsd: 0.1 });
  expect(Math.abs(history.runs[5]!.createdAt.getTime() - hoursAgo(72).getTime())).toBeLessThan(60_000);
  expect(history.olderThan).toBeNull();
});

test("the filters show the completed runs or the runs that need attention, and the counts cover every filter", async () => {
  const completed = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { show: "completed" }));
  expect(completed.runs.map((r) => r.id)).toEqual([latest.id]);
  const attention = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { show: "attention" }));
  expect(attention.runs.map((r) => r.id)).toEqual([cancelled.id, capped.id, failed.id]);
  expect(await withOrg(t.db, "org-a", (tx) => runCounts(tx, "org-a"))).toEqual({ all: 6, completed: 1, attention: 3 });
});

test("the history pages through every run, also inside a filter", async () => {
  const page = (options: { show?: "attention"; before?: number }) => withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { size: 2, ...options }));
  const first = await page({});
  expect(first.runs.map((r) => r.id)).toEqual([waiting.id, live.id]);
  expect(first.olderThan).toBe(live.number);
  const second = await page({ before: first.olderThan! });
  expect(second.runs.map((r) => r.id)).toEqual([latest.id, cancelled.id]);
  expect(second.olderThan).toBe(cancelled.number);
  const third = await page({ before: second.olderThan! });
  expect(third.runs.map((r) => r.id)).toEqual([capped.id, failed.id]);
  expect(third.olderThan).toBeNull();
  const exact = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { size: 6 }));
  expect(exact.runs).toHaveLength(6);
  expect(exact.olderThan).toBeNull();
  const attention = await page({ show: "attention" });
  expect(attention.runs.map((r) => r.id)).toEqual([cancelled.id, capped.id]);
  expect(attention.olderThan).toBe(capped.number);
  const rest = await page({ show: "attention", before: attention.olderThan! });
  expect(rest.runs.map((r) => r.id)).toEqual([failed.id]);
  expect(rest.olderThan).toBeNull();
});

test("a project's runs are the same history narrowed to that project, with the project's own counts", async () => {
  const history = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: beta }));
  expect(history.runs.map((r) => r.id)).toEqual([waiting.id, live.id, cancelled.id]);
  expect(await withOrg(t.db, "org-a", (tx) => runCounts(tx, "org-a", beta))).toEqual({ all: 3, completed: 0, attention: 1 });
  const attention = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: acme, show: "attention" }));
  expect(attention.runs.map((r) => r.id)).toEqual([capped.id, failed.id]);
  expect(await withOrg(t.db, "org-a", (tx) => projectHead(tx, "org-a", beta))).toEqual({ id: beta, name: "Beta", targetUrl: "https://beta.acme.test/" });
});

test("the navigation lists the workspace's projects, the most recently active first, and counts its runs", async () => {
  expect(await withOrg(t.db, "org-a", (tx) => workspaceNav(tx, "org-a"))).toEqual({
    projects: [{ id: fresh, name: "Fresh", address: "fresh.acme.test" }, { id: beta, name: "Beta", address: "beta.acme.test" }, { id: acme, name: "Acme", address: "app.acme.test" }, { id: empty, name: "Empty", address: "empty.acme.test" }],
    runs: 6,
  });
});

test("projects that share a name are told apart by their product's host, in the navigation and in the runs", async () => {
  const staging = await project("org-d", "Shop", "https://staging.shop.test/");
  const preview = await project("org-d", "Shop", "https://pr-9.preview.shop.test/checkout");
  const solo = await project("org-d", "Solo", "https://solo.test/app");
  for (const id of [staging, preview, solo]) await seedRun("org-d", id, hoursAgo(1), { status: "succeeded", cost: 0.1 }, [], 0, 0);
  const runs = await withOrg(t.db, "org-d", (tx) => workspaceRuns(tx, "org-d"));
  expect(Object.fromEntries(runs.runs.map((r) => [r.projectId, r.projectSite]))).toEqual({ [staging]: "staging.shop.test", [preview]: "pr-9.preview.shop.test/checkout", [solo]: null });
  const nav = await withOrg(t.db, "org-d", (tx) => workspaceNav(tx, "org-d"));
  expect(Object.fromEntries(nav.projects.map((p) => [p.id, p.address]))).toEqual({ [staging]: "staging.shop.test", [preview]: "pr-9.preview.shop.test/checkout", [solo]: "solo.test" });
  const heroes = await withOrg(t.db, "org-d", (tx) => workspaceProjects(tx, "org-d"));
  expect(Object.fromEntries(heroes.map((p) => [p.id, p.site]))).toEqual({ [staging]: "staging.shop.test", [preview]: "pr-9.preview.shop.test/checkout", [solo]: null });
});

test("a defect being judged again counts as confirmed only once its judge has finished, as on the run page", async () => {
  const judging = await project("org-c", "Judging", "https://judging.test/");
  const run = await seedRun("org-c", judging, hoursAgo(3), { status: "succeeded", cost: 0.1 }, [{ kind: "defect", verdict: "confirmed" }, { kind: "defect", verdict: "confirmed" }], 0, 0);
  await asSystem(t.db, (tx) => tx.insertInto("jobs").values({ org_id: "org-c", run_id: run.id, kind: "judge", position: 10, finding_key: "ana:f0", requested_by: "u1", status: "leased" }).execute());
  const counts = async () => ({
    history: (await withOrg(t.db, "org-c", (tx) => workspaceRuns(tx, "org-c", { projectId: judging }))).runs[0]!.confirmed,
    runPage: runView((await withOrg(t.db, "org-c", (tx) => runSummary(tx, "org-c", run.id)))!).report.confirmed.length,
  });
  expect(await counts()).toEqual({ history: 1, runPage: 1 });
  await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "succeeded" }).where("run_id", "=", run.id).where("kind", "=", "judge").execute());
  expect(await counts()).toEqual({ history: 2, runPage: 2 });
});

test("a defect confirmed by its first judge counts at once, while that judge is still reporting, as on the run page", async () => {
  const judged = await project("org-c", "First judge", "https://first-judge.test/");
  const run = await seedRun("org-c", judged, hoursAgo(2), { status: "running", cost: 0.1 }, [{ kind: "defect", verdict: "confirmed" }], 0, 0);
  await asSystem(t.db, (tx) => tx.insertInto("jobs").values({ org_id: "org-c", run_id: run.id, kind: "judge", position: 10, finding_key: "ana:f0", status: "leased" }).execute());
  const history = (await withOrg(t.db, "org-c", (tx) => workspaceRuns(tx, "org-c", { projectId: judged }))).runs[0]!.confirmed;
  const runPage = runView((await withOrg(t.db, "org-c", (tx) => runSummary(tx, "org-c", run.id)))!).report.confirmed.length;
  expect({ history, runPage }).toEqual({ history: 1, runPage: 1 });
});

test("a run keeps the number of goals it was started with after the plan changes", async () => {
  const changing = await project("org-c", "Changing", "https://changing.test/");
  await seedRun("org-c", changing, hoursAgo(5), { status: "succeeded", cost: 0.2 }, [], 1, 0);
  await withOrg(t.db, "org-c", (tx) => replacePlan(tx, "org-c", changing, { personas: [{ id: "zed", name: "Zed", brief: "b" }], goals: [{ id: "one", instruction: "One thing." }] }));
  const history = await withOrg(t.db, "org-c", (tx) => workspaceRuns(tx, "org-c", { projectId: changing }));
  expect(history.runs[0]).toMatchObject({ goalsReached: 1, goalsTotal: 6 });
});

test("another organisation's projects and runs never appear", async () => {
  const theirProjects = await withOrg(t.db, "org-b", (tx) => workspaceProjects(tx, "org-b"));
  expect(theirProjects.map((p) => p.id)).toEqual([foreign]);
  expect(theirProjects[0]!.lastRun).toMatchObject({ confirmed: 1, goalsReached: 6, projectName: "Acme", projectSite: null });
  const ours = await withOrg(t.db, "org-a", (tx) => workspaceProjects(tx, "org-a"));
  expect(ours.map((p) => p.id)).not.toContain(foreign);
  const ourRuns = await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a"));
  expect(ourRuns.runs.map((r) => r.id)).not.toContain(theirs.id);
  const theirRuns = await withOrg(t.db, "org-b", (tx) => workspaceRuns(tx, "org-b"));
  expect(theirRuns.runs.map((r) => r.id)).toEqual([theirs.id]);
  expect(await withOrg(t.db, "org-b", (tx) => runCounts(tx, "org-b"))).toEqual({ all: 1, completed: 1, attention: 0 });
  expect(await withOrg(t.db, "org-b", (tx) => workspaceNav(tx, "org-b"))).toEqual({ projects: [{ id: foreign, name: "Acme", address: "app.globex.test" }], runs: 1 });
  expect(await withOrg(t.db, "org-b", (tx) => projectHead(tx, "org-b", acme))).toBeNull();
  expect(await withOrg(t.db, "org-b", (tx) => workspaceRuns(tx, "org-b", { projectId: acme }))).toEqual(nothing);
  expect(await withOrg(t.db, "org-b", (tx) => runCounts(tx, "org-b", acme))).toEqual(noCounts);
  expect(await withOrg(t.db, "org-b", (tx) => projectRunCount(tx, "org-b", acme))).toBe(0);
});

test("row-level security hides the workspace's data even from a query that names it", async () => {
  expect(await withOrg(t.db, "org-b", (tx) => workspaceProjects(tx, "org-a"))).toEqual([]);
  expect(await withOrg(t.db, "org-b", (tx) => workspaceRuns(tx, "org-a"))).toEqual(nothing);
  expect(await withOrg(t.db, "org-b", (tx) => workspaceRuns(tx, "org-a", { projectId: acme }))).toEqual(nothing);
  expect(await withOrg(t.db, "org-b", (tx) => runCounts(tx, "org-a"))).toEqual(noCounts);
  expect(await withOrg(t.db, "org-b", (tx) => workspaceNav(tx, "org-a"))).toEqual({ projects: [], runs: 0 });
  expect(await withOrg(t.db, "org-b", (tx) => projectHead(tx, "org-a", acme))).toBeNull();
  expect(await withOrg(t.db, "org-b", (tx) => projectRunCount(tx, "org-a", acme))).toBe(0);
});

test("each query keeps to the workspace it names even where row-level security would not stop it", async () => {
  expect(await asSystem(t.db, (tx) => projectHead(tx, "org-b", acme))).toBeNull();
  expect((await asSystem(t.db, (tx) => workspaceProjects(tx, "org-b"))).map((p) => p.id)).toEqual([foreign]);
  expect((await asSystem(t.db, (tx) => workspaceRuns(tx, "org-b"))).runs.map((r) => r.id)).toEqual([theirs.id]);
  expect(await asSystem(t.db, (tx) => runCounts(tx, "org-b"))).toEqual({ all: 1, completed: 1, attention: 0 });
  expect(await asSystem(t.db, (tx) => workspaceNav(tx, "org-b"))).toEqual({ projects: [{ id: foreign, name: "Acme", address: "app.globex.test" }], runs: 1 });
  const acmeRuns = (await asSystem(t.db, (tx) => workspaceRuns(tx, "org-a", { projectId: acme }))).runs;
  expect(acmeRuns.map((r) => r.projectSite)).toEqual([null, null, null]);
});

test("the plan page counts the project's runs", async () => {
  expect(await withOrg(t.db, "org-a", (tx) => projectRunCount(tx, "org-a", acme))).toBe(3);
  expect(await withOrg(t.db, "org-a", (tx) => projectRunCount(tx, "org-a", empty))).toBe(0);
});
