import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { keyStillStored, modelKeyDetails, removeModelKey, setModelKey } from "../credentials/credentials.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, startRun } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Get in." }], accounts: [] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function someoneWaitsForALock() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(t.db);
    if (rows[0]!.n > 0) return true;
    await sleep(50);
  }
  return false;
}

async function workspace(org: string) {
  await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  const project = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
  await withOrg(t.db, org, (tx) => setModelKey(tx, org, { provider: "openrouter", key: "sk-or-v1-" + "k".repeat(40) }, "u1", keys));
  const addedAt = (await withOrg(t.db, org, (tx) => modelKeyDetails(tx, org)))!.addedAt;
  return { project, addedAt };
}

const statuses = async (org: string) => (await sql<{ status: string }>`select status from runs where org_id = ${org}`.execute(t.db)).rows.map((row) => row.status);
const opened = () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
};

test("a run that checked the key first holds it: the removal waits, then cancels the run that started", async () => {
  const org = "org-race-start-first";
  const { project, addedAt } = await workspace(org);
  const hold = opened();
  const inserted = opened();
  const starting = withOrg(t.db, org, async (tx) => {
    if (!(await keyStillStored(tx, org, "openrouter", null))) return "key gone";
    const run = await startRun(tx, org, project, keys, options);
    inserted.open();
    await hold.gate;
    return run.id;
  });
  await inserted.gate;
  const removing = withOrg(t.db, org, async (tx) => ((await removeModelKey(tx, org, addedAt)) ? cancelLiveRuns(tx, org) : null));
  const waited = await someoneWaitsForALock();
  hold.open();
  await starting;
  expect({ waited, stopped: await removing, runs: await statuses(org) }).toEqual({ waited: true, stopped: 1, runs: ["cancelled"] });
});

test("a removal that took the key first holds it: the start waits, then starts nothing", async () => {
  const org = "org-race-remove-first";
  const { project, addedAt } = await workspace(org);
  const hold = opened();
  const deleted = opened();
  const removing = withOrg(t.db, org, async (tx) => {
    if (!(await removeModelKey(tx, org, addedAt))) return null;
    deleted.open();
    await hold.gate;
    return cancelLiveRuns(tx, org);
  });
  await deleted.gate;
  const starting = withOrg(t.db, org, async (tx) => ((await keyStillStored(tx, org, "openrouter", null)) ? (await startRun(tx, org, project, keys, options)).id : "key gone"));
  const waited = await someoneWaitsForALock();
  hold.open();
  expect({ waited, stopped: await removing, start: await starting, runs: await statuses(org) }).toEqual({ waited: true, stopped: 0, start: "key gone", runs: [] });
});
