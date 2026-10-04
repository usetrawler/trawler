import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { claimJob, completeJob, ingestEvents } from "./queue.ts";
import { startRun } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const options = { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" };
const done = { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0.01, steps: 1 }, stoppedBy: "finish" as const };

const config = (name: string) =>
  ProjectConfigSchema.parse({
    name, targetUrl: "https://app.acme.test/",
    personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
    goals: [{ id: "g1", instruction: "x", personaId: "ana" }, { id: "g2", instruction: "y", personaId: "lee" }],
  });

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

async function start(name: string, conversation: boolean) {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config(name), keys));
  return withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, conversation }));
}

async function finish(runId: string) {
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${runId}`.execute(t.db);
  await sql`update jobs set status = 'cancelled' where run_id = ${runId} and status = 'queued'`.execute(t.db);
}

test("in a normal run people take turns: the second waits while the first is leased", async () => {
  const run = await start("serial", false);
  const first = await claimJob(t.db, keys);
  expect(first).toMatchObject({ runId: run.id, personaKey: "ana" });
  expect(first!.conversation).toBeUndefined();
  expect(await claimJob(t.db, keys)).toBeNull();
  await completeJob(t.db, first!.token, done);
  expect(await claimJob(t.db, keys)).toMatchObject({ personaKey: "lee" });
  await finish(run.id);
});

test("in a conversation run both people are leased at once, each told about the other, and the replay waits for both", async () => {
  const run = await start("talking", true);
  expect(run.people).toBe(2);
  const ana = await claimJob(t.db, keys);
  const lee = await claimJob(t.db, keys);
  expect([ana?.personaKey, lee?.personaKey]).toEqual(["ana", "lee"]);
  expect(ana).toMatchObject({ conversation: { peers: [{ id: "lee", name: "Lee" }] } });
  expect(lee).toMatchObject({ conversation: { peers: [{ id: "ana", name: "Ana" }] } });
  expect(ana!.story).toBeUndefined();
  expect(await claimJob(t.db, keys)).toBeNull();

  const defect = { seq: 1, at: new Date().toISOString(), jobId: ana!.jobId, type: "finding" as const, finding: { id: "f1", kind: "defect" as const, goal: "g1", title: "Broken", observed: "o", reproduction: ["a", "b"], severity: "high" as const } };
  await ingestEvents(t.db, ana!.token, [defect], ana!.jobId);

  await completeJob(t.db, ana!.token, done);
  expect(await claimJob(t.db, keys)).toBeNull();
  await completeJob(t.db, lee!.token, done);
  const { rows } = await sql<{ kind: string; status: string }>`select kind, status from jobs where run_id = ${run.id} and kind <> 'role_session'`.execute(t.db);
  expect(rows).toEqual([{ kind: "replay", status: "queued" }]);
  expect(await claimJob(t.db, keys)).toMatchObject({ kind: "replay", runId: run.id });
  await finish(run.id);
});

test("a single-person plan never becomes a conversation", async () => {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", ProjectConfigSchema.parse({ name: "solo", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "x" }] }), keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, conversation: true }));
  const { rows } = await sql<{ conversation: boolean }>`select conversation from runs where id = ${run.id}`.execute(t.db);
  expect(rows[0]!.conversation).toBe(false);
  await finish(run.id);
});
