import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MAX_NOT_BUGS, ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { workspaceRuns } from "../projects/overview.ts";
import { CannotDismiss, dismissFinding, notBugsOf, undoDismissal } from "./dismissals.ts";
import { claimJob } from "./queue.ts";
import { runView } from "./report.ts";
import { runSummary, startRun } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }],
  goals: [{ id: "g", instruction: "Get in." }],
});
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };

let acme = "";
let other = "";
let theirs = "";

type Seed = { key: string; kind?: "defect" | "friction"; verdict?: "confirmed" | "refuted" | "inconclusive" | null; sameAs?: string; title?: string; replayFailed?: boolean };

async function finishedRun(orgId: string, projectId: string, findings: Seed[], status = "succeeded") {
  const run = await withOrg(t.db, orgId, (tx) => startRun(tx, orgId, projectId, keys, options));
  await asSystem(t.db, async (tx) => {
    await tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", run.id).execute();
    await tx.updateTable("runs").set({ status, finished_at: status === "running" ? null : new Date() }).where("id", "=", run.id).execute();
    const job = await tx.selectFrom("jobs").select("id").where("run_id", "=", run.id).executeTakeFirstOrThrow();
    for (const f of findings) {
      await tx.insertInto("findings").values({
        org_id: orgId, run_id: run.id, job_id: job.id, key: f.key, persona_key: "ana", kind: f.kind ?? "defect", goal: "g",
        title: f.title ?? `Title of ${f.key}`, observed: "o", reproduction: JSON.stringify(["Open /", "Click Save"]), severity: "high", verdict: f.verdict ?? null, same_as: f.sameAs ?? null,
      }).execute();
      if (f.replayFailed) await tx.insertInto("jobs").values({ org_id: orgId, run_id: run.id, kind: "replay", position: 100, finding_key: f.key, status: "failed" }).execute();
    }
  });
  return run.id;
}

const dismiss = (orgId: string, runId: string, key: string, reason: unknown, userId = "u1") => withOrg(t.db, orgId, (tx) => dismissFinding(tx, orgId, runId, key, reason, userId));
const undo = (orgId: string, runId: string, key: string) => withOrg(t.db, orgId, (tx) => undoDismissal(tx, orgId, runId, key));
const view = async (orgId: string, runId: string) => runView((await withOrg(t.db, orgId, (tx) => runSummary(tx, orgId, runId)))!);
const refused = async (work: Promise<unknown>, message: RegExp) => {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CannotDismiss);
  expect((err as Error).message).toMatch(message);
};
const stored = async (runId: string) => (await sql<{ finding_key: string; reason: string; dismissed_by: string }>`select finding_key, reason, dismissed_by from finding_dismissals where run_id = ${runId} order by finding_key`.execute(t.db)).rows;

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  acme = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  other = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "Other", targetUrl: "https://other.acme.test/" }, keys));
  theirs = await withOrg(t.db, "org-b", (tx) => createProject(tx, "org-b", config, keys));
});

describe("marking a finding not a bug", () => {
  test("moves it out of its section and the headline into its own, with the reason and who, and undo puts it back", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1", verdict: "confirmed" }, { key: "f2", verdict: "confirmed" }, { key: "f3", sameAs: "f1" }, { key: "fr", kind: "friction" }]);
    expect((await view("org-a", run)).headline).toBe("2 defects confirmed by replay.");

    await dismiss("org-a", run, "f1", "  It is meant to ask twice.  ", "u7");
    await dismiss("org-a", run, "fr", "The menu is where our users expect it.");
    expect(await stored(run)).toEqual([{ finding_key: "f1", reason: "It is meant to ask twice.", dismissed_by: "u7" }, { finding_key: "fr", reason: "The menu is where our users expect it.", dismissed_by: "u1" }]);
    const after = await view("org-a", run);
    expect(after.headline).toBe("1 defect confirmed by replay.");
    expect(after.report.confirmed.map((f) => f.key)).toEqual(["f2"]);
    expect(after.report.friction).toEqual([]);
    expect(after.report.dismissed.map((f) => [f.key, f.dismissal.reason, f.dismissal.userId, f.sameReports.map((s) => s.key)])).toEqual([
      ["f1", "It is meant to ask twice.", "u7", ["f3"]],
      ["fr", "The menu is where our users expect it.", "u1", []],
    ]);

    await undo("org-a", run, "f1");
    const undone = await view("org-a", run);
    expect(undone.headline).toBe("2 defects confirmed by replay.");
    expect(undone.report.dismissed.map((f) => f.key)).toEqual(["fr"]);
    await refused(undo("org-a", run, "f1"), /no longer marked/);
  });

  test("a run whose every defect is not a bug says so instead of claiming none were found", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1", verdict: "confirmed" }]);
    await dismiss("org-a", run, "f1", "Intended.");
    expect((await view("org-a", run)).headline).toBe("Every reported defect was marked not a bug.");
  });

  test("needs a reason of at most 500 characters, a finished run, and a finding the report shows on its own, and is done once", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1" }, { key: "f2", sameAs: "f1" }]);
    for (const reason of ["", "   ", "x".repeat(501), 42, undefined]) await refused(dismiss("org-a", run, "f1", reason), /at most 500 characters/);
    await refused(dismiss("org-a", run, "nope", "Intended."), /not found/);
    await refused(dismiss("org-a", run, "f2", "Intended."), /not found/);
    await dismiss("org-a", run, "f1", "x".repeat(500));
    await refused(dismiss("org-a", run, "f1", "Again."), /already marked/);
    expect((await stored(run)).map((d) => d.reason.length)).toEqual([500]);

    const live = await finishedRun("org-a", other, [{ key: "f1" }], "running");
    await refused(dismiss("org-a", live, "f1", "Intended."), /still going/);
    await asSystem(t.db, (tx) => tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped", finished_at: new Date() }).where("id", "=", live).execute());
  });

  test("another workspace can neither mark, undo nor read a workspace's dismissals", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1" }]);
    await refused(dismiss("org-b", run, "f1", "Mine now."), /run was not found/);
    await dismiss("org-a", run, "f1", "Intended.");
    await refused(undo("org-b", run, "f1"), /no longer marked/);
    expect(await stored(run)).toHaveLength(1);
    expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("finding_dismissals").selectAll().execute())).toEqual([]);
    await expect(withOrg(t.db, "org-b", (tx) => tx.insertInto("finding_dismissals").values({ org_id: "org-a", run_id: run, finding_key: "f1", reason: "x", dismissed_by: "u9" }).execute())).rejects.toThrow(/row-level security|duplicate key/);
    await expect(withOrg(t.db, "org-b", (tx) => tx.insertInto("finding_dismissals").values({ org_id: "org-b", run_id: run, finding_key: "f1", reason: "x", dismissed_by: "u9" }).execute())).rejects.toThrow(/violates foreign key|row-level security|duplicate key/);
  });
});

describe("later runs", () => {
  test("a role session of the project is given its dismissals newest first, at most the protocol's limit, and nothing from another project or workspace", async () => {
    const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "Later" }, keys));
    const before = await finishedRun("org-a", project, [{ key: "old", title: "Export asks twice" }, { key: "new", title: "Menu on the left" }, { key: "kept", title: "Real bug" }]);
    await dismiss("org-a", before, "old", "Asking twice is on purpose.");
    await dismiss("org-a", before, "new", "Our users expect it there.");
    await asSystem(t.db, (tx) => tx.updateTable("finding_dismissals").set({ dismissed_at: new Date(Date.now() - 60_000) }).where("finding_key", "=", "old").execute());
    await dismiss("org-a", await finishedRun("org-a", other, [{ key: "f1", title: "Other project's" }]), "f1", "Not this project.");
    await dismiss("org-b", await finishedRun("org-b", theirs, [{ key: "f1", title: "Another workspace's" }]), "f1", "Not this workspace.");

    expect(await withOrg(t.db, "org-a", (tx) => notBugsOf(tx, "org-a", project))).toEqual([
      { title: "Menu on the left", reason: "Our users expect it there." },
      { title: "Export asks twice", reason: "Asking twice is on purpose." },
    ]);

    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    expect(job.kind).toBe("role_session");
    expect(job.notBugs).toEqual([
      { title: "Menu on the left", reason: "Our users expect it there." },
      { title: "Export asks twice", reason: "Asking twice is on purpose." },
    ]);
    await asSystem(t.db, async (tx) => {
      await tx.updateTable("jobs").set({ status: "cancelled", token_hash: null, lease_until: null }).where("id", "=", job.jobId).execute();
      await tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped", finished_at: new Date() }).where("id", "=", job.runId).execute();
    });

    const many = await finishedRun("org-a", project, Array.from({ length: MAX_NOT_BUGS + 3 }, (_, i) => ({ key: `m${i}` })));
    for (let i = 0; i < MAX_NOT_BUGS + 3; i++) await dismiss("org-a", many, `m${i}`, `Reason ${i}`);
    expect(await withOrg(t.db, "org-a", (tx) => notBugsOf(tx, "org-a", project))).toHaveLength(MAX_NOT_BUGS);
  });

  test("a role session of a project with no dismissals is given none", async () => {
    const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "Clean" }, keys));
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    expect(job.kind).toBe("role_session");
    expect("notBugs" in job).toBe(false);
    await asSystem(t.db, async (tx) => {
      await tx.updateTable("jobs").set({ status: "cancelled", token_hash: null, lease_until: null }).where("id", "=", job.jobId).execute();
      await tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped", finished_at: new Date() }).where("id", "=", job.runId).execute();
    });
  });
});

test("the run history counts neither a dismissed confirmed defect nor a dismissed defect whose replay failed", async () => {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name: "History" }, keys));
  const run = await finishedRun("org-a", project, [{ key: "f1", verdict: "confirmed" }, { key: "f2", verdict: "confirmed" }, { key: "f3", replayFailed: true }]);
  const line = async () => (await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: project }))).runs[0]!;
  expect(await line()).toMatchObject({ confirmed: 2, unchecked: false });
  await dismiss("org-a", run, "f1", "Intended.");
  await dismiss("org-a", run, "f2", "Intended.");
  expect(await line()).toMatchObject({ confirmed: 0, unchecked: true });
  await dismiss("org-a", run, "f3", "Intended.");
  expect(await line()).toMatchObject({ confirmed: 0, unchecked: false });
});
