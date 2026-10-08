import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, runSummary, startRun } from "../runs/runs.ts";
import { runView } from "../runs/report.ts";
import { workspaceRuns } from "../projects/overview.ts";
import { createApiToken } from "../api-tokens/tokens.ts";
import { handleStartRun } from "./handlers.ts";
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

test("a principal that may not do something is refused before the database is touched", async () => {
  const untouchable = { ...deps, db: new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as RunApiDeps["db"] };
  const read = principal("org-a", { can: { read: false, control: false } });
  expect(await readRunFor(read, runs.a2!, untouchable)).toMatchObject({ ok: false, status: 403, error: "This connection is not allowed to do that." });
  expect(await stopRunFor(read, runs.a2!, untouchable)).toMatchObject({ ok: false, status: 403 });
  expect(await startRunFor(read, { project: ids.a2!, execution: "hosted" }, untouchable)).toMatchObject({ ok: false, status: 403 });
  expect(await startRunFor({ ...read, subject: "API token" }, { project: ids.a2!, execution: "hosted" }, untouchable)).toMatchObject({ error: "This API token is not allowed to do that." });
});

test("a malformed run id is a 404 for stop and read, not an error", async () => {
  expect(await stopRunFor(principal("org-a"), "not-a-uuid", deps)).toMatchObject({ ok: false, status: 404, error: "Run not found." });
  expect(await readRunFor(principal("org-a"), "not-a-uuid", deps)).toMatchObject({ ok: false, status: 404 });
});

test("through REST a token's runs are recorded as started by that token, and a token limited to another project is told so", async () => {
  await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
  const { id, token } = await withOrg(t.db, "org-ent", (tx) => createApiToken(tx, "org-ent", "u1", { name: "ci", projectId: ids.ent! }));
  const call = (project: string) => handleStartRun(new Request("http://x/api/v1/runs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ project, execution: "hosted" }) }), deps);
  const refused = await call(ids.a1!);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "This API token is limited to another project." });
  const started = await call(ids.ent!);
  expect(started.status).toBe(201);
  const startedId = ((await started.json()) as { id: string }).id;
  const row = await asSystem(t.db, (tx) => tx.selectFrom("runs").select("created_by").where("id", "=", startedId).executeTakeFirstOrThrow());
  expect(row.created_by).toBe(`api-token:${id}`);
});

test("a run started and stopped over MCP records the client and the person, shows them in history and the report, and the filter finds it", async () => {
  await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
  const via = { kind: "mcp" as const, client: "Claude Code", clientHost: "claude.ai", person: "Ana Lopez", grant: "grant-1" };
  const started = await startRunFor(principal("org-ent", { projectId: ids.ent!, actor: "mcp:grant-1:user-1", via }), { project: ids.ent!, execution: "hosted" }, deps);
  if (!started.ok) throw new Error(started.error);
  const id = started.value.id;
  const row = async () => asSystem(t.db, (tx) => tx.selectFrom("runs").select(["started_via", "stopped_via", "cancel_reason", "created_by"]).where("id", "=", id).executeTakeFirstOrThrow());
  expect(await row()).toMatchObject({ started_via: via, stopped_via: null, cancel_reason: null });
  const byOrigin = (origin: "app" | "api" | "mcp") => withOrg(t.db, "org-ent", async (tx) => (await workspaceRuns(tx, "org-ent", { origin })).runs.map((r) => r.id));
  expect(await byOrigin("mcp")).toEqual([id]);
  expect(await byOrigin("app")).not.toContain(id);
  expect(await byOrigin("api")).not.toContain(id);
  const line = await withOrg(t.db, "org-ent", async (tx) => (await workspaceRuns(tx, "org-ent")).runs.find((r) => r.id === id));
  expect(line).toMatchObject({ origin: "mcp", startedVia: via });

  const stopper = { ...via, person: "Lee Park" };
  expect((await stopRunFor(principal("org-ent", { via: stopper }), id, deps)).ok).toBe(true);
  expect(await row()).toMatchObject({ stopped_via: stopper, cancel_reason: "stopped_over_mcp", started_via: via });
  const summary = (await withOrg(t.db, "org-ent", (tx) => runSummary(tx, "org-ent", id)))!;
  expect(summary).toMatchObject({ startedVia: via, stoppedVia: stopper });
  expect(runView(summary).headline).toBe("Stopped by Claude Code for Lee Park over MCP.");
});

test("a run stopped without MCP keeps no stopping client, and the database refuses a malformed origin", async () => {
  await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
  const started = await startRunFor(principal("org-ent", { projectId: ids.ent! }), { project: ids.ent!, execution: "hosted" }, deps);
  if (!started.ok) throw new Error(started.error);
  expect((await stopRunFor(principal("org-ent"), started.value.id, deps)).ok).toBe(true);
  expect(await asSystem(t.db, (tx) => tx.selectFrom("runs").select(["started_via", "stopped_via", "cancel_reason"]).where("id", "=", started.value.id).executeTakeFirstOrThrow())).toEqual({ started_via: null, stopped_via: null, cancel_reason: "stopped_from_ci" });
  await expect(asSystem(t.db, (tx) => tx.updateTable("runs").set({ started_via: JSON.stringify({ kind: "ui" }) as never }).where("id", "=", started.value.id).execute())).rejects.toThrow(/runs_started_via_shape/);
  await expect(asSystem(t.db, (tx) => tx.updateTable("runs").set({ stopped_via: JSON.stringify({ kind: "mcp", client: 3 }) as never }).where("id", "=", started.value.id).execute())).rejects.toThrow(/runs_stopped_via_shape/);
});
