import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, ProjectConfigSchema } from "@usetrawler/protocol";
import { createApiToken, revokeApiToken } from "../api-tokens/tokens.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, startRun } from "../runs/runs.ts";
import type { Database } from "../db/index.ts";
import { handleStartRun, type RunApiDeps } from "./handlers.ts";
import { keyHashOf } from "./idempotency.ts";
import { startRunFor, type RunPrincipal } from "./service.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const deps = (over: Partial<RunApiDeps> = {}): RunApiDeps => ({ db: t.db, keys, baseUrl: "https://app.trawler.test", openRouterUrl: "http://unused.test", trawlerPays: true, priceOf: async () => null, ...over });
const projects: Record<string, string> = {};

const runsOf = (project: string) => asSystem(t.db, (tx) => tx.selectFrom("runs").select(["id", "number"]).where("project_id", "=", project).orderBy("number").execute());
const keysIn = (org: string) => asSystem(t.db, (tx) => tx.selectFrom("run_idempotency").select(["run_id"]).where("org_id", "=", org).execute());
const stop = (org: string) => withOrg(t.db, org, (tx) => cancelLiveRuns(tx, org, "stopped"));
const post = (token: string, body: unknown, key?: string, over?: Partial<RunApiDeps>) =>
  handleStartRun(new Request("http://x/api/v1/runs", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }) }, body: JSON.stringify(body),
  }), deps(over));
const mint = (org: string, projectId?: string) => withOrg(t.db, org, (tx) => createApiToken(tx, org, "u1", { name: "ci", ...(projectId ? { projectId } : {}) }));
const principal = (orgId: string, over: Partial<RunPrincipal> = {}): RunPrincipal => ({ subject: "connection", orgId, projectId: null, actor: "mcp:test", can: { read: true, control: true }, ...over });

beforeAll(async () => {
  for (const org of ["org-i1", "org-i2"]) {
    await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
    await sql`insert into workspace_plans (org_id, plan, set_by) values (${org}, 'enterprise', 'test') on conflict (org_id) do update set plan = 'enterprise'`.execute(t.db);
    projects[org] = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
    projects[`${org}-other`] = await withOrg(t.db, org, (tx) => createProject(tx, org, ProjectConfigSchema.parse({ ...config, name: "Other" }), keys));
    for (const name of [org, `${org}-other`]) {
      await withOrg(t.db, org, (tx) => startRun(tx, org, projects[name]!, keys, options));
      await stop(org);
    }
  }
});

test("a repeated start with the same key and the same parameters returns the first run, and starts nothing", async () => {
  const { token } = await mint("org-i1");
  const body = { project: projects["org-i1"]!, execution: "hosted" };
  const first = await post(token, body, "retry-1");
  expect(first.status).toBe(201);
  expect(first.headers.get("idempotent-replayed")).toBeNull();
  const original = await first.json();
  const again = await post(token, body, "retry-1");
  expect(again.status).toBe(201);
  expect(again.headers.get("idempotent-replayed")).toBe("true");
  expect(await again.json()).toEqual(original);
  expect((await runsOf(projects["org-i1"]!)).length).toBe(2);
  await stop("org-i1");
  const afterTheRunEnded = await post(token, body, "retry-1");
  expect(afterTheRunEnded.headers.get("idempotent-replayed")).toBe("true");
  expect(await afterTheRunEnded.json()).toEqual(original);
  expect((await runsOf(projects["org-i1"]!)).length).toBe(2);
});

test("simultaneous identical starts create exactly one run, and every caller gets it", async () => {
  const { token } = await mint("org-i2");
  const body = { project: projects["org-i2"]!, execution: "hosted" };
  const before = (await runsOf(projects["org-i2"]!)).length;
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => post(token, body, "burst")));
  expect(answers.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
  const bodies = await Promise.all(answers.map((r) => r.json()));
  expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
  expect((await runsOf(projects["org-i2"]!)).length).toBe(before + 1);
  expect(answers.filter((r) => r.headers.get("idempotent-replayed") === "true").length).toBe(4);
  await stop("org-i2");
});

test("the same key with different parameters is a conflict and creates nothing", async () => {
  const { token } = await mint("org-i1");
  const first = await post(token, { project: projects["org-i1"]!, execution: "hosted", cap: 1 }, "reused");
  expect(first.status).toBe(201);
  await stop("org-i1");
  const before = (await runsOf(projects["org-i1"]!)).length;
  const different = await post(token, { project: projects["org-i1"]!, execution: "hosted", cap: 2 }, "reused");
  expect(different.status).toBe(409);
  expect((await different.json()).error).toContain("already used for a different request");
  const otherProject = await post(token, { project: projects["org-i1-other"]!, execution: "hosted", cap: 1 }, "reused");
  expect(otherProject.status).toBe(409);
  expect((await runsOf(projects["org-i1"]!)).length).toBe(before);
});

test("a key from another workspace never matches", async () => {
  const one = await mint("org-i1");
  const two = await mint("org-i2");
  const a = await post(one.token, { project: projects["org-i1"]!, execution: "hosted" }, "shared-name");
  await stop("org-i1");
  const b = await post(two.token, { project: projects["org-i2"]!, execution: "hosted" }, "shared-name");
  expect([a.status, b.status]).toEqual([201, 201]);
  expect(b.headers.get("idempotent-replayed")).toBeNull();
  expect((await a.json()).id).not.toBe((await b.json()).id);
  await stop("org-i2");
});

test("the stored answer is not handed to a caller who may no longer have it", async () => {
  const request = { project: projects["org-i1"]!, execution: "hosted" as const };
  const started = await startRunFor(principal("org-i1", { projectId: projects["org-i1"]! }), request, deps(), { idempotencyKey: "scoped" });
  expect(started.ok).toBe(true);
  await stop("org-i1");
  const sameProject = await startRunFor(principal("org-i1", { projectId: projects["org-i1"]! }), request, deps(), { idempotencyKey: "scoped" });
  expect(sameProject).toMatchObject({ ok: true, replayed: true });
  const otherProject = await startRunFor(principal("org-i1", { projectId: projects["org-i1-other"]! }), request, deps(), { idempotencyKey: "scoped" });
  expect(otherProject).toMatchObject({ ok: false, status: 403 });
  const readOnly = await startRunFor(principal("org-i1", { can: { read: true, control: false } }), request, deps(), { idempotencyKey: "scoped" });
  expect(readOnly).toMatchObject({ ok: false, status: 403 });
  const { token, id } = await mint("org-i1");
  expect((await post(token, request, "scoped")).headers.get("idempotent-replayed")).toBe("true");
  await withOrg(t.db, "org-i1", (tx) => revokeApiToken(tx, "org-i1", id));
  const revoked = await post(token, request, "scoped");
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get("idempotent-replayed")).toBeNull();
});

test("the run and its key are written together: a start that fails leaves no key, and the retry starts the run", async () => {
  const { token } = await mint("org-i2");
  const body = { project: projects["org-i2"]!, execution: "hosted" };
  const before = (await keysIn("org-i2")).length;
  const runsBefore = (await runsOf(projects["org-i2"]!)).length;
  await expect(post(token, body, "crash", { priceOf: async () => { throw new Error("the price lookup fell over"); } })).rejects.toThrow();
  expect((await keysIn("org-i2")).length).toBe(before);
  expect((await runsOf(projects["org-i2"]!)).length).toBe(runsBefore);
  const retried = await post(token, body, "crash");
  expect(retried.status).toBe(201);
  expect((await runsOf(projects["org-i2"]!)).length).toBe(runsBefore + 1);
  expect((await keysIn("org-i2")).length).toBe(before + 1);
  await stop("org-i2");
});

test("a key stops matching after its window, and a request without a key behaves as it always did", async () => {
  const { token } = await mint("org-i1");
  const body = { project: projects["org-i1"]!, execution: "hosted" };
  const first = await post(token, body, "ages");
  const firstRun = (await first.json()).id;
  await stop("org-i1");
  await asSystem(t.db, (tx) => tx.updateTable("run_idempotency").set({ expires_at: sql<Date>`now() - interval '1 second'` }).where("org_id", "=", "org-i1").where("key_hash", "=", keyHashOf("ages")).execute());
  const later = await post(token, body, "ages");
  expect(later.status).toBe(201);
  expect(later.headers.get("idempotent-replayed")).toBeNull();
  expect((await later.json()).id).not.toBe(firstRun);
  await stop("org-i1");
  const keyless = await post(token, body);
  expect(keyless.status).toBe(201);
  expect(keyless.headers.get("idempotent-replayed")).toBeNull();
  const again = await post(token, body);
  expect(again.status).toBe(409);
  await stop("org-i1");
});

test("a key that is not letters, digits and . _ : - up to 255 characters is refused before anything happens", async () => {
  const { token } = await mint("org-i2");
  const body = { project: projects["org-i2"]!, execution: "hosted" };
  const before = (await runsOf(projects["org-i2"]!)).length;
  for (const key of ["", "has space", "x".repeat(256), "ünï"]) expect((await post(token, body, key)).status).toBe(400);
  expect((await runsOf(projects["org-i2"]!)).length).toBe(before);
});

const racing = (beforeSecondTransaction: () => Promise<void>): Database => {
  let started = 0;
  return new Proxy(t.db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
      return () => {
        started += 1;
        const builder = target.transaction();
        if (started !== 2) return builder;
        return { execute: async (work: Parameters<typeof builder.execute>[0]) => { await beforeSecondTransaction(); return builder.execute(work); } };
      };
    },
  });
};

test("a retry that reaches Start's checks just after the first request committed still gets the first answer", async () => {
  await stop("org-i2");
  const request = { project: projects["org-i2"]!, execution: "hosted" as const };
  const runsBefore = (await runsOf(projects["org-i2"]!)).length;
  let first: Awaited<ReturnType<typeof startRunFor>> | undefined;
  const second = await startRunFor(principal("org-i2"), request, deps({ db: racing(async () => { first = await startRunFor(principal("org-i2"), request, deps(), { idempotencyKey: "race" }); }) }), { idempotencyKey: "race" });
  expect(first).toMatchObject({ ok: true, status: 201 });
  expect(second).toMatchObject({ ok: true, status: 201, replayed: true, value: (first as { value: unknown }).value });
  expect((await runsOf(projects["org-i2"]!)).length).toBe(runsBefore + 1);
  await stop("org-i2");
});

test("the service refuses a malformed key itself, so every caller gets the same rule", async () => {
  const request = { project: projects["org-i2"]!, execution: "hosted" as const };
  expect(await startRunFor(principal("org-i2"), request, deps(), { idempotencyKey: "" })).toMatchObject({ ok: false, status: 400 });
  expect(await startRunFor(principal("org-i2"), request, deps(), { idempotencyKey: "a b" })).toMatchObject({ ok: false, status: 400 });
});
