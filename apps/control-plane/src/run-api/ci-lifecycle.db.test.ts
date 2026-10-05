import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, ProjectConfigSchema } from "@usetrawler/protocol";
import { createApiToken } from "../api-tokens/tokens.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { handleClaim } from "../runner-api/handlers.ts";
import { CLIENT_GONE_MINUTES, UNCLAIMED_RUN_MINUTES } from "../runs/limits.ts";
import { claimJob, stopRunsOfGoneClients, stopUnclaimedRuns } from "../runs/queue.ts";
import { cancelLiveRuns, startRun } from "../runs/runs.ts";
import { handleGetRun, handleStartRun, handleStopRun, type RunApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const deps: RunApiDeps = { db: t.db, keys, baseUrl: "https://app.trawler.test", openRouterUrl: "http://unused.test", trawlerPays: true, priceOf: async () => null };

const projects: Record<string, string> = {};
const orgOf = (name: string) => (name.startsWith("y") ? "org-y" : "org-x");
const mint = (org: string, projectId?: string) => withOrg(t.db, org, (tx) => createApiToken(tx, org, "u1", { name: "ci", ...(projectId ? { projectId } : {}) }));
const start = (name: string, execution: "own" | "hosted" = "own") => withOrg(t.db, orgOf(name), (tx) => startRun(tx, orgOf(name), projects[name]!, keys, { ...options, execution }));
const row = (id: string) => asSystem(t.db, (tx) => tx.selectFrom("runs").select(["status", "cancel_reason"]).where("id", "=", id).executeTakeFirstOrThrow());
const stop = (token: string | undefined, id: string) =>
  handleStopRun(new Request(`http://x/api/v1/runs/${id}/stop`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }), id, deps);

beforeAll(async () => {
  for (const org of ["org-x", "org-y"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  for (const name of ["stopA", "stopB", "claimA", "claimB", "sweepOld", "sweepNew", "sweepHosted", "sweepRunning", "yOther", "goneStale", "goneFresh", "goneApp", "goneRunning"]) {
    projects[name] = await withOrg(t.db, orgOf(name), (tx) => createProject(tx, orgOf(name), { ...config, name }, keys));
  }
});

describe("stopping a run from CI", () => {
  test("stops a queued run with the CI reason, cancels its waiting jobs and frees the project; stopping again changes nothing", async () => {
    const { token } = await mint("org-x");
    const run = await start("stopA");
    await expect(start("stopA")).rejects.toThrow(/still going/);
    const stopped = await stop(token, run.id);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ id: run.id, status: "cancelled", stopped: true });
    expect(await row(run.id)).toEqual({ status: "cancelled", cancel_reason: "stopped_from_ci" });
    const jobs = await asSystem(t.db, (tx) => tx.selectFrom("jobs").select("status").where("run_id", "=", run.id).execute());
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
    const again = await stop(token, run.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: run.id, status: "cancelled", stopped: false });
    expect(await row(run.id)).toEqual({ status: "cancelled", cancel_reason: "stopped_from_ci" });
    const next = await start("stopA");
    expect(next.number).toBe(run.number + 1);
    await stop(token, next.id);
  });

  test("stops a run that a runner has started on, and leaves a finished run as it ended", async () => {
    const { token } = await mint("org-x");
    const run = await start("stopB");
    const job = await claimJob(t.db, keys, { execution: "own", orgId: "org-x", projectId: null, runId: run.id });
    expect(job?.runId).toBe(run.id);
    expect((await row(run.id)).status).toBe("running");
    expect(await (await stop(token, run.id)).json()).toEqual({ id: run.id, status: "cancelled", stopped: true });
    await asSystem(t.db, (tx) => tx.updateTable("runs").set({ status: "succeeded" as never, cancel_reason: null }).where("id", "=", run.id).execute());
    expect(await (await stop(token, run.id)).json()).toEqual({ id: run.id, status: "succeeded", stopped: false });
  });

  test("only reaches runs in the token's scope", async () => {
    const run = await start("stopA");
    const other = await start("stopB");
    const projectToken = (await mint("org-x", projects.stopA)).token;
    expect((await stop(projectToken, other.id)).status).toBe(404);
    expect((await row(other.id)).status).not.toBe("cancelled");
    expect((await stop((await mint("org-y")).token, run.id)).status).toBe(404);
    expect((await stop((await mint("org-x")).token, "6b8f2f0e-6c43-4a53-9a2e-5d6d8c1f7a10")).status).toBe(404);
    expect((await stop((await mint("org-x")).token, "not-an-id")).status).toBe(404);
    expect((await stop(undefined, run.id)).status).toBe(401);
    expect((await row(run.id)).status).toBe("queued");
    expect(await (await stop(projectToken, run.id)).json()).toMatchObject({ stopped: true });
    await stop((await mint("org-x")).token, other.id);
  });
});

describe("claiming the jobs of one run", () => {
  const claimRun = async (scope: { orgId: string; projectId: string | null }, runId: string | undefined) => {
    const runIds: string[] = [];
    for (let job = await claimJob(t.db, keys, { execution: "own", ...scope, runId }); job; job = await claimJob(t.db, keys, { execution: "own", ...scope, runId })) runIds.push(job.runId);
    return runIds;
  };

  test("a runner given a run gets that run's jobs only, within the token's workspace and project", async () => {
    const a = await start("claimA");
    const b = await start("claimB");
    const foreign = await start("yOther");
    expect(await claimRun({ orgId: "org-x", projectId: null }, foreign.id)).toEqual([]);
    expect(await claimRun({ orgId: "org-x", projectId: projects.claimA! }, b.id)).toEqual([]);
    expect(await claimRun({ orgId: "org-y", projectId: null }, a.id)).toEqual([]);
    const taken = await claimRun({ orgId: "org-x", projectId: null }, b.id);
    expect(taken.length).toBeGreaterThan(0);
    expect(new Set(taken)).toEqual(new Set([b.id]));
    const left = await asSystem(t.db, (tx) => tx.selectFrom("jobs").select("status").where("run_id", "=", a.id).execute());
    expect(left.every((j) => j.status === "queued")).toBe(true);
    expect((await claimRun({ orgId: "org-x", projectId: projects.claimA! }, undefined))[0]).toBe(a.id);
  });

  test("the claim endpoint reads the run from its body, and a runner without one keeps taking any job of its workspace", async () => {
    const [aRun, bRun] = (await asSystem(t.db, (tx) => tx.selectFrom("runs").select("id").where("project_id", "in", [projects.claimA!, projects.claimB!]).orderBy("number").execute())).map((r) => r.id);
    await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "queued", token_hash: null, lease_until: null }).where("run_id", "in", [aRun!, bRun!]).execute());
    const { token } = await mint("org-x");
    const projectToken = (await mint("org-x", projects.claimA)).token;
    const call = (body?: unknown, as = token) =>
      handleClaim(new Request("http://x/claim", { method: "POST", headers: { authorization: `Bearer ${as}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) }, body: body === undefined ? undefined : JSON.stringify(body) }), { db: t.db, keys, runnerToken: "pool-token-for-hosted-runners-0000", claimWaitMs: 0 });
    const only = await call({ run: bRun });
    expect(only.status).toBe(200);
    expect((await only.json()).runId).toBe(bRun);
    await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", bRun!).execute());
    expect((await call({ run: bRun })).status).toBe(204);
    expect((await call({ run: "6b8f2f0e-6c43-4a53-9a2e-5d6d8c1f7a10" })).status).toBe(204);
    expect((await call({ run: "nope" })).status).toBe(400);
    const anyJob = await call(undefined, projectToken);
    expect(anyJob.status).toBe(200);
    expect((await anyJob.json()).runId).toBe(aRun);
  });
});

describe("a run no runner picks up", () => {
  const age = (id: string, minutes: number) => asSystem(t.db, (tx) => tx.updateTable("runs").set({ created_at: sql<Date>`now() - make_interval(mins => ${minutes})` }).where("id", "=", id).execute());

  test("is cancelled after the time limit, which frees its project, while younger, hosted and started runs are left", async () => {
    const old = await start("sweepOld");
    const fresh = await start("sweepNew");
    const hosted = await start("sweepHosted", "hosted");
    const running = await start("sweepRunning");
    await claimJob(t.db, keys, { execution: "own", orgId: "org-x", projectId: projects.sweepRunning!, runId: running.id });
    await age(old.id, UNCLAIMED_RUN_MINUTES + 1);
    await age(fresh.id, UNCLAIMED_RUN_MINUTES - 5);
    await age(hosted.id, UNCLAIMED_RUN_MINUTES + 60);
    await age(running.id, UNCLAIMED_RUN_MINUTES + 60);
    expect(await stopUnclaimedRuns(t.db)).toBe(1);
    expect(await row(old.id)).toEqual({ status: "cancelled", cancel_reason: "unclaimed" });
    expect((await row(fresh.id)).status).toBe("queued");
    expect((await row(hosted.id)).status).toBe("queued");
    expect((await row(running.id)).status).toBe("running");
    const jobs = await asSystem(t.db, (tx) => tx.selectFrom("jobs").select("status").where("run_id", "=", old.id).execute());
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
    expect(await stopUnclaimedRuns(t.db)).toBe(0);
    await expect(start("sweepOld")).resolves.toBeDefined();
  });
});

describe("a run whose CI job stopped asking about it", () => {
  const seen = (id: string) => asSystem(t.db, (tx) => tx.selectFrom("runs").select(sql<number | null>`extract(epoch from now() - client_seen_at)`.as("ago")).where("id", "=", id).executeTakeFirstOrThrow()).then((r) => (r.ago === null ? null : Number(r.ago)));
  const lastSeen = (id: string, minutesAgo: number) => asSystem(t.db, (tx) => tx.updateTable("runs").set({ client_seen_at: sql<Date>`now() - make_interval(mins => ${minutesAgo})` }).where("id", "=", id).execute());
  const post = (token: string, project: string) =>
    handleStartRun(new Request("http://x/api/v1/runs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ project, execution: "own" }) }), deps);
  const get = (token: string, id: string) => handleGetRun(new Request(`http://x/api/v1/runs/${id}`, { headers: { authorization: `Bearer ${token}` } }), id, deps);

  test("is marked seen when started through the API, and each poll refreshes it, while a run started from the app is never marked", async () => {
    const { token } = await mint("org-x");
    const fromApp = await start("goneStale");
    expect(await seen(fromApp.id)).toBeNull();
    expect((await get(token, fromApp.id)).status).toBe(200);
    expect(await seen(fromApp.id)).toBeNull();
    await withOrg(t.db, "org-x", (tx) => cancelLiveRuns(tx, "org-x", "stopped"));
    const posted = await post(token, projects.goneStale!);
    expect(posted.status).toBe(201);
    const id = (await posted.json()).id as string;
    expect(await seen(id)).toBeLessThan(30);
    await lastSeen(id, 2);
    expect(await seen(id)).toBeGreaterThan(100);
    expect((await get(token, id)).status).toBe(200);
    expect(await seen(id)).toBeLessThan(30);
    await lastSeen(id, 2);
    expect((await get((await mint("org-y")).token, id)).status).toBe(404);
    expect(await seen(id)).toBeGreaterThan(100);
  });

  test("is cancelled once nobody has asked for more than the limit, which frees its project, while a polled, an app-started and a finished run are left", async () => {
    const { token } = await mint("org-x");
    const gone = (await asSystem(t.db, (tx) => tx.selectFrom("runs").select("id").where("project_id", "=", projects.goneStale!).where("status", "=", "queued").executeTakeFirstOrThrow())).id;
    const fresh = await start("goneFresh");
    const app = await start("goneApp");
    const running = await start("goneRunning");
    await claimJob(t.db, keys, { execution: "own", orgId: "org-x", projectId: projects.goneRunning!, runId: running.id });
    await lastSeen(fresh.id, CLIENT_GONE_MINUTES - 1);
    await asSystem(t.db, (tx) => tx.updateTable("runs").set({ created_at: sql<Date>`now() - interval '5 hours'` }).where("id", "=", app.id).execute());
    await lastSeen(gone, CLIENT_GONE_MINUTES + 1);
    await lastSeen(running.id, CLIENT_GONE_MINUTES + 10);
    await asSystem(t.db, (tx) => tx.updateTable("runs").set({ client_seen_at: sql<Date>`now() - interval '1 hour'` }).where("project_id", "=", projects.goneStale!).where("status", "=", "cancelled").execute());
    expect(await stopRunsOfGoneClients(t.db)).toBe(2);
    expect(await row(gone)).toEqual({ status: "cancelled", cancel_reason: "ci_gone" });
    expect(await row(running.id)).toEqual({ status: "cancelled", cancel_reason: "ci_gone" });
    const jobs = await asSystem(t.db, (tx) => tx.selectFrom("jobs").select("status").where("run_id", "=", gone).execute());
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
    expect((await row(fresh.id)).status).toBe("queued");
    expect((await row(app.id)).status).toBe("queued");
    expect(await stopRunsOfGoneClients(t.db)).toBe(0);
    await expect(start("goneStale")).resolves.toBeDefined();
    await lastSeen(fresh.id, CLIENT_GONE_MINUTES + 1);
    expect((await get(token, fresh.id)).status).toBe(200);
    expect(await stopRunsOfGoneClients(t.db)).toBe(0);
    expect((await row(fresh.id)).status).toBe("queued");
  });
});
