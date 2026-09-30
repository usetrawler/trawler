import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import type { WorkspacePlanName } from "./plan-limits.ts";
import { ProjectLimitReached, workspacePlan } from "./plans.ts";
import { claimJob } from "./queue.ts";
import { cancelRun, refusalToStart, RunRefused, startRun, TooManyPeople } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, brief: "b" }));
const plan = (n = 2) => ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: people(n), goals: [{ id: "g", instruction: "Get in." }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/agent", maxSteps: 30, replaySteps: 20, createdBy: "u1" };

async function clearQueue() {
  await sql`update jobs set status = 'cancelled', token_hash = null, lease_until = null, finished_at = now() where status in ('queued', 'leased')`.execute(t.db);
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where status in ('queued', 'running')`.execute(t.db);
}
beforeAll(clearQueue);
afterEach(clearQueue);

let orgs = 0;
async function workspace(on: WorkspacePlanName | "no row" = "no row", extraProjects = 0) {
  const org = `org-plan-${++orgs}`;
  await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await asSystem(t.db, async (tx) => {
    await tx.deleteFrom("workspace_plans").where("org_id", "=", org).execute();
    if (on !== "no row") await tx.insertInto("workspace_plans").values({ org_id: org, plan: on, extra_projects: extraProjects, set_by: "test" }).execute();
  });
  const create = (config = plan(), extra: { demo?: boolean } = {}) => withOrg(t.db, org, (tx) => createProject(tx, org, config, keys, extra));
  const start = (project: string) => withOrg(t.db, org, (tx) => startRun(tx, org, project, keys, options));
  const startAndStop = async (project: string) => {
    const run = await start(project);
    await withOrg(t.db, org, (tx) => cancelRun(tx, org, run.id, "stopped"));
    return run;
  };
  return { org, create, start, startAndStop };
}

const refusal = (attempt: Promise<unknown>) => attempt.then(() => null, (e: unknown) => e);

describe("projects per workspace", () => {
  test("a workspace without a plan is on Free and keeps one project, the demo aside, and the refusal says what to do", async () => {
    const w = await workspace();
    expect(await withOrg(t.db, w.org, (tx) => workspacePlan(tx, w.org))).toEqual({ plan: "free", limits: { projects: 1, runsPerDay: 3, people: 4 } });
    await w.create(plan(), { demo: true });
    await w.create();
    const err = await refusal(w.create());
    expect(err).toBeInstanceOf(ProjectLimitReached);
    expect((err as Error).message).toBe("The Free plan includes 1 project, and this workspace has 1 project already. Plan new runs on the one you have, test other products on your own machine with the local runner, or write to contact@usetrawler.com about the Team plan.");
    await expect(w.create(plan(), { demo: true })).resolves.toEqual(expect.any(String));
    const counts = await sql<{ demo: boolean; n: string }>`select demo, count(*) as n from projects where org_id = ${w.org} group by demo order by demo`.execute(t.db);
    expect(counts.rows).toEqual([{ demo: false, n: "1" }, { demo: true, n: "2" }]);
  });

  test("Team keeps three projects plus the ones we add, and Enterprise has no limit", async () => {
    const team = await workspace("team", 1);
    for (let i = 0; i < 4; i++) await team.create();
    expect((await refusal(team.create()) as Error).message).toBe("The Team plan includes 4 projects, and this workspace has 4 projects already. Plan new runs on the one you have, test other products on your own machine with the local runner, or write to contact@usetrawler.com to raise it.");
    const enterprise = await workspace("enterprise");
    for (let i = 0; i < 5; i++) await enterprise.create();
  });

  test("a workspace over its limit, such as one that had more projects before plans, is told how many it has", async () => {
    const w = await workspace("enterprise");
    await w.create();
    await w.create();
    await asSystem(t.db, (tx) => tx.deleteFrom("workspace_plans").where("org_id", "=", w.org).execute());
    expect((await refusal(w.create()) as Error).message).toMatch(/^The Free plan includes 1 project, and this workspace has 2 projects already\./);
  });

  test("two projects created at once on Free leave exactly one", async () => {
    const w = await workspace();
    const results = await Promise.allSettled([w.create(), w.create()]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ProjectLimitReached);
  });

  test("another workspace's projects do not count", async () => {
    const a = await workspace();
    await a.create();
    const b = await workspace();
    await expect(b.create()).resolves.toEqual(expect.any(String));
  });
});

describe("hosted runs a day", () => {
  test("Free starts three runs a day, the fourth is refused before and under the start lock, and yesterday's runs do not count", async () => {
    const w = await workspace();
    const project = await w.create();
    const first = await w.startAndStop(project);
    await w.startAndStop(project);
    await w.startAndStop(project);
    const message = "The Free plan includes 3 hosted runs a day, and this workspace has started them all today. Try again after midnight UTC, run it on your own machine with the local runner, or write to contact@usetrawler.com about the Team plan.";
    expect((await withOrg(t.db, w.org, (tx) => refusalToStart(tx, w.org, project)))?.message).toBe(message);
    const err = await refusal(w.start(project));
    expect(err).toBeInstanceOf(RunRefused);
    expect((err as Error).message).toBe(message);
    expect(Number((await sql<{ n: string }>`select count(*) as n from runs where org_id = ${w.org}`.execute(t.db)).rows[0]!.n)).toBe(3);

    await sql`update runs set created_at = date_trunc('day', now(), 'UTC') - interval '1 second' where id = ${first.id}`.execute(t.db);
    await expect(w.start(project)).resolves.toMatchObject({ number: 4 });
  });

  test("Team starts more than three a day, and another workspace's runs do not count", async () => {
    const free = await workspace();
    const freeProject = await free.create();
    for (let i = 0; i < 3; i++) await free.startAndStop(freeProject);
    const team = await workspace("team");
    const project = await team.create();
    for (let i = 0; i < 4; i++) await team.startAndStop(project);
    const other = await workspace();
    await expect(other.start(await other.create())).resolves.toMatchObject({ number: 1 });
  });

  test("two Starts at once on Free with one run left start only one", async () => {
    const w = await workspace("enterprise");
    const a = await w.create();
    const b = await w.create();
    await asSystem(t.db, (tx) => tx.deleteFrom("workspace_plans").where("org_id", "=", w.org).execute());
    await w.startAndStop(a);
    await w.startAndStop(a);
    const results = await Promise.allSettled([w.start(a), w.start(b)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RunRefused);
  });
});

describe("people in a run", () => {
  test("Free runs up to four people and refuses five with what to do, and Team runs five", async () => {
    const w = await workspace("enterprise");
    const four = await w.create(plan(4));
    const five = await w.create(plan(5));
    await asSystem(t.db, (tx) => tx.deleteFrom("workspace_plans").where("org_id", "=", w.org).execute());
    await expect(w.startAndStop(four)).resolves.toMatchObject({ number: 1 });
    const message = "The Free plan takes up to 4 people in a run, and this plan has 5. Remove people from the plan, run it on your own machine with the local runner, or write to contact@usetrawler.com about the Team plan.";
    const refused = await withOrg(t.db, w.org, (tx) => refusalToStart(tx, w.org, five));
    expect(refused).toBeInstanceOf(TooManyPeople);
    expect(refused?.message).toBe(message);
    expect((await refusal(w.start(five)) as Error).message).toBe(message);

    const team = await workspace("team");
    await expect(team.start(await team.create(plan(5)))).resolves.toMatchObject({ number: 1 });
  });
});

describe("the queue", () => {
  test("a Team or Enterprise run is claimed before an older Free run, and Free runs keep their order", async () => {
    const free = await workspace();
    const older = await free.start(await free.create(plan(1)));
    const free2 = await workspace();
    const newer = await free2.start(await free2.create(plan(1)));
    const team = await workspace("team");
    const paid = await team.start(await team.create(plan(1)));
    const enterprise = await workspace("enterprise");
    const big = await enterprise.start(await enterprise.create(plan(1)));
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = await claimJob(t.db, keys);
      order.push(job!.runId);
      await sql`update jobs set status = 'succeeded', token_hash = null, lease_until = null, finished_at = now() where id = ${job!.jobId}`.execute(t.db);
    }
    expect(order).toEqual([paid.id, big.id, older.id, newer.id]);
  });
});

describe("the queue once a run has started", () => {
  test("a Free run that has started keeps its place ahead of a Team run that has not, so it is not starved into its time limit", async () => {
    const free = await workspace();
    const started = await free.start(await free.create(plan(2)));
    const first = await claimJob(t.db, keys);
    expect(first!.runId).toBe(started.id);
    await sql`update jobs set status = 'succeeded', token_hash = null, lease_until = null, finished_at = now() where id = ${first!.jobId}`.execute(t.db);
    const team = await workspace("team");
    const paid = await team.start(await team.create(plan(1)));
    expect((await claimJob(t.db, keys))!.runId).toBe(started.id);
    expect((await claimJob(t.db, keys))!.runId).toBe(paid.id);
  });
});

describe("who sets the plan", () => {
  test("a workspace can read its own plan but neither write it nor see another's", async () => {
    const w = await workspace("team");
    const other = await workspace("enterprise");
    await expect(withOrg(t.db, w.org, (tx) => tx.updateTable("workspace_plans").set({ plan: "enterprise" }).where("org_id", "=", w.org).execute())).rejects.toThrow(/permission denied/);
    await expect(withOrg(t.db, w.org, (tx) => tx.insertInto("workspace_plans").values({ org_id: w.org, plan: "enterprise", set_by: "me" }).execute())).rejects.toThrow(/permission denied/);
    await expect(withOrg(t.db, w.org, (tx) => tx.selectFrom("workspace_plans").select("org_id").execute())).resolves.toEqual([{ org_id: w.org }]);
    expect((await withOrg(t.db, w.org, (tx) => workspacePlan(tx, other.org))).plan).toBe("free");
  });
});
