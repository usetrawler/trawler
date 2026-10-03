import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
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
let projects = 0;
const newProject = (orgId = "org-a") => withOrg(t.db, orgId, (tx) => createProject(tx, orgId, { ...config, name: `Project ${++projects}` }, keys));

afterEach(async () => {
  await asSystem(t.db, async (tx) => {
    await tx.updateTable("jobs").set({ status: "cancelled", token_hash: null, lease_until: null }).where("status", "in", ["queued", "leased"]).execute();
    await tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped", finished_at: new Date() }).where("status", "in", ["queued", "running"]).execute();
  });
});

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
const notBugs = (projectId: string) => withOrg(t.db, "org-a", (tx) => notBugsOf(tx, "org-a", projectId));
const refused = async (work: Promise<unknown>, message: RegExp, why: CannotDismiss["why"] = "other") => {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CannotDismiss);
  expect((err as Error).message).toMatch(message);
  expect((err as CannotDismiss).why).toBe(why);
};
const stored = async (runId: string) => (await sql<{ finding_key: string; reason: string; dismissed_by: string }>`select finding_key, reason, dismissed_by from finding_dismissals where run_id = ${runId} order by finding_key`.execute(t.db)).rows;
const markedAt = (key: string, minutesAgo: number) => asSystem(t.db, (tx) => tx.updateTable("finding_dismissals").set({ dismissed_at: new Date(Date.now() - minutesAgo * 60_000) }).where("finding_key", "=", key).execute());

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  acme = await newProject();
  other = await newProject();
  theirs = await newProject("org-b");
});

describe("marking a finding not a bug", () => {
  test("moves it out of its section and the headline into its own, with the reason, who and when, and undo puts it back", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1", verdict: "confirmed" }, { key: "f2", verdict: "confirmed" }, { key: "f3", sameAs: "f1" }, { key: "fr", kind: "friction" }]);
    expect((await view("org-a", run)).headline).toBe("2 defects confirmed by replay.");

    const before = Date.now();
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
    const at = new Date(after.report.dismissed[0]!.dismissal.at).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);

    await undo("org-a", run, "f1");
    const undone = await view("org-a", run);
    expect(undone.headline).toBe("2 defects confirmed by replay.");
    expect(undone.report.dismissed.map((f) => f.key)).toEqual(["fr"]);
    await refused(undo("org-a", run, "f1"), /no longer marked/, "settled");
  });

  test("a run whose every defect is not a bug says so, and one with only friction marked still found none", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1", verdict: "confirmed" }]);
    await dismiss("org-a", run, "f1", "Intended.");
    expect((await view("org-a", run)).headline).toBe("Every reported defect was marked not a bug.");
    const calm = await finishedRun("org-a", acme, [{ key: "fr", kind: "friction" }]);
    await dismiss("org-a", calm, "fr", "Intended.");
    expect((await view("org-a", calm)).headline).toBe("No defects found.");
  });

  test("needs a reason of at most 500 characters and a finding the report shows on its own, and is done once", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1" }, { key: "f2", sameAs: "f1" }]);
    for (const reason of ["", "   ", "x".repeat(501), 42, undefined]) await refused(dismiss("org-a", run, "f1", reason), /at most 500 characters/, "reason");
    await refused(dismiss("org-a", run, "nope", "Intended."), /not found/);
    await refused(dismiss("org-a", run, "f2", "Intended."), /not found/);
    await dismiss("org-a", run, "f1", "x".repeat(500));
    await refused(dismiss("org-a", run, "f1", "Again."), /already marked/, "settled");
    expect((await stored(run)).map((d) => d.reason.length)).toEqual([500]);
  });

  test("is refused while Trawler still works on the run: live, a session still held on a stopped run, or a judge asked for again", async () => {
    const live = await finishedRun("org-a", other, [{ key: "f1" }], "running");
    await refused(dismiss("org-a", live, "f1", "Intended."), /still working on this run/);
    await asSystem(t.db, (tx) => tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "stopped", finished_at: new Date() }).where("id", "=", live).execute());
    await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "leased" }).where("run_id", "=", live).where("kind", "=", "role_session").execute());
    await refused(dismiss("org-a", live, "f1", "Intended."), /still working on this run/);
    await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", live).execute());
    await asSystem(t.db, (tx) => tx.insertInto("jobs").values({ org_id: "org-a", run_id: live, kind: "judge", position: 50, finding_key: "f1", status: "queued", requested_by: "u2" }).execute());
    await refused(dismiss("org-a", live, "f1", "Intended."), /still working on this run/);
    await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "cancelled" }).where("run_id", "=", live).execute());
    await dismiss("org-a", live, "f1", "Intended.");
    expect(await stored(live)).toHaveLength(1);
  });

  test("another workspace can neither mark, undo, read nor write a workspace's dismissals", async () => {
    const run = await finishedRun("org-a", acme, [{ key: "f1" }, { key: "f2" }]);
    await refused(dismiss("org-b", run, "f1", "Mine now."), /run was not found/);
    await dismiss("org-a", run, "f1", "Intended.");
    await refused(undo("org-b", run, "f1"), /no longer marked/, "settled");
    expect(await stored(run)).toHaveLength(1);
    expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("finding_dismissals").selectAll().execute())).toEqual([]);
    await expect(withOrg(t.db, "org-b", (tx) => tx.insertInto("finding_dismissals").values({ org_id: "org-a", run_id: run, finding_key: "f2", reason: "x", dismissed_by: "u9" }).execute())).rejects.toThrow(/row-level security/);
    await expect(withOrg(t.db, "org-b", (tx) => tx.insertInto("finding_dismissals").values({ org_id: "org-b", run_id: run, finding_key: "f2", reason: "x", dismissed_by: "u9" }).execute())).rejects.toThrow(/violates foreign key/);
    expect(await stored(run)).toHaveLength(1);
  });
});

describe("later runs", () => {
  test("a role session of the project is given its dismissals newest first, and nothing from another project or workspace", async () => {
    const project = await newProject();
    const before = await finishedRun("org-a", project, [{ key: "a-new", title: "Menu on the left" }, { key: "z-old", title: "Export asks twice" }, { key: "kept", title: "Real bug" }]);
    await dismiss("org-a", before, "z-old", "Asking twice is on purpose.");
    await dismiss("org-a", before, "a-new", "Our users expect it there.");
    await markedAt("z-old", 1);
    await dismiss("org-a", await finishedRun("org-a", other, [{ key: "o1", title: "Other project's" }]), "o1", "Not this project.");
    await dismiss("org-b", await finishedRun("org-b", theirs, [{ key: "t1", title: "Another workspace's" }]), "t1", "Not this workspace.");
    const expected = [{ title: "Menu on the left", reason: "Our users expect it there.", ref: `${before}/a-new` }, { title: "Export asks twice", reason: "Asking twice is on purpose.", ref: `${before}/z-old` }];
    expect(await notBugs(project)).toEqual(expected);

    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    expect(job.kind).toBe("role_session");
    expect(job.notBugs).toEqual(expected);
  });

  test("the same title and reason marked in several runs is told once, the newest 20 are kept, and each is one line within its limit", async () => {
    const project = await newProject();
    await dismiss("org-a", await finishedRun("org-a", project, [{ key: "r1", title: "Export asks twice" }]), "r1", "On purpose.");
    const second = await finishedRun("org-a", project, [{ key: "r2", title: "Export asks twice" }]);
    await dismiss("org-a", second, "r2", "On purpose.");
    expect(await notBugs(project)).toEqual([{ title: "Export asks twice", reason: "On purpose.", ref: `${second}/r2` }]);

    const long = await finishedRun("org-a", project, [{ key: "long", title: `A\ntitle   ${"t".repeat(400)}` }]);
    await dismiss("org-a", long, "long", `Two\n\nlines ${"r".repeat(480)}`);
    const [newest] = await notBugs(project);
    expect(newest!.title).toBe(`A title ${"t".repeat(292)}`);
    expect(newest!.reason).toBe(`Two lines ${"r".repeat(480)}`);

    const many = await finishedRun("org-a", project, Array.from({ length: MAX_NOT_BUGS + 3 }, (_, i) => ({ key: `m${i}`, title: `Many ${i}` })));
    for (let i = 0; i < MAX_NOT_BUGS + 3; i++) await dismiss("org-a", many, `m${i}`, `Reason ${i}`);
    const kept = await notBugs(project);
    expect(kept).toHaveLength(MAX_NOT_BUGS);
    expect(kept.map((n) => n.title)).not.toContain("Export asks twice");
  });

  test("a role session of a project with no dismissals is given none", async () => {
    const project = await newProject();
    await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, options));
    const job = (await claimJob(t.db, keys))!;
    expect(job.kind).toBe("role_session");
    expect("notBugs" in job).toBe(false);
  });
});

test("the run history counts neither a dismissed confirmed defect nor a dismissed defect whose replay failed", async () => {
  const project = await newProject();
  const run = await finishedRun("org-a", project, [{ key: "f1", verdict: "confirmed" }, { key: "f2", verdict: "confirmed" }, { key: "f3", replayFailed: true }]);
  const line = async () => (await withOrg(t.db, "org-a", (tx) => workspaceRuns(tx, "org-a", { projectId: project }))).runs[0]!;
  expect(await line()).toMatchObject({ confirmed: 2, unchecked: false });
  await dismiss("org-a", run, "f1", "Intended.");
  await dismiss("org-a", run, "f2", "Intended.");
  expect(await line()).toMatchObject({ confirmed: 0, unchecked: true });
  await dismiss("org-a", run, "f3", "Intended.");
  expect(await line()).toMatchObject({ confirmed: 0, unchecked: false });
});
