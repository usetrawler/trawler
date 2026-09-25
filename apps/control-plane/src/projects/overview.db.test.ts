import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { startRun } from "../runs/runs.ts";
import { projectRunCount, projectRuns, workspaceProjects } from "./overview.ts";
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
let empty = "";
let foreign = "";
const runs: Array<{ id: string; number: number }> = [];

type Finding = { kind: "defect" | "friction"; verdict: "confirmed" | "refuted" | "inconclusive" | null };

async function seedRun(orgId: string, projectId: string, at: Date, set: { status: string; cost: number; tokenCap?: number; tokensUsed?: number }, findings: Finding[], reached: number, failed: number) {
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
    const outcomes = [...Array(reached).fill("reached"), ...Array(failed).fill("failed")] as string[];
    const slots = config.personas.flatMap((p) => config.goals.map((g) => [p.id, g.id] as const));
    if (outcomes.length) {
      await tx.insertInto("goal_outcomes").values(outcomes.map((status, i) => ({ org_id: orgId, run_id: run.id, persona_key: slots[i]![0], goal: slots[i]![1], status }))).execute();
    }
  });
  return run;
}

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  acme = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  empty = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "Empty", targetUrl: "https://empty.acme.test/" }, keys));
  foreign = await withOrg(t.db, "org-b", (tx) => createProject(tx, "org-b", { ...config, name: "Globex" }, keys));
  await asSystem(t.db, (tx) => tx.updateTable("projects").set({ created_at: hoursAgo(100) }).where("id", "=", acme).execute());
  await asSystem(t.db, (tx) => tx.updateTable("projects").set({ created_at: hoursAgo(12) }).where("id", "=", empty).execute());

  runs.push(await seedRun("org-a", acme, hoursAgo(72), { status: "failed", cost: 0.1 }, [], 0, 0));
  runs.push(await seedRun("org-a", acme, hoursAgo(48), { status: "stopped_budget", cost: 2, tokenCap: 100_000, tokensUsed: 120_000 }, [
    { kind: "defect", verdict: "confirmed" }, { kind: "defect", verdict: "refuted" }, { kind: "defect", verdict: "inconclusive" }, { kind: "defect", verdict: null }, { kind: "friction", verdict: null },
  ], 2, 1));
  runs.push(await seedRun("org-a", acme, hoursAgo(24), { status: "succeeded", cost: 0.35 }, [
    { kind: "defect", verdict: "confirmed" }, { kind: "defect", verdict: "confirmed" }, { kind: "friction", verdict: null },
  ], 4, 2));
  await seedRun("org-b", foreign, hoursAgo(1), { status: "succeeded", cost: 1 }, [{ kind: "defect", verdict: "confirmed" }], 6, 0);
});

test("the home page lists every project of the workspace, the most recently active first, with its last run", async () => {
  const projects = await withOrg(t.db, "org-a", (tx) => workspaceProjects(tx, "org-a"));
  expect(projects.map((p) => p.name)).toEqual(["Empty", "Acme"]);
  expect(projects[0]).toEqual({ id: empty, name: "Empty", targetUrl: "https://empty.acme.test/", runs: 0, lastRun: null });
  expect(projects[1]).toMatchObject({ id: acme, targetUrl: "https://app.acme.test/", runs: 3 });
  expect(projects[1]!.lastRun).toEqual({
    id: runs[2]!.id, number: runs[2]!.number, status: "succeeded", createdAt: expect.any(Date),
    costUsd: 0.35, tokenCap: null, tokensUsed: 0, confirmed: 2, goalsReached: 4, goalsTotal: 6,
  });
});

test("a project's run history is newest first, with each run's status, confirmed defects, goals, cost and date", async () => {
  const history = (await withOrg(t.db, "org-a", (tx) => projectRuns(tx, "org-a", acme)))!;
  expect(history.project).toEqual({ id: acme, name: "Acme", targetUrl: "https://app.acme.test/" });
  expect(history.runs.map((r) => r.id)).toEqual([runs[2]!.id, runs[1]!.id, runs[0]!.id]);
  expect(history.runs[1]).toEqual({
    id: runs[1]!.id, number: runs[1]!.number, status: "stopped_budget", createdAt: expect.any(Date),
    costUsd: 2, tokenCap: 100_000, tokensUsed: 120_000, confirmed: 1, goalsReached: 2, goalsTotal: 6,
  });
  expect(history.runs[2]).toMatchObject({ status: "failed", confirmed: 0, goalsReached: 0, goalsTotal: 6, costUsd: 0.1 });
  expect(Math.abs(history.runs[2]!.createdAt.getTime() - hoursAgo(72).getTime())).toBeLessThan(60_000);
  expect(history.olderThan).toBeNull();
});

test("the history pages through every past run", async () => {
  const first = (await withOrg(t.db, "org-a", (tx) => projectRuns(tx, "org-a", acme, { size: 2 })))!;
  expect(first.runs.map((r) => r.id)).toEqual([runs[2]!.id, runs[1]!.id]);
  expect(first.olderThan).toBe(runs[1]!.number);
  const second = (await withOrg(t.db, "org-a", (tx) => projectRuns(tx, "org-a", acme, { size: 2, before: first.olderThan! })))!;
  expect(second.runs.map((r) => r.id)).toEqual([runs[0]!.id]);
  expect(second.olderThan).toBeNull();
});

test("a run keeps the number of goals it was started with after the plan changes", async () => {
  const other = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "Changing" }, keys));
  await seedRun("org-a", other, hoursAgo(5), { status: "succeeded", cost: 0.2 }, [], 1, 0);
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", other, { personas: [{ id: "zed", name: "Zed", brief: "b" }], goals: [{ id: "one", instruction: "One thing." }] }));
  const history = (await withOrg(t.db, "org-a", (tx) => projectRuns(tx, "org-a", other)))!;
  expect(history.runs[0]).toMatchObject({ goalsReached: 1, goalsTotal: 6 });
});

test("another organisation's projects and runs never appear", async () => {
  const theirs = await withOrg(t.db, "org-b", (tx) => workspaceProjects(tx, "org-b"));
  expect(theirs.map((p) => p.id)).toEqual([foreign]);
  expect(theirs[0]!.lastRun).toMatchObject({ confirmed: 1, goalsReached: 6 });
  const ours = await withOrg(t.db, "org-a", (tx) => workspaceProjects(tx, "org-a"));
  expect(ours.map((p) => p.id)).not.toContain(foreign);
  expect(await withOrg(t.db, "org-b", (tx) => projectRuns(tx, "org-b", acme))).toBeNull();
  expect(await withOrg(t.db, "org-b", (tx) => projectRunCount(tx, "org-b", acme))).toBe(0);
});

test("row-level security hides the workspace's data even from a query that names it", async () => {
  expect(await withOrg(t.db, "org-b", (tx) => workspaceProjects(tx, "org-a"))).toEqual([]);
  expect(await withOrg(t.db, "org-b", (tx) => projectRuns(tx, "org-a", acme))).toBeNull();
  expect(await withOrg(t.db, "org-b", (tx) => projectRunCount(tx, "org-a", acme))).toBe(0);
});

test("the plan page counts the project's runs", async () => {
  expect(await withOrg(t.db, "org-a", (tx) => projectRunCount(tx, "org-a", acme))).toBe(3);
  expect(await withOrg(t.db, "org-a", (tx) => projectRunCount(tx, "org-a", empty))).toBe(0);
});
