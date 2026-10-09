import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { setModelKey } from "../credentials/credentials.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, startRun } from "../runs/runs.ts";
import type { RunApiDeps } from "../run-api/service.ts";
import { createMcpEndpoint } from "./server.ts";
import { setMcpSettings } from "./settings.ts";
import type { Caller } from "./tools.ts";

const t = await testDb();
const pool = new pg.Pool({ connectionString: t.url, max: 2 });
afterAll(async () => { await pool.end(); await t.drop(); });
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const ORIGIN = "https://app.trawler.test";
const runApi: RunApiDeps = { db: t.db, keys, baseUrl: ORIGIN, openRouterUrl: "http://unused.test", trawlerPays: false, priceOf: async () => ({ promptUsdPerMtok: 1, completionUsdPerMtok: 2 }), modelCheck: async () => ({ ok: true }) };
const endpoint = createMcpEndpoint({ db: t.db, pool, store: undefined, origin: ORIGIN, runApi: () => runApi });
const projects: Record<string, string> = {};

async function grantFor(org: string, scopes: string[], limit = { runs: 10, spend: 50 }) {
  const id = randomUUID();
  await sql`insert into "oauthClient" ("id", "clientId", "name", "redirectUris") values (${id}, ${`https://claude.ai/client/${id}`}, 'Claude Code', '[]'::jsonb)`.execute(t.db);
  await sql`insert into mcp_grants (id, code_hash, user_id, org_id, client_id, resource, scopes, max_runs_per_day, max_spend_usd_per_day)
    values (${id}, ${id}, 'user-r', ${org}, ${`https://claude.ai/client/${id}`}, 'http://localhost/api/mcp', ${scopes}, ${limit.runs}, ${limit.spend})`.execute(t.db);
  return id;
}
const caller = (org: string, grantId: string, over: Partial<Caller> = {}): Caller => ({ grantId, userId: "user-r", clientId: `https://claude.ai/client/${grantId}`, role: "owner", scopes: ["trawler:read", "trawler:runs:write"], orgId: org, projectId: null, ...over });

async function call(who: Caller, name: string, args: unknown) {
  const response = await endpoint.fetch(new Request(`${ORIGIN}/api/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { authInfo: { token: "", clientId: who.clientId, scopes: who.scopes, extra: { grantId: who.grantId, workspaceId: who.orgId, projectId: who.projectId, userId: who.userId, role: who.role } } });
  const body = await response.text();
  const message = JSON.parse(body.startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as { result?: { isError?: boolean; structuredContent?: any; content: Array<{ text?: string }> }; error?: { message: string } };
  if (message.error) return { isError: true, structured: undefined as any, text: message.error.message };
  return { isError: message.result!.isError === true, structured: message.result!.structuredContent, text: message.result!.content.map((c) => c.text ?? "").join("\n") };
}
const quiet = (org: string) => withOrg(t.db, org, (tx) => cancelLiveRuns(tx, org, "stopped"));
const runRow = (id: string) => asSystem(t.db, (tx) => tx.selectFrom("runs").select(["started_via", "stopped_via", "created_by", "status", "cancel_reason", "budget_usd"]).where("id", "=", id).executeTakeFirstOrThrow());

beforeAll(async () => {
  await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('user-r', 'Ana Lopez', 'ana@r.test', true, now(), now())`.execute(t.db);
  for (const org of ["org-r", "org-s", "org-nokey"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  for (const org of ["org-r", "org-s"]) await withOrg(t.db, org, (tx) => setModelKey(tx, org, { provider: "openrouter", key: "sk-or-test-key-0123456789abcdef", baseUrl: null }, "u1", keys));
  const make = async (key: string, org: string, name: string, authorised = true) => {
    projects[key] = await withOrg(t.db, org, (tx) => createProject(tx, org, ProjectConfigSchema.parse({ ...config, name, targetUrl: `https://${name.toLowerCase()}.acme.test/` }), keys));
    if (authorised) {
      await withOrg(t.db, org, (tx) => startRun(tx, org, projects[key]!, keys, options));
      await quiet(org);
    }
  };
  await make("r1", "org-r", "One");
  await make("r2", "org-r", "Two");
  await make("r3", "org-r", "Three");
  await make("fresh", "org-r", "Fresh", false);
  await make("s1", "org-s", "Other");
  await make("nokey", "org-nokey", "Nokey");
  await withOrg(t.db, "org-r", (tx) => setMcpSettings(tx, "org-r", { connectionsAllowed: true, runControlAllowed: true }, "owner"));
});

test("a read-only grant can neither start nor stop, and says why", async () => {
  const id = await grantFor("org-r", ["trawler:read"]);
  const readOnly = caller("org-r", id, { scopes: ["trawler:read"] });
  const started = await call(readOnly, "start_run", { project: projects.r1 });
  expect(started.isError).toBe(true);
  expect(started.text).toContain("not granted run control");
  expect((await call(readOnly, "stop_run", { run: 1 })).text).toContain("not granted run control");
  expect(await asSystem(t.db, (tx) => tx.selectFrom("runs").select("id").where("project_id", "=", projects.r1!).execute())).toHaveLength(1);
});

test("a connection whose workspace switched run control off is told so by both tools", async () => {
  const id = await grantFor("org-s", ["trawler:read", "trawler:runs:write"]);
  await withOrg(t.db, "org-s", (tx) => setMcpSettings(tx, "org-s", { connectionsAllowed: true, runControlAllowed: false }, "owner"));
  const off = caller("org-s", id, { scopes: ["trawler:read"] });
  expect((await call(off, "start_run", { project: projects.s1 })).text).toContain("Run control is switched off");
  expect((await call(off, "stop_run", { run: 1 })).text).toContain("Run control is switched off");
  await withOrg(t.db, "org-s", (tx) => setMcpSettings(tx, "org-s", { connectionsAllowed: true, runControlAllowed: true }, "owner"));
});

test("a person demoted to a role that cannot control runs loses start and stop at once", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"]);
  const demoted = caller("org-r", id, { role: "viewer" });
  expect((await call(demoted, "start_run", { project: projects.r1 })).text).toContain("does not allow controlling runs");
  expect((await call(demoted, "stop_run", { run: 1 })).text).toContain("does not allow controlling runs");
});

test("a start records the client and the person, returns at once, and reports what this connection has left", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"], { runs: 3, spend: 10 });
  const started = await call(caller("org-r", id), "start_run", { project: projects.r1, cap: 2 });
  expect(started.isError).toBe(false);
  expect(started.structured).toMatchObject({ number: expect.any(Number), url: expect.stringContaining(`${ORIGIN}/runs/`), replayed: false, limit: { runsPerDay: 3, spendUsdPerDay: 10, runs: 1, spentUsd: 2 } });
  const row = await runRow(started.structured.id);
  expect(row).toMatchObject({ created_by: `mcp:${id}:user-r`, status: "queued", started_via: { kind: "mcp", client: "Claude Code", person: "Ana Lopez", grant: id } });
  expect(Number(row.budget_usd)).toBe(2);
  expect(started.text).toContain("get_run");
  await quiet("org-r");
});

test("the same idempotency key returns the first run, and the same key with other arguments conflicts", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"], { runs: 1, spend: 5 });
  const who = caller("org-r", id);
  const first = await call(who, "start_run", { project: projects.r2, cap: 2, idempotencyKey: "assistant-retry-1" });
  const again = await call(who, "start_run", { project: projects.r2, cap: 2, idempotencyKey: "assistant-retry-1" });
  expect(first.isError).toBe(false);
  expect(again.structured).toMatchObject({ id: first.structured.id, replayed: true, limit: { runs: 1 } });
  const different = await call(who, "start_run", { project: projects.r2, cap: 1, idempotencyKey: "assistant-retry-1" });
  expect(different.isError).toBe(true);
  expect(different.text).toContain("already used for a different request");
  await quiet("org-r");
});

test("every refusal of Start reaches the assistant as a plain error, and the ones only a person can clear say where", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"], { runs: 10, spend: 50 });
  const who = caller("org-r", id);
  const unknown = await call(who, "start_run", { project: randomUUID() });
  expect(unknown.text).toContain("not in this workspace");
  const limited = await call(caller("org-r", id, { projectId: projects.r1! }), "start_run", { project: projects.r2 });
  expect(limited.text).toContain("limited to another project");
  const first = await call(who, "start_run", { project: projects.fresh });
  expect(first.isError).toBe(true);
  expect(first.text).toContain("Start the first run of this project from the app");
  expect(first.text).toContain(`${ORIGIN}/projects/${projects.fresh}`);
  const nokeyGrant = await grantFor("org-nokey", ["trawler:read", "trawler:runs:write"]);
  await withOrg(t.db, "org-nokey", (tx) => setMcpSettings(tx, "org-nokey", { connectionsAllowed: true, runControlAllowed: true }, "owner"));
  const nokey = await call(caller("org-nokey", nokeyGrant), "start_run", { project: projects.nokey });
  expect(nokey.isError).toBe(true);
  expect(nokey.text).toContain(`A person can, here: ${ORIGIN}/settings`);
  const busy = await call(who, "start_run", { project: projects.r3, cap: 1 });
  expect(busy.isError).toBe(false);
  const inProgress = await call(who, "start_run", { project: projects.r3, cap: 1 });
  expect(inProgress.isError).toBe(true);
  expect(inProgress.text.length).toBeGreaterThan(20);
  await quiet("org-r");
});

test("the connection's own limit refuses a start and names the limit, the allowance left and when it frees up", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"], { runs: 10, spend: 3 });
  const who = caller("org-r", id);
  expect((await call(who, "start_run", { project: projects.r1, cap: 2 })).isError).toBe(false);
  const refused = await call(who, "start_run", { project: projects.r2, cap: 2 });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("$3.00 in 24 hours and $1.00 is left");
  expect(refused.text).toMatch(/frees up at \d{4}-\d\d-\d\dT/);
  expect((await call(who, "start_run", { project: projects.r2, cap: 20 })).text).toContain("cannot fit this connection's limit");
  await quiet("org-r");
});

test("the cap is bounded for an assistant, below what the REST API allows", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"]);
  const tooMuch = await call(caller("org-r", id), "start_run", { project: projects.r1, cap: 21 });
  expect(tooMuch.isError).toBe(true);
  expect(await asSystem(t.db, (tx) => tx.selectFrom("runs").select("id").where("created_by", "like", `mcp:${id}:%`).execute())).toHaveLength(0);
});

test("stopping names the run by number or id, is safe to repeat, and reaches nothing outside the grant", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"]);
  const who = caller("org-r", id);
  const started = await call(who, "start_run", { project: projects.r1, cap: 1 });
  const number = started.structured.number as number;
  const stopped = await call(who, "stop_run", { run: number });
  expect(stopped.structured).toEqual({ id: started.structured.id, status: "cancelled", stopped: true });
  expect(await runRow(started.structured.id)).toMatchObject({ cancel_reason: "stopped_over_mcp", stopped_via: { client: "Claude Code", person: "Ana Lopez" } });
  const repeat = await call(who, "stop_run", { run: started.structured.id });
  expect(repeat.structured).toEqual({ id: started.structured.id, status: "cancelled", stopped: false });
  expect(repeat.text).toContain("already cancelled");
  const upper = await call(who, "stop_run", { run: started.structured.id.toUpperCase() });
  expect(upper.structured).toMatchObject({ id: started.structured.id, stopped: false });
  const other = await call(caller("org-s", await grantFor("org-s", ["trawler:read", "trawler:runs:write"])), "stop_run", { run: started.structured.id });
  expect(other.isError).toBe(true);
  expect(other.text).toContain("does not exist in this connection's reach");
  const second = await call(who, "start_run", { project: projects.r1, cap: 1 });
  const limited = await call(caller("org-r", id, { projectId: projects.r2! }), "stop_run", { run: second.structured.id });
  expect(limited.isError).toBe(true);
  expect((await runRow(second.structured.id)).status).toBe("queued");
  await quiet("org-r");
});

test("a project given in capitals is the same project, for a limited connection too", async () => {
  const id = await grantFor("org-r", ["trawler:read", "trawler:runs:write"]);
  const started = await call(caller("org-r", id, { projectId: projects.r1! }), "start_run", { project: projects.r1!.toUpperCase(), cap: 1 });
  expect(started.isError).toBe(false);
  await quiet("org-r");
});
