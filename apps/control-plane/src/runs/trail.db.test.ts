import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { startRun } from "./runs.ts";
import { personTrail, TRAIL_PAGE } from "./trail.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
  goals: [{ id: "send", instruction: "Send an invoice." }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
let projects = 0;

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
});

async function finishedRun() {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: `Project ${++projects}` }, keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
  await asSystem(t.db, (tx) => tx.updateTable("runs").set({ status: "succeeded", finished_at: new Date() }).where("id", "=", run.id).execute());
  const job = async (persona: string) => (await asSystem(t.db, (tx) => tx.selectFrom("jobs").select("id").where("run_id", "=", run.id).where("persona_key", "=", persona).executeTakeFirstOrThrow())).id;
  return { runId: run.id, ana: await job("ana"), lee: await job("lee") };
}

async function events(runId: string, jobId: string, list: Array<Record<string, unknown>>) {
  await asSystem(t.db, async (tx) => {
    const { n } = (await sql<{ n: number }>`select count(*)::int as n from run_events where job_id = ${jobId}`.execute(tx)).rows[0]!;
    await tx.insertInto("run_events").values(list.map((e, i) => ({ org_id: "org-a", run_id: runId, job_id: jobId, seq: n + i + 1, type: e.type as string, at: new Date(), payload: JSON.stringify({ ...e, jobId, seq: n + i + 1, at: new Date().toISOString() }) }))).execute();
  });
}

const trail = (runId: string, person: string, before?: number, org = "org-a") => withOrg(t.db, org, (tx) => personTrail(tx, org, runId, person, before));

test("a person's trail lists their turns and what they did, each step with its page, and the error a failed turn ended with", async () => {
  const { runId, ana, lee } = await finishedRun();
  const second = await asSystem(t.db, async (tx) => (await tx.insertInto("jobs").values({ org_id: "org-a", run_id: runId, kind: "role_session", position: 5, persona_key: "ana", status: "failed", stopped_by: "error", error: "the browser failed 3 times in a row" }).returning("id").executeTakeFirstOrThrow()).id);
  await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "succeeded", stopped_by: "finish" }).where("id", "=", ana).execute());
  await events(runId, ana, [
    { type: "job_started", kind: "role_session" },
    { type: "step", step: 1, tool: "browser_navigate", costUsd: 0.01, url: "https://app.acme.test/invoices/new?step=2" },
    { type: "step", step: 2, tool: "browser_snapshot", costUsd: 0.01 },
    { type: "note", text: "The Send button is greyed out." },
    { type: "blocked_request", url: "https://tracker.example/pixel.gif?id=9" },
    { type: "bot_protection", vendor: "Cloudflare", url: "https://app.acme.test/login?__cf_chl_tk=abc123&next=/reset?token=zzz" },
    { type: "finding", finding: { id: "f1", kind: "defect", goal: "send", title: "Send does nothing", observed: "o", reproduction: ["Open /invoices"], severity: "high" } },
    { type: "goal_status", outcome: { goal: "send", status: "failed", note: "Send never worked." } },
    { type: "goal_status", outcome: { goal: "gone", status: "not_attempted", note: "" } },
    { type: "job_finished", usage: { model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 2 }, stoppedBy: "finish" },
  ]);
  await events(runId, second, [{ type: "step", step: 1, tool: "browser_click", costUsd: 0.01, url: "https://elsewhere.test/x" }]);
  await events(runId, lee, [{ type: "note", text: "Lee's own note." }]);

  const got = (await trail(runId, "ana"))!;
  expect(got.turns.map(({ id, ...turn }) => ({ ...turn, mine: id === ana || id === second }))).toEqual([
    { number: 1, status: "succeeded", stoppedBy: "finish", error: null, entries: 8, mine: true },
    { number: 2, status: "failed", stoppedBy: "error", error: "the browser failed 3 times in a row", entries: 1, mine: true },
  ]);
  expect(got.entries.map(({ id, at, ...e }) => e)).toEqual([
    { turn: ana, kind: "step", step: 1, tool: "browser_navigate", page: "/invoices/new?step=2" },
    { turn: ana, kind: "step", step: 2, tool: "browser_snapshot", page: null },
    { turn: ana, kind: "note", text: "The Send button is greyed out." },
    { turn: ana, kind: "blocked", address: "tracker.example" },
    { turn: ana, kind: "bot_protection", vendor: "Cloudflare", page: "/login" },
    { turn: ana, kind: "finding", findingKind: "defect", title: "Send does nothing" },
    { turn: ana, kind: "goal", status: "failed", goal: "Send an invoice.", note: "Send never worked." },
    { turn: ana, kind: "goal", status: "not_attempted", goal: "gone", note: "" },
    { turn: second, kind: "step", step: 1, tool: "browser_click", page: "elsewhere.test/x" },
  ]);
  expect(got.olderThan).toBeNull();
  expect(JSON.stringify(got)).not.toContain("Lee's own note.");
  expect(JSON.stringify(got)).not.toContain("reproduction");
  expect(JSON.stringify(got)).not.toMatch(/abc123|zzz/);
});

test("a long trail comes newest first in pages, each in order, until nothing earlier is left", async () => {
  const { runId, ana } = await finishedRun();
  await events(runId, ana, Array.from({ length: 2 * TRAIL_PAGE + 10 }, (_, i) => ({ type: "step", step: i + 1, tool: "browser_click", costUsd: 0 })));
  const steps = (page: { entries: Array<{ kind: string } & Record<string, unknown>> }) => page.entries.map((e) => e.step);
  const first = (await trail(runId, "ana"))!;
  expect(steps(first)).toEqual(Array.from({ length: TRAIL_PAGE }, (_, i) => TRAIL_PAGE + 11 + i));
  expect(first.olderThan).toBe(first.entries[0]!.id);
  const second = (await trail(runId, "ana", first.olderThan!))!;
  expect(steps(second)).toEqual(Array.from({ length: TRAIL_PAGE }, (_, i) => 11 + i));
  const last = (await trail(runId, "ana", second.olderThan!))!;
  expect(steps(last)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  expect(last.olderThan).toBeNull();
  expect(last.turns[0]!.entries).toBe(2 * TRAIL_PAGE + 10);
});

test("a trail of exactly one page has nothing earlier", async () => {
  const { runId, ana } = await finishedRun();
  await events(runId, ana, Array.from({ length: TRAIL_PAGE }, (_, i) => ({ type: "note", text: String(i) })));
  const got = (await trail(runId, "ana"))!;
  expect(got.entries).toHaveLength(TRAIL_PAGE);
  expect(got.olderThan).toBeNull();
});

test("another workspace, an unknown run or a person the run never had gets no trail", async () => {
  const { runId, ana } = await finishedRun();
  await events(runId, ana, [{ type: "note", text: "Private." }]);
  expect(await trail(runId, "ana", undefined, "org-b")).toBeNull();
  expect(await trail("0f8fad5b-d9cb-469f-a165-70867728950e", "ana")).toBeNull();
  expect(await trail(runId, "nobody")).toBeNull();
  expect((await trail(runId, "ana"))!.entries).toHaveLength(1);
});
