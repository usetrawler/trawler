import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { setModelKey } from "../credentials/credentials.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, startRun } from "../runs/runs.ts";
import { startRunFor, stopRunFor, type RunApiDeps, type RunPrincipal } from "../run-api/service.ts";
import { connectionUsage, reserveSpend, SpendLimitReached } from "./limits.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const deps: RunApiDeps = { db: t.db, keys, baseUrl: "https://app.trawler.test", openRouterUrl: "http://unused.test", trawlerPays: false, priceOf: async () => ({ promptUsdPerMtok: 1, completionUsdPerMtok: 2 }), modelCheck: async () => ({ ok: true }) };
const ORG = "org-l";
const projects: string[] = [];

const principal = (grant: string): RunPrincipal => ({
  subject: "connection", orgId: ORG, projectId: null, actor: `mcp:${grant}:u1`, can: { read: true, control: true },
  via: { kind: "mcp", client: "Claude Code", clientHost: null, person: "Ana", grant },
});
const request = (project: string, cap?: number) => ({ project, execution: "hosted" as const, model: "m/agent", ...(cap ? { cap } : {}) });

async function grant(limit: { runs: number; spend: number }) {
  const id = randomUUID();
  await sql`insert into "oauthClient" ("id", "clientId", "redirectUris") values (${id}, ${id}, '[]'::jsonb)`.execute(t.db);
  await sql`insert into mcp_grants (id, code_hash, user_id, org_id, client_id, resource, scopes, max_runs_per_day, max_spend_usd_per_day)
    values (${id}, ${id}, 'user-l', ${ORG}, ${id}, 'http://localhost/api/mcp', ARRAY['trawler:read','trawler:runs:write'], ${limit.runs}, ${limit.spend})`.execute(t.db);
  return id;
}
const settle = (runId: string, status: string, cost: number) => asSystem(t.db, async (tx) => {
  await tx.updateTable("runs").set({ status, cost_usd: cost, finished_at: new Date() }).where("id", "=", runId).execute();
  await tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", runId).execute();
});
const used = (id: string) => withOrg(t.db, ORG, (tx) => connectionUsage(tx, ORG, id));
const quiet = () => withOrg(t.db, ORG, (tx) => cancelLiveRuns(tx, ORG, "stopped"));

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values (${ORG}, ${ORG}, ${ORG}, now())`.execute(t.db);
  await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('user-l', 'Ana', 'ana@l.test', true, now(), now())`.execute(t.db);
  await withOrg(t.db, ORG, (tx) => setModelKey(tx, ORG, { provider: "openrouter", key: "sk-or-test-key-0123456789abcdef", baseUrl: null }, "u1", keys));
  for (const name of ["one", "two", "three"]) {
    const id = await withOrg(t.db, ORG, (tx) => createProject(tx, ORG, ProjectConfigSchema.parse({ ...config, name, targetUrl: `https://${name}.acme.test/` }), keys));
    projects.push(id);
    await withOrg(t.db, ORG, (tx) => startRun(tx, ORG, id, keys, options));
  }
  await quiet();
});

test("a start reserves its cap, and a start that does not fit the allowance is refused naming the limit", async () => {
  const id = await grant({ runs: 10, spend: 3 });
  const first = await startRunFor(principal(id), request(projects[0]!, 2), deps);
  expect(first).toMatchObject({ ok: true, status: 201 });
  expect(await used(id)).toMatchObject({ runs: 1, spentUsd: 2, runsPerDay: 10, spendUsdPerDay: 3 });
  const second = await startRunFor(principal(id), request(projects[1]!, 2), deps);
  expect(second).toMatchObject({ ok: false, status: 429 });
  expect((second as { error: string }).error).toContain("$3.00 in 24 hours and $1.00 is left");
  expect(await withOrg(t.db, ORG, (tx) => tx.selectFrom("runs").select("id").where("project_id", "=", projects[1]!).execute())).toHaveLength(1);
  await quiet();
});

test("the number of runs is limited too, and a refusal names it", async () => {
  const id = await grant({ runs: 1, spend: 50 });
  const first = await startRunFor(principal(id), request(projects[0]!, 1), deps);
  expect(first.ok).toBe(true);
  await quiet();
  const second = await startRunFor(principal(id), request(projects[0]!, 1), deps);
  expect(second).toMatchObject({ ok: false, status: 429 });
  expect((second as { error: string }).error).toContain("1 run in 24 hours and has started 1");
});

test("two starts that together exceed the limit cannot both reserve", async () => {
  const id = await grant({ runs: 10, spend: 3 });
  const results = await Promise.all([startRunFor(principal(id), request(projects[0]!, 2), deps), startRunFor(principal(id), request(projects[1]!, 2), deps)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toHaveLength(1);
  expect((await used(id))!.runs).toBe(1);
  await quiet();
});

test("a retry under the same idempotency key returns the first run even when the limit is already used, and reserves nothing a second time", async () => {
  const id = await grant({ runs: 1, spend: 3 });
  const first = await startRunFor(principal(id), request(projects[0]!, 2), deps, { idempotencyKey: "mcp-retry" });
  const retry = await startRunFor(principal(id), request(projects[0]!, 2), deps, { idempotencyKey: "mcp-retry" });
  expect(first.ok).toBe(true);
  expect(retry).toMatchObject({ ok: true, replayed: true });
  expect((retry as { value: unknown }).value).toEqual((first as { value: unknown }).value);
  expect(await used(id)).toMatchObject({ runs: 1, spentUsd: 2 });
  await quiet();
});

test("a finished run settles its actual cost and releases the rest of its reservation, a stopped one releases all of it", async () => {
  const id = await grant({ runs: 10, spend: 3 });
  const first = await startRunFor(principal(id), request(projects[0]!, 2), deps);
  if (!first.ok) throw new Error(first.error);
  expect((await used(id))!.spentUsd).toBe(2);
  await settle(first.value.id, "succeeded", 0.4);
  expect((await used(id))!.spentUsd).toBe(0.4);
  const second = await startRunFor(principal(id), request(projects[0]!, 2), deps);
  expect(second).toMatchObject({ ok: true });
  expect((await used(id))!.spentUsd).toBe(2.4);
  if (!second.ok) throw new Error(second.error);
  expect((await stopRunFor(principal(id), second.value.id, deps)).ok).toBe(true);
  expect(await used(id)).toMatchObject({ runs: 2, spentUsd: 0.4 });
  const failed = await startRunFor(principal(id), request(projects[0]!, 2), deps);
  if (!failed.ok) throw new Error(failed.error);
  await settle(failed.value.id, "failed", 0);
  expect((await used(id))!.spentUsd).toBe(0.4);
});

test("runs older than the window no longer count, and the connection says when the oldest leaves", async () => {
  const id = await grant({ runs: 1, spend: 50 });
  const first = await startRunFor(principal(id), request(projects[1]!, 1), deps);
  if (!first.ok) throw new Error(first.error);
  await settle(first.value.id, "succeeded", 0.1);
  const before = (await used(id))!;
  expect(before.nextFreeAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  expect(await startRunFor(principal(id), request(projects[1]!, 1), deps)).toMatchObject({ ok: false, status: 429 });
  await asSystem(t.db, (tx) => tx.updateTable("runs").set({ created_at: sql<Date>`now() - interval '25 hours'` }).where("id", "=", first.value.id).execute());
  expect(await used(id)).toMatchObject({ runs: 0, spentUsd: 0, nextFreeAt: null });
  expect(await startRunFor(principal(id), request(projects[1]!, 1), deps)).toMatchObject({ ok: true });
  await quiet();
});

test("each connection has its own limit, and a disconnected one starts nothing", async () => {
  const a = await grant({ runs: 1, spend: 50 });
  const b = await grant({ runs: 1, spend: 50 });
  expect((await startRunFor(principal(a), request(projects[2]!, 1), deps)).ok).toBe(true);
  await quiet();
  expect((await startRunFor(principal(b), request(projects[2]!, 1), deps)).ok).toBe(true);
  await quiet();
  await t.db.updateTable("mcp_grants").set({ revoked_at: new Date() }).where("id", "=", b).execute();
  const refused = await startRunFor(principal(b), request(projects[2]!, 1), deps);
  expect(refused).toMatchObject({ ok: false, status: 429 });
  expect((refused as { error: string }).error).toContain("disconnected");
});

test("a grant never gains a higher limit, and only the grant's own row decides it", async () => {
  const id = await grant({ runs: 2, spend: 10 });
  await expect(t.db.updateTable("mcp_grants").set({ max_runs_per_day: 3 }).where("id", "=", id).execute()).rejects.toThrow(/never gains a higher spend limit/);
  await expect(t.db.updateTable("mcp_grants").set({ max_spend_usd_per_day: "11" }).where("id", "=", id).execute()).rejects.toThrow(/never gains a higher spend limit/);
  await t.db.updateTable("mcp_grants").set({ max_runs_per_day: 1 }).where("id", "=", id).execute();
  expect((await used(id))!.runsPerDay).toBe(1);
});

test("a second reservation waits for the first transaction to settle before it counts, so two cannot both fit", async () => {
  const id = await grant({ runs: 10, spend: 3 });
  const via = { kind: "mcp" as const, client: "Claude Code", clientHost: null, person: "Ana", grant: id };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let firstReserved!: () => void;
  const reserved = new Promise<void>((resolve) => { firstReserved = resolve; });
  const first = withOrg(t.db, ORG, async (tx) => {
    await reserveSpend(tx, ORG, id, 2);
    await startRun(tx, ORG, projects[0]!, keys, { ...options, budgetUsd: 2, startedVia: via });
    firstReserved();
    await held;
  });
  await reserved;
  let secondSettled = false;
  const second = withOrg(t.db, ORG, (tx) => reserveSpend(tx, ORG, id, 2)).then(() => "reserved", (err: unknown) => (err instanceof SpendLimitReached ? "refused" : "failed")).finally(() => { secondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(secondSettled).toBe(false);
  release();
  await first;
  expect(await second).toBe("refused");
  await quiet();
});

test("a finished run that a person asked to judge again holds its whole cap while the judge works, so that money cannot be handed out twice", async () => {
  const id = await grant({ runs: 10, spend: 20 });
  const first = await startRunFor(principal(id), request(projects[0]!, 20), deps);
  if (!first.ok) throw new Error(first.error);
  await settle(first.value.id, "succeeded", 2);
  expect((await used(id))!.spentUsd).toBe(2);
  await asSystem(t.db, (tx) => tx.insertInto("jobs").values({ org_id: ORG, run_id: first.value.id, kind: "judge", position: 99, finding_key: "ana:f0", requested_by: "u1", status: "queued" }).execute());
  expect((await used(id))!.spentUsd).toBe(20);
  expect(await startRunFor(principal(id), request(projects[1]!, 2), deps)).toMatchObject({ ok: false, status: 429 });
  await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "succeeded" }).where("run_id", "=", first.value.id).where("kind", "=", "judge").execute());
  expect((await used(id))!.spentUsd).toBe(2);
});

test("a stopped run keeps holding its cap while a job of it is still working, and a run over its cap holds what it cost", async () => {
  const id = await grant({ runs: 10, spend: 20 });
  const first = await startRunFor(principal(id), request(projects[0]!, 5), deps);
  if (!first.ok) throw new Error(first.error);
  expect((await stopRunFor(principal(id), first.value.id, deps)).ok).toBe(true);
  expect((await used(id))!.spentUsd).toBe(0);
  await asSystem(t.db, (tx) => tx.insertInto("jobs").values({ org_id: ORG, run_id: first.value.id, kind: "role_session", persona_key: "ana", position: 98, status: "leased" }).execute());
  expect((await used(id))!.spentUsd).toBe(5);
  await asSystem(t.db, (tx) => tx.updateTable("runs").set({ cost_usd: 6.5 }).where("id", "=", first.value.id).execute());
  expect((await used(id))!.spentUsd).toBe(6.5);
  await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", first.value.id).execute());
  expect((await used(id))!.spentUsd).toBe(6.5);
});

test("an assistant cannot start a run on a model without a known price, and a run that somehow has only a token cap counts its whole cap", async () => {
  const id = await grant({ runs: 10, spend: 20 });
  const refused = await startRunFor(principal(id), request(projects[0]!, 4), { ...deps, priceOf: async () => null });
  expect(refused).toMatchObject({ ok: false });
  expect((refused as { error: string }).error).toContain("no known price");
  expect((await used(id))!.runs).toBe(0);
  const first = await startRunFor(principal(id), request(projects[0]!, 4), deps);
  if (!first.ok) throw new Error(first.error);
  await settle(first.value.id, "succeeded", 5);
  await asSystem(t.db, (tx) => tx.updateTable("runs").set({ token_cap: 3_000_000 }).where("id", "=", first.value.id).execute());
  expect((await used(id))!.spentUsd).toBe(5);
  await asSystem(t.db, (tx) => tx.updateTable("runs").set({ cost_usd: 1 }).where("id", "=", first.value.id).execute());
  expect((await used(id))!.spentUsd).toBe(4);
});
