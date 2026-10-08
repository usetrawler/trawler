import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { addAccount, createProject, loadProjectConfig, projectForEditing, replacePlan } from "../projects/projects.ts";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { describeDraft, DraftGone, proposeFromDraft as proposed, SETUP_LIMITS, SetupLimited, SetupStillRunning, setupProgress, startDraft, type SetupDeps } from "./propose.ts";

const proposeFromDraft = async (...args: Parameters<typeof proposed>) => (await proposed(...args)).projectId;
import { FetchRefused } from "./safe-fetch.ts";
import { ProjectLimitReached } from "../runs/plans.ts";
import { SetupModelFailed } from "@usetrawler/core/setup";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

const summary = { name: "Acme", description: "Invoices for freelancers.", signUp: "open", features: [{ title: "Send an invoice", summary: "s" }, { title: "Get paid", summary: "s" }] };
const people = { personas: [
  { id: "ana", name: "Ana", brief: "You invoice.", signsIn: false, goals: [{ id: "invoice", instruction: "Send an invoice." }] },
  { id: "tom", name: "Tom", brief: "You approve payments.", signsIn: true, goals: [{ id: "approve", instruction: "Approve a payment." }] },
], playOrder: [] };
const reads = (finalUrl = "https://login.acme.test/start") => async () => ({ text: "<h1>Acme invoices</h1>", finalUrl });
const deps = (model: ReturnType<typeof scriptedModel>, fetchText: SetupDeps["fetchText"] = reads()): SetupDeps => ({ db: t.db, keys, model, modelId: "m", fetchText });

test("a URL becomes a draft, the draft a description and features, and the chosen features a project with its people", async () => {
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-a", url: "https://app.acme.test/" });
  expect(await describeDraft(deps(model), { orgId: "org-a", draftId })).toEqual(summary);
  const id = await proposeFromDraft(deps(model), { orgId: "org-a", draftId, description: "Invoices, edited.", features: ["Get paid", " My own flow "] });
  const config = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(config).toMatchObject({ name: "Acme", description: "Invoices, edited.", targetUrl: "https://app.acme.test/", accounts: [] });
  expect(config.allowedOrigins).toEqual(["https://app.acme.test", "https://login.acme.test"]);
  expect(config.goals.map((g) => [g.personaId, g.id])).toEqual([["ana", "invoice"], ["tom", "approve"]]);
  const editing = await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id));
  expect(editing?.features).toEqual(["Get paid", "My own flow"]);
  expect(editing?.personas.map((p) => [p.key, p.signs_in])).toEqual([["ana", false], ["tom", true]]);
  const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
  expect(prompts[0]).toContain("Acme invoices");
  expect(prompts[1]).toContain("My own flow");
  expect(prompts[1]).toContain("Invoices, edited.");
  expect(await proposeFromDraft(deps(model), { orgId: "org-a", draftId, description: "d", features: ["x"] })).toBe(id);
});

test("changing a project's features proposes its people again and keeps its test accounts", async () => {
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people)), text(JSON.stringify(summary)), text(JSON.stringify({ personas: [people.personas[1]] }))]);
  const first = await startDraft(deps(model), { orgId: "org-a", url: "https://app.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-a", draftId: first });
  const id = await proposeFromDraft(deps(model), { orgId: "org-a", draftId: first, description: "d", features: ["Send an invoice"] });
  const ref = await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "tom@acme.test", password: "pw" }, keys));
  const planned = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: planned.personas.map((p) => (p.id === "tom" ? { ...p, accountRef: ref } : p)), goals: planned.goals }));
  const again = await startDraft(deps(model), { orgId: "org-a", projectId: id });
  await describeDraft(deps(model), { orgId: "org-a", draftId: again });
  expect(await proposeFromDraft(deps(model), { orgId: "org-a", draftId: again, description: "Approvals.", features: ["Get paid"] })).toBe(id);
  const editing = await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id));
  expect(editing).toMatchObject({ description: "Approvals.", features: ["Get paid"] });
  expect(editing?.personas.map((p) => [p.key, p.account_ref, p.signs_in])).toEqual([["tom", ref, true]]);
  expect(editing?.accounts.map((a) => a.username)).toEqual(["tom@acme.test"]);
});

test("a draft belongs to its workspace and cannot be read or used from another", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-x', 'X', 'x', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-a", url: "https://app.acme.test/" });
  await expect(describeDraft(deps(model), { orgId: "org-x", draftId })).rejects.toBeInstanceOf(DraftGone);
  await expect(proposeFromDraft(deps(model), { orgId: "org-x", draftId, description: "d", features: ["x"] })).rejects.toBeInstanceOf(DraftGone);
  await expect(startDraft(deps(model), { orgId: "org-x", projectId: "0f8fad5b-d9cb-469f-a165-70867728950e" })).rejects.toThrow(/not found/);
  expect(model.doGenerateCalls).toHaveLength(0);
});

test("an unreadable page leaves no draft", async () => {
  const before = await sql<{ n: number }>`select count(*)::int as n from setup_drafts`.execute(t.db);
  await expect(startDraft(deps(scriptedModel([]), async () => { throw new FetchRefused("private", "the address is not allowed"); }), { orgId: "org-a", url: "https://Internal.ACME.test" })).rejects.toMatchObject({ reason: "private" });
  const after = await sql<{ n: number }>`select count(*)::int as n from setup_drafts`.execute(t.db);
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
});

test("a workspace cannot start unlimited setups, even all at once", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-busy', 'B', 'busy', now())`.execute(t.db);
  const slow: SetupDeps["fetchText"] = async () => (await new Promise((r) => setTimeout(r, 100)), { text: "<h1>x</h1>", finalUrl: "https://x.test/" });
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => startDraft(deps(scriptedModel([]), slow), { orgId: "org-busy", url: "https://x.test/" })));
  expect(results.filter((r) => r.status === "rejected" && r.reason instanceof SetupLimited)).toHaveLength(30 - SETUP_LIMITS.perTenMinutes);
});

test("a claim waits for a concurrent claim in the same workspace and sees its attempts", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-l', 'L', 'l', now())`.execute(t.db);
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const holding = new Promise<void>((r) => (locked = r));
  const holder = withOrg(t.db, "org-l", async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${"setup:org-l"}, 0))`.execute(tx);
    locked();
    await released;
    await sql`insert into setup_attempts (org_id) select 'org-l' from generate_series(1, ${SETUP_LIMITS.perTenMinutes})`.execute(tx);
  });
  await holding;
  let fetched = 0;
  const claim = startDraft(deps(scriptedModel([]), async () => (fetched++, { text: "x", finalUrl: "https://x.test/" })), { orgId: "org-l", url: "https://x.test/" });
  await new Promise((r) => setTimeout(r, 200));
  release();
  await holder;
  await expect(claim).rejects.toBeInstanceOf(SetupLimited);
  expect(fetched).toBe(0);
});

test("a draft is described once: asking again returns the same answer without calling the model", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-once', 'O', 'once', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary))]);
  const draftId = await startDraft(deps(model), { orgId: "org-once", url: "https://app.acme.test/" });
  expect(await describeDraft(deps(model), { orgId: "org-once", draftId })).toEqual(summary);
  expect(await describeDraft(deps(model), { orgId: "org-once", draftId })).toEqual(summary);
  expect(model.doGenerateCalls).toHaveLength(1);
  const failing = scriptedModel([text("not json"), text("not json")]);
  const broken = await startDraft(deps(failing), { orgId: "org-once", url: "https://app.acme.test/" });
  await expect(describeDraft(deps(failing), { orgId: "org-once", draftId: broken })).rejects.toBeInstanceOf(SetupModelFailed);
  expect(await setupProgress({ db: t.db }, { orgId: "org-once", draftId: broken })).toEqual({ state: "failed" });
  await expect(describeDraft(deps(failing), { orgId: "org-once", draftId: broken })).rejects.toBeInstanceOf(DraftGone);
  expect(failing.doGenerateCalls).toHaveLength(2);
});

test("a draft proposes people once, even when asked twice at the same time", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-twice', 'T', 'twice', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-twice", url: "https://twice.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-twice", draftId });
  const both = await Promise.allSettled([0, 1].map(() => proposeFromDraft(deps(model), { orgId: "org-twice", draftId, description: "d", features: ["Get paid"] })));
  expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(both.filter((r) => r.status === "rejected" && r.reason instanceof SetupStillRunning)).toHaveLength(1);
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from projects where target_url = 'https://twice.acme.test/'`.execute(t.db);
  expect(rows[0]!.n).toBe(1);
});

test("saving the plan keeps who signs in, and a draft older than a day is gone and cleared", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-keep', 'K', 'keep', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-keep", url: "https://app.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-keep", draftId });
  const id = await proposeFromDraft(deps(model), { orgId: "org-keep", draftId, description: "d", features: ["Get paid"] });
  const planned = await withOrg(t.db, "org-keep", (tx) => loadProjectConfig(tx, "org-keep", id, keys));
  await withOrg(t.db, "org-keep", (tx) => replacePlan(tx, "org-keep", id, { personas: planned.personas.map((p) => ({ ...p, name: `${p.name}!` })), goals: planned.goals }));
  const editing = await withOrg(t.db, "org-keep", (tx) => projectForEditing(tx, "org-keep", id));
  expect(editing?.personas.map((p) => [p.key, p.signs_in])).toEqual([["ana", false], ["tom", true]]);

  const old = await startDraft(deps(model), { orgId: "org-keep", url: "https://app.acme.test/" });
  await sql`update setup_drafts set created_at = now() - interval '25 hours' where id = ${old}`.execute(t.db);
  await expect(describeDraft(deps(model), { orgId: "org-keep", draftId: old })).rejects.toBeInstanceOf(DraftGone);
  await startDraft(deps(model), { orgId: "org-x", url: "https://other.test/" });
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from setup_drafts where id = ${old}`.execute(t.db);
  expect(rows[0]!.n).toBe(0);
});

test("proposing again never lets a project's origins outgrow what a run can load", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-wide', 'W', 'wide', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people)), text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const first = await startDraft(deps(model, reads("https://app.acme.test/")), { orgId: "org-wide", url: "https://app.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-wide", draftId: first });
  const id = await proposeFromDraft(deps(model), { orgId: "org-wide", draftId: first, description: "d", features: ["Get paid"] });
  const many = Array.from({ length: 19 }, (_, i) => `https://o${i}.acme.test`);
  await sql`update projects set allowed_origins = ${many} where id = ${id}`.execute(t.db);
  const again = await startDraft(deps(model), { orgId: "org-wide", projectId: id });
  await describeDraft(deps(model), { orgId: "org-wide", draftId: again });
  await proposeFromDraft(deps(model), { orgId: "org-wide", draftId: again, description: "d", features: ["Get paid"] });
  const config = await withOrg(t.db, "org-wide", (tx) => loadProjectConfig(tx, "org-wide", id, keys));
  expect(config.allowedOrigins).toHaveLength(20);
});

test("the sign-up answer is kept with the draft, and a product nobody can sign up to gets everyone signing in", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-closed', 'C', 'closed', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify({ ...summary, signUp: "closed" })), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-closed", url: "https://app.acme.test/" });
  expect((await describeDraft(deps(model), { orgId: "org-closed", draftId })).signUp).toBe("closed");
  expect((await describeDraft(deps(model), { orgId: "org-closed", draftId })).signUp).toBe("closed");
  const id = await proposeFromDraft(deps(model), { orgId: "org-closed", draftId, description: "d", features: ["Get paid"], signUp: "closed" });
  const editing = await withOrg(t.db, "org-closed", (tx) => projectForEditing(tx, "org-closed", id));
  expect(editing?.personas.map((p) => [p.key, p.signs_in])).toEqual([["ana", true], ["tom", true]]);
});

test("a Free workspace at its project limit is refused before the page is read or the model is asked, and its project can still be set up again", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-free', 'F', 'f', now())`.execute(t.db);
  await asSystem(t.db, (tx) => tx.deleteFrom("workspace_plans").where("org_id", "=", "org-free").execute());
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people)), text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const early = await startDraft(deps(model), { orgId: "org-free", url: "https://app.acme.test/" });
  const late = await startDraft(deps(model), { orgId: "org-free", url: "https://other.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-free", draftId: early });
  await describeDraft(deps(model), { orgId: "org-free", draftId: late });
  const id = await proposeFromDraft(deps(model), { orgId: "org-free", draftId: early, description: "d", features: ["Get paid"] });
  const asked = model.doGenerateCalls.length;

  await expect(proposeFromDraft(deps(model), { orgId: "org-free", draftId: late, description: "d", features: ["Get paid"] })).rejects.toBeInstanceOf(ProjectLimitReached);
  let read = 0;
  await expect(startDraft(deps(model, async () => (read++, { text: "x", finalUrl: "https://new.acme.test/" })), { orgId: "org-free", url: "https://new.acme.test/" })).rejects.toBeInstanceOf(ProjectLimitReached);
  expect({ read, asked: model.doGenerateCalls.length }).toEqual({ read: 0, asked });
  await expect(startDraft(deps(model), { orgId: "org-free", projectId: id })).resolves.toEqual(expect.any(String));
});

test("a setup whose answer was lost can be asked about: working while people are chosen, then the project it made, and asking again gives the same project without a second one, even on Free at its limit", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-lost', 'L', 'lost', now())`.execute(t.db);
  await asSystem(t.db, (tx) => tx.deleteFrom("workspace_plans").where("org_id", "=", "org-lost").execute());
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-lost", url: "https://lost.acme.test/" });
  expect(await setupProgress({ db: t.db }, { orgId: "org-lost", draftId })).toEqual({ state: "gone" });
  await describeDraft(deps(model), { orgId: "org-lost", draftId });
  expect(await setupProgress({ db: t.db }, { orgId: "org-lost", draftId })).toEqual({ state: "described", summary });
  await sql`update setup_drafts set proposing_at = now() where id = ${draftId}`.execute(t.db);
  expect(await setupProgress({ db: t.db }, { orgId: "org-lost", draftId })).toEqual({ state: "working" });
  await expect(proposeFromDraft(deps(model), { orgId: "org-lost", draftId, description: "d", features: ["Get paid"] })).rejects.toBeInstanceOf(SetupStillRunning);
  await sql`update setup_drafts set proposing_at = now() - interval '6 minutes' where id = ${draftId}`.execute(t.db);
  const id = await proposeFromDraft(deps(model), { orgId: "org-lost", draftId, description: "d", features: ["Get paid"] });
  expect(await setupProgress({ db: t.db }, { orgId: "org-lost", draftId })).toEqual({ state: "project", projectId: id });
  expect((await sql<{ page: string; docs: string | null }>`select page, docs from setup_drafts where id = ${draftId}`.execute(t.db)).rows[0]).toEqual({ page: "", docs: null });
  expect(await proposeFromDraft(deps(model), { orgId: "org-lost", draftId, description: "d", features: ["Get paid"] })).toBe(id);
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from projects where org_id = 'org-lost'`.execute(t.db);
  expect(rows[0]!.n).toBe(1);
  expect(await setupProgress({ db: t.db }, { orgId: "org-x", draftId })).toEqual({ state: "gone" });
});

test("deleting the project a setup made deletes that setup too", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-gone', 'G', 'gone', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-gone", url: "https://gone.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-gone", draftId });
  const id = await proposeFromDraft(deps(model), { orgId: "org-gone", draftId, description: "d", features: ["Get paid"] });
  expect(await setupProgress({ db: t.db }, { orgId: "org-gone", draftId })).toEqual({ state: "project", projectId: id });
  await asSystem(t.db, (tx) => tx.deleteFrom("projects").where("id", "=", id).execute());
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from setup_drafts where id = ${draftId}`.execute(t.db);
  expect(rows[0]!.n).toBe(0);
});

test("when choosing people fails, the setup can choose them again instead of looking busy", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-retry', 'R', 'retry', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text("not json"), text("still not json"), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-retry", url: "https://retry.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-retry", draftId });
  await expect(proposeFromDraft(deps(model), { orgId: "org-retry", draftId, description: "d", features: ["Get paid"] })).rejects.toBeInstanceOf(SetupModelFailed);
  expect((await setupProgress({ db: t.db }, { orgId: "org-retry", draftId })).state).toBe("described");
  await expect(proposeFromDraft(deps(model), { orgId: "org-retry", draftId, description: "d", features: ["Get paid"] })).resolves.toEqual(expect.any(String));
});

test("describing that is still going reads as working, and one that stopped long ago without a result as gone", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-slow', 'S', 'slow', now())`.execute(t.db);
  const draftId = await startDraft(deps(scriptedModel([])), { orgId: "org-slow", url: "https://slow.acme.test/" });
  await sql`update setup_drafts set described_at = now() where id = ${draftId}`.execute(t.db);
  expect(await setupProgress({ db: t.db }, { orgId: "org-slow", draftId })).toEqual({ state: "working" });
  await sql`update setup_drafts set described_at = now() - interval '10 minutes' where id = ${draftId}`.execute(t.db);
  expect(await setupProgress({ db: t.db }, { orgId: "org-slow", draftId })).toEqual({ state: "gone" });
});

test("a setup that another ask finished while people were being chosen hands back that project instead of making a second one", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-race', 'R', 'race', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people))]);
  const draftId = await startDraft(deps(model), { orgId: "org-race", url: "https://race.acme.test/" });
  await describeDraft(deps(model), { orgId: "org-race", draftId });
  const other = await withOrg(t.db, "org-race", (tx) => createProject(tx, "org-race", ProjectConfigSchema.parse({ name: "Race", targetUrl: "https://race.acme.test/", personas: [{ id: "a", name: "A", brief: "b" }], goals: [{ id: "g", instruction: "Look." }] }), keys));
  const choose = model.doGenerate.bind(model);
  model.doGenerate = async (options) => {
    await sql`update setup_drafts set result_project_id = ${other} where id = ${draftId}`.execute(t.db);
    return choose(options);
  };
  expect(await proposeFromDraft(deps(model), { orgId: "org-race", draftId, description: "d", features: ["Get paid"] })).toBe(other);
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from projects where org_id = 'org-race'`.execute(t.db);
  expect(rows[0]!.n).toBe(1);
});

test("a new plan is proposed from the same product, named as asked, and leaves the other plans, people and test accounts alone", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-plan', 'P', 'plan', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people)), text(JSON.stringify(summary)), text(JSON.stringify({ personas: [people.personas[0]] }))]);
  const first = await startDraft(deps(model), { orgId: "org-plan", url: "https://app.acme.test/new-plan" });
  await describeDraft(deps(model), { orgId: "org-plan", draftId: first });
  const { projectId } = await proposed(deps(model), { orgId: "org-plan", draftId: first, description: "d", features: ["Send an invoice"] });
  const ref = await withOrg(t.db, "org-plan", (tx) => addAccount(tx, "org-plan", projectId, { username: "tom@acme.test", password: "pw" }, keys));

  await expect(startDraft(deps(model), { orgId: "org-plan", projectId, planName: " plan 1 " })).rejects.toThrow(/already has that name/);
  const draft = await startDraft(deps(model), { orgId: "org-plan", projectId, planName: "  Payments  " });
  await describeDraft(deps(model), { orgId: "org-plan", draftId: draft });
  const made = await proposed(deps(model), { orgId: "org-plan", draftId: draft, description: "d", features: ["Get paid"] });
  expect(made).toMatchObject({ projectId, planId: expect.any(String) });
  expect(await setupProgress(deps(model), { orgId: "org-plan", draftId: draft })).toEqual({ state: "project", projectId, planId: made.planId });
  expect(await proposed(deps(model), { orgId: "org-plan", draftId: draft, description: "d", features: ["x"] })).toEqual(made);

  const plans = await withOrg(t.db, "org-plan", (tx) => tx.selectFrom("plans").select(["id", "name", "features"]).where("project_id", "=", projectId).orderBy("position").execute());
  expect(plans.map((p) => [p.name, p.features])).toEqual([["Plan 1", ["Send an invoice"]], ["Payments", ["Get paid"]]]);
  const second = await withOrg(t.db, "org-plan", (tx) => projectForEditing(tx, "org-plan", projectId, made.planId!));
  expect(second?.personas.map((p) => p.key)).toEqual(["ana"]);
  expect(second?.accounts).toEqual([]);
  const original = await withOrg(t.db, "org-plan", (tx) => projectForEditing(tx, "org-plan", projectId));
  expect(original?.personas.map((p) => p.key)).toEqual(["ana", "tom"]);
  expect(original?.accounts.map((a) => a.ref)).toEqual([ref]);
});

test("changing the features of one plan proposes people for that plan only", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-plans', 'Q', 'plans', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(summary)), text(JSON.stringify(people)), text(JSON.stringify(summary)), text(JSON.stringify({ personas: [people.personas[0]] })), text(JSON.stringify(summary)), text(JSON.stringify({ personas: [people.personas[1]] }))]);
  const first = await startDraft(deps(model), { orgId: "org-plans", url: "https://app.acme.test/two-plans" });
  await describeDraft(deps(model), { orgId: "org-plans", draftId: first });
  const { projectId } = await proposed(deps(model), { orgId: "org-plans", draftId: first, description: "d", features: ["Send an invoice"] });
  const added = await startDraft(deps(model), { orgId: "org-plans", projectId, planName: "Plan 2" });
  await describeDraft(deps(model), { orgId: "org-plans", draftId: added });
  const { planId } = await proposed(deps(model), { orgId: "org-plans", draftId: added, description: "d", features: ["Get paid"] });

  const again = await startDraft(deps(model), { orgId: "org-plans", projectId, planId: planId! });
  await describeDraft(deps(model), { orgId: "org-plans", draftId: again });
  expect(await proposed(deps(model), { orgId: "org-plans", draftId: again, description: "d", features: ["Send an invoice", "Get paid"] })).toEqual({ projectId, planId });
  expect((await withOrg(t.db, "org-plans", (tx) => projectForEditing(tx, "org-plans", projectId, planId!)))).toMatchObject({ features: ["Send an invoice", "Get paid"], personas: [{ key: "tom" }] });
  expect((await withOrg(t.db, "org-plans", (tx) => projectForEditing(tx, "org-plans", projectId)))).toMatchObject({ features: ["Send an invoice"], personas: [{ key: "ana" }, { key: "tom" }] });
  await expect(startDraft(deps(model), { orgId: "org-plans", projectId, planId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow();
});

test("a product on a private network is described by hand: no page is read, and the people are chosen from the description at its own address", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-hand', 'H', 'hand', now())`.execute(t.db);
  const model = scriptedModel([text(JSON.stringify(people))]);
  const neverRead: SetupDeps["fetchText"] = async () => { throw new Error("the page must not be read"); };
  const draftId = await startDraft(deps(model, neverRead), { orgId: "org-hand", url: "http://localhost:8080", byHand: { name: " Recurro ", description: " Tracks what renews and what it costs, for a household. " } });
  const progress = await setupProgress({ db: t.db }, { orgId: "org-hand", draftId });
  expect(progress).toMatchObject({ state: "described" });
  const id = await proposeFromDraft(deps(model, neverRead), { orgId: "org-hand", draftId, description: "Tracks what renews and what it costs, for a household.", features: ["Ask to cancel a charge"], signUp: "closed" });
  const config = await withOrg(t.db, "org-hand", (tx) => loadProjectConfig(tx, "org-hand", id, keys));
  expect({ name: config.name, targetUrl: config.targetUrl, allowedOrigins: config.allowedOrigins }).toEqual({ name: "Recurro", targetUrl: "http://localhost:8080/", allowedOrigins: ["http://localhost:8080"] });
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain("could not be read: it runs on a private network");
  expect(prompt).toContain("Ask to cancel a charge");
  expect(model.doGenerateCalls).toHaveLength(1);
});

test("a hand-written draft needs a web address", async () => {
  await expect(startDraft(deps(scriptedModel([])), { orgId: "org-hand", url: "ftp://localhost/", byHand: { name: "R", description: "d" } })).rejects.toBeInstanceOf(FetchRefused);
});

test("a project on a private network chooses features and people again from its own description, without reading a page", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-hand-2', 'H2', 'hand-2', now())`.execute(t.db);
  const refused: SetupDeps["fetchText"] = async () => { throw new FetchRefused("private", "private network"); };
  const model = scriptedModel([text(JSON.stringify(people)), text(JSON.stringify(people))]);
  const first = await startDraft(deps(model, refused), { orgId: "org-hand-2", url: "http://localhost:8080", byHand: { name: "Recurro", description: "Tracks renewals." } });
  const id = await proposeFromDraft(deps(model, refused), { orgId: "org-hand-2", draftId: first, description: "Tracks renewals.", features: ["Ask to cancel a charge"] });
  const again = await startDraft(deps(model, refused), { orgId: "org-hand-2", projectId: id, planName: "Second plan" });
  expect(await describeDraft(deps(model, refused), { orgId: "org-hand-2", draftId: again })).toEqual({ name: "Recurro", description: "Tracks renewals.", signUp: "unclear", features: [{ title: "Ask to cancel a charge", summary: "" }] });
  const result = await proposed(deps(model, refused), { orgId: "org-hand-2", draftId: again, description: "Tracks renewals.", features: ["Ask to cancel a charge"] });
  expect(result).toMatchObject({ projectId: id, planId: expect.any(String) });
  expect(model.doGenerateCalls).toHaveLength(2);
});
