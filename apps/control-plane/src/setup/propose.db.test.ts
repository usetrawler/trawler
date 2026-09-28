import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { addAccount, loadProjectConfig, projectForEditing, replacePlan } from "../projects/projects.ts";
import { describeDraft, DraftGone, proposeFromDraft, SETUP_LIMITS, SetupLimited, startDraft, type SetupDeps } from "./propose.ts";
import { FetchRefused } from "./safe-fetch.ts";
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
  await expect(proposeFromDraft(deps(model), { orgId: "org-a", draftId, description: "d", features: ["x"] })).rejects.toBeInstanceOf(DraftGone);
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
  expect(both.filter((r) => r.status === "rejected" && r.reason instanceof DraftGone)).toHaveLength(1);
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
