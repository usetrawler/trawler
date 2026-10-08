import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, startRun } from "../runs/runs.ts";
import { readRunFor, startRunFor, stopRunFor, type RunApiDeps, type RunPrincipal } from "./service.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const deps: RunApiDeps = { db: t.db, keys, baseUrl: "https://app.trawler.test", openRouterUrl: "http://unused.test", trawlerPays: true, priceOf: async () => null };
const ids: Record<string, string> = {};
const runs: Record<string, string> = {};

const principal = (orgId: string, over: Partial<RunPrincipal> = {}): RunPrincipal => ({
  subject: "connection", orgId, projectId: null, actor: "mcp:test", can: { read: true, control: true }, ...over,
});
const status = (runId: string) => asSystem(t.db, async (tx) => (await tx.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirstOrThrow()).status);

beforeAll(async () => {
  for (const org of ["org-a", "org-b", "org-ent"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await sql`insert into workspace_plans (org_id, plan, set_by) values ('org-ent', 'enterprise', 'test') on conflict (org_id) do update set plan = 'enterprise'`.execute(t.db);
  for (const [name, org] of [["a1", "org-a"], ["a2", "org-a"], ["b1", "org-b"], ["ent", "org-ent"]] as const) ids[name] = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
  await withOrg(t.db, "org-ent", (tx) => startRun(tx, "org-ent", ids.ent!, keys, options));
  await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
  for (const [name, org] of [["a1", "org-a"], ["a2", "org-a"], ["b1", "org-b"]] as const) runs[name] = (await withOrg(t.db, org, (tx) => startRun(tx, org, ids[name]!, keys, options))).id;
});

test("reading a run answers for its own workspace and project, and for nobody else", async () => {
  const own = await readRunFor(principal("org-a"), runs.a1!, deps);
  expect(own.ok).toBe(true);
  expect(await readRunFor(principal("org-b"), runs.a1!, deps)).toMatchObject({ ok: false, status: 404, error: "Run not found." });
  expect(await readRunFor(principal("org-a", { projectId: ids.a2! }), runs.a1!, deps)).toMatchObject({ ok: false, status: 404 });
  expect((await readRunFor(principal("org-a", { projectId: ids.a1! }), runs.a1!, deps)).ok).toBe(true);
  expect(await readRunFor(principal("org-a", { can: { read: false, control: true } }), runs.a1!, deps)).toMatchObject({ ok: false, status: 403 });
  expect(await readRunFor(principal("org-a"), "not-a-uuid", deps)).toMatchObject({ ok: false, status: 404 });
});

test("stopping a run touches only its own workspace and project, and needs run control", async () => {
  expect(await stopRunFor(principal("org-b"), runs.a1!, deps)).toMatchObject({ ok: false, status: 404 });
  expect(await stopRunFor(principal("org-a", { projectId: ids.a2! }), runs.a1!, deps)).toMatchObject({ ok: false, status: 404 });
  expect(await stopRunFor(principal("org-a", { can: { read: true, control: false } }), runs.a1!, deps)).toMatchObject({ ok: false, status: 403 });
  expect(await status(runs.a1!)).toBe("queued");
  const stopped = await stopRunFor(principal("org-a", { projectId: ids.a1! }), runs.a1!, deps);
  expect(stopped).toMatchObject({ ok: true, value: { id: runs.a1!, status: "cancelled", stopped: true } });
  expect((await stopRunFor(principal("org-a"), runs.a1!, deps)).ok).toBe(true);
});

test("starting a run needs run control, stays inside the workspace and the project restriction, and records who started it", async () => {
  const request = (project: string) => ({ project, execution: "hosted" as const });
  expect(await startRunFor(principal("org-ent", { can: { read: true, control: false } }), request(ids.ent!), deps)).toMatchObject({ ok: false, status: 403 });
  expect(await startRunFor(principal("org-ent"), request(ids.a1!), deps)).toMatchObject({ ok: false, status: 404, error: "That project is not in this workspace." });
  expect(await startRunFor(principal("org-ent", { projectId: ids.a1! }), request(ids.ent!), deps)).toMatchObject({ ok: false, status: 403, error: "This connection is limited to another project." });
  expect(await startRunFor({ ...principal("org-ent", { projectId: ids.a1! }), subject: "API token" }, request(ids.ent!), deps)).toMatchObject({ error: "This API token is limited to another project." });
  expect(await asSystem(t.db, (tx) => tx.selectFrom("runs").select("id").where("project_id", "=", ids.ent!).execute())).toHaveLength(1);
  const started = await startRunFor(principal("org-ent", { projectId: ids.ent!, actor: "mcp:grant-1:user-1" }), request(ids.ent!), deps);
  expect(started).toMatchObject({ ok: true, status: 201, value: { number: expect.any(Number), reportUrl: expect.stringContaining("https://app.trawler.test/") } });
  const row = await asSystem(t.db, (tx) => tx.selectFrom("runs").select("created_by").where("project_id", "=", ids.ent!).orderBy("created_at", "desc").executeTakeFirstOrThrow());
  expect(row.created_by).toBe("mcp:grant-1:user-1");
});
