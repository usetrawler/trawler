import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { ProjectConfigSchema, type PullRequest } from "@usetrawler/protocol";
import { setModelKey } from "../credentials/credentials.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { projectHead, workspaceRuns } from "../projects/overview.ts";
import { PAUSED } from "./limits.ts";
import { claimJob, ingestEvents } from "./queue.ts";
import { runView } from "./report.ts";
import { MAX_LIVE_OWN_RUNS, pauseProject, projectRunState, refusalToStart, RunInProgress, RunRefused, runSummary, startRun, TooManyOwnRuns, type StartRunOptions } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }],
  goals: [{ id: "g", instruction: "Get in.", personaId: "ana" }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/agent", maxSteps: 30, replaySteps: 20, createdBy: "u1", price: { promptUsdPerMtok: 1, completionUsdPerMtok: 1 } };
const CI_URL = "http://localhost:3000";

let orgs = 0;
async function workspace() {
  const org = `org-${++orgs}`;
  await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await withOrg(t.db, org, (tx) => setModelKey(tx, org, { provider: "openrouter", key: `sk-or-v1-${"a".repeat(40)}` }, "u1", keys));
  const project = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
  const start = (over: Partial<StartRunOptions> = {}, projectId = project) => withOrg(t.db, org, (tx) => startRun(tx, org, projectId, keys, { ...options, ...over }));
  const pr = (number: number, over: Partial<StartRunOptions> = {}, repository = "acme/shop") => start({ execution: "own", targetUrl: CI_URL, pullRequest: { number, repository }, ...over });
  const state = (id: string) => withOrg(t.db, org, async (tx) => (await runSummary(tx, org, id))!);
  const live = async (projectId = project) => (await asSystem(t.db, (tx) => tx.selectFrom("runs").select(["id", "number"]).where("project_id", "=", projectId).where("status", "in", ["queued", "running"]).orderBy("number").execute()));
  const refusal = (scope: Parameters<typeof refusalToStart>[5] = {}) => withOrg(t.db, org, (tx) => refusalToStart(tx, org, project, "workspace", undefined, scope));
  return { org, project, start, pr, state, live, refusal };
}

afterEach(async () => {
  await sql`update jobs set status = 'cancelled', token_hash = null, lease_until = null, finished_at = now() where status in ('queued', 'leased')`.execute(t.db);
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where status in ('queued', 'running')`.execute(t.db);
});

describe("a newer push to the same pull request", () => {
  test("stops the older live run of that pull request as superseded, cancels its waiting jobs, and starts the new one", async () => {
    const w = await workspace();
    const older = await w.pr(12, {}, "Acme/Shop");
    const newer = await w.pr(12, {}, " acme/shop ");
    expect(newer.number).toBe(older.number + 1);
    const stopped = await w.state(older.id);
    expect(stopped).toMatchObject({ status: "cancelled", cancelReason: "superseded" });
    expect(stopped.jobs.every((j) => j.status === "cancelled")).toBe(true);
    expect(runView(stopped).headline).toBe("A newer push to the same pull request started another run, so this one was stopped.");
    expect(await w.live()).toEqual([{ id: newer.id, number: newer.number }]);
  });

  test("replaces a run that is already running, and the runner on its job is told to stop on its next events", async () => {
    const w = await workspace();
    const older = await w.pr(5);
    const job = await claimJob(t.db, keys, { execution: "own", orgId: w.org, projectId: null, runId: older.id });
    expect(job?.runId).toBe(older.id);
    expect((await w.state(older.id)).status).toBe("running");
    await w.pr(5);
    expect(await w.state(older.id)).toMatchObject({ status: "cancelled", cancelReason: "superseded" });
    expect(await ingestEvents(t.db, job!.token, [])).toEqual({ cancel: true });
  });

  test("leaves runs of other pull requests, of another repository, and runs without a pull request alone", async () => {
    const w = await workspace();
    const other = await w.pr(1);
    const sameNumberElsewhere = await w.pr(2, {}, "acme/docs");
    const plain = await w.start({ execution: "own", targetUrl: CI_URL });
    await w.pr(2);
    expect(await w.live()).toHaveLength(4);
    expect((await w.state(other.id)).status).toBe("queued");
    expect((await w.state(sameNumberElsewhere.id)).status).toBe("queued");
    expect((await w.state(plain.id)).status).toBe("queued");
  });

  test("replaces a hosted run of the same pull request too, which an app start would be refused for", async () => {
    const w = await workspace();
    const pullRequest: PullRequest = { number: 9, repository: "acme/shop" };
    const older = await w.start({ pullRequest });
    await expect(w.start()).rejects.toBeInstanceOf(RunInProgress);
    const newer = await w.start({ pullRequest });
    expect(newer.number).toBe(older.number + 1);
    expect((await w.state(older.id)).cancelReason).toBe("superseded");
    expect(await w.live()).toEqual([{ id: newer.id, number: newer.number }]);
  });

  test("two near-simultaneous starts for one pull request leave exactly one live run for it", async () => {
    const w = await workspace();
    const started = await Promise.all([w.pr(7), w.pr(7), w.pr(7), w.pr(7)]);
    expect(new Set(started.map((r) => r.id)).size).toBe(4);
    const live = await w.live();
    expect(live).toHaveLength(1);
    const all = await asSystem(t.db, (tx) => tx.selectFrom("runs").select(["id", "status", "cancel_reason"]).where("project_id", "=", w.project).execute());
    expect(all.filter((r) => r.status === "cancelled").map((r) => r.cancel_reason)).toEqual(["superseded", "superseded", "superseded"]);
    expect(live[0]!.number).toBe(Math.max(...started.map((r) => r.number)));
  });

  test("keeps the older run when the new start is refused, because the whole start rolls back", async () => {
    const w = await workspace();
    const older = await w.pr(3);
    await asSystem(t.db, (tx) => tx.updateTable("projects").set({ paused_at: new Date(), paused_by: "u1" }).where("id", "=", w.project).execute());
    await expect(w.pr(3)).rejects.toThrow(PAUSED);
    expect((await w.state(older.id)).status).toBe("queued");
  });
});

describe("runs for different pull requests", () => {
  test("run in parallel, next to each other and next to a run started from the app", async () => {
    const w = await workspace();
    const [a, b] = [await w.pr(1), await w.pr(2)];
    const app = await w.start();
    const own = await w.pr(3, { pullRequest: undefined });
    expect((await w.live()).map((r) => r.id)).toEqual([a.id, b.id, app.id, own.id]);
  });

  test("an app run still refuses another app run, and a CI run on the project's own target refuses both, naming the run in the way", async () => {
    const w = await workspace();
    const first = await w.start();
    const second = await w.start().then(() => null, (e: unknown) => e);
    expect(second).toBeInstanceOf(RunInProgress);
    expect((second as RunInProgress).run).toEqual({ id: first.id, number: first.number });
    expect((second as Error).message).toBe("Run 0001 is still going on this project. Wait for it to finish or stop it, then start again.");
    const sharedTarget = await w.start({ execution: "own", pullRequest: { number: 4, repository: "acme/shop" } }).then(() => null, (e: unknown) => e);
    expect(sharedTarget).toBeInstanceOf(RunInProgress);
    expect(await w.refusal()).toBeInstanceOf(RunInProgress);
    expect(await w.refusal({ execution: "own", targetUrl: CI_URL, pullRequest: { number: 1 } })).toBeNull();
  });

  test("an own run on the project's target also holds off an app run, while isolated own runs do not", async () => {
    const w = await workspace();
    await w.pr(1);
    await w.pr(2);
    expect(await w.refusal()).toBeNull();
    const onTarget = await w.start({ execution: "own" });
    expect(await w.refusal()).toMatchObject({ run: { id: onTarget.id } });
    await expect(w.start()).rejects.toBeInstanceOf(RunInProgress);
    expect(await w.refusal({ execution: "own", targetUrl: CI_URL })).toBeNull();
  });

  test("the database still refuses a second live run on the shared target, and not a second isolated one", async () => {
    const w = await workspace();
    const first = await w.start();
    const copy = (override: boolean) => sql`insert into runs (org_id, project_id, plan_id, plan_name, number, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by, execution, target_override)
      select org_id, project_id, plan_id, plan_name, ${override ? 98 : 99}::int, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by, 'own', ${override}::boolean from runs where id = ${first.id}`;
    await expect(copy(false).execute(t.db)).rejects.toThrow(/runs_one_active_per_project/);
    await expect(copy(true).execute(t.db)).resolves.toBeDefined();
  });

  test("the start panel offers a start and the runs list shows every live run", async () => {
    const w = await workspace();
    const [a, b] = [await w.pr(1), await w.pr(2)];
    expect(await w.refusal()).toBeNull();
    const state = await withOrg(t.db, w.org, (tx) => projectRunState(tx, w.org, w.project));
    expect(state).toEqual({ paused: false, liveRun: { id: a.id, number: a.number, more: 1 } });
    const history = await withOrg(t.db, w.org, (tx) => workspaceRuns(tx, w.org, { projectId: w.project }));
    expect(history.runs.map((r) => [r.number, r.status])).toEqual([[b.number, "queued"], [a.number, "queued"]]);
    expect(await withOrg(t.db, w.org, (tx) => projectHead(tx, w.org, w.project))).not.toBeNull();
  });

  test("pausing the project stops all of them after one confirmation", async () => {
    const w = await workspace();
    const [a, b, c] = [await w.pr(1), await w.pr(2), await w.pr(3)];
    const pause = (confirmed: string | null) => withOrg(t.db, w.org, (tx) => pauseProject(tx, w.org, w.project, "u2", confirmed));
    expect(await pause(null)).toEqual({ unconfirmed: { id: a.id, number: a.number, more: 2 } });
    expect(await pause(b.id)).toEqual({ unconfirmed: { id: a.id, number: a.number, more: 2 } });
    expect(await pause(a.id)).toEqual({ stopped: { id: a.id, number: a.number }, alsoStopped: 2 });
    expect(await w.live()).toEqual([]);
    for (const run of [a, b, c]) expect((await w.state(run.id)).cancelReason).toBe("paused");
  });
});

describe("the ceiling on runs in CI jobs", () => {
  test(`refuses a run beyond ${MAX_LIVE_OWN_RUNS} live own runs in the workspace, with a message that says so, while a push still replaces its own run`, async () => {
    const w = await workspace();
    for (let n = 1; n <= MAX_LIVE_OWN_RUNS; n++) await w.pr(n);
    const refused = await w.pr(100).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(TooManyOwnRuns);
    expect(refused).toBeInstanceOf(RunRefused);
    expect((refused as Error).message).toContain(`${MAX_LIVE_OWN_RUNS} runs going in CI jobs`);
    expect((refused as Error).message).toContain("replaces its earlier run");
    expect(await w.refusal({ execution: "own", targetUrl: CI_URL, pullRequest: { number: 100 } })).toBeInstanceOf(TooManyOwnRuns);
    expect(await w.refusal({ execution: "own", targetUrl: CI_URL, pullRequest: { number: 3, repository: "acme/shop" } })).toBeNull();
    await expect(w.pr(3)).resolves.toBeDefined();
    expect(await w.live()).toHaveLength(MAX_LIVE_OWN_RUNS);
    expect(await w.refusal()).toBeNull();
    const [one] = await w.live();
    await asSystem(t.db, (tx) => tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped" }).where("id", "=", one!.id).execute());
    await expect(w.pr(100)).resolves.toBeDefined();
  });

  test("counts the workspace's runs across projects, leaves app runs out of it and another workspace's runs alone", async () => {
    const w = await workspace();
    const second = await withOrg(t.db, w.org, (tx) => createProject(tx, w.org, config, keys));
    for (let n = 1; n <= MAX_LIVE_OWN_RUNS - 1; n++) await w.pr(n, {}, "acme/shop");
    await w.pr(50, {}, "acme/docs").then(() => undefined);
    await expect(w.start({ execution: "own", targetUrl: CI_URL, pullRequest: { number: 60, repository: "acme/web" } }, second)).rejects.toBeInstanceOf(TooManyOwnRuns);
    await expect(w.start({}, second)).resolves.toBeDefined();
    const other = await workspace();
    await expect(other.pr(1)).resolves.toBeDefined();
  });
});
