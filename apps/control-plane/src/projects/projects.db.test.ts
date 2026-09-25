import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring, last4 } from "../lib/secrets.ts";
import { AccountLimit, addAccount, createProject, listProjects, loadProjectConfig, projectForEditing, removeAccount, replacePlan, UnknownAccount } from "./projects.ts";
import { ProjectConfigSchema as Schema } from "@usetrawler/protocol";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));

const config = ProjectConfigSchema.parse({
  name: "Acme",
  targetUrl: "https://app.acme.test/",
  docsUrl: "https://docs.acme.test/start",
  description: "Invoices.",
  personas: [{ id: "ana", name: "Ana", brief: "You invoice.", accountRef: "ana" }, { id: "lee", name: "Lee", brief: "You browse." }],
  goals: [{ id: "sign-in", instruction: "Get in." }, { id: "invoice", instruction: "Send an invoice." }],
  accounts: [{ ref: "zed", username: "zed@acme.test", password: "zed-password-1" }, { ref: "ana", username: "ana@acme.test", password: "hunter22-secret" }],
  httpCredentials: { username: "staging", password: "gate-pass-123" },
  extraHeaders: { "x-env": "stg" },
  secretHeaders: { "x-bypass": "bypass-token-123" },
});

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) {
    await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  }
});

test("a project round-trips to exactly the config the runner uses", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys, { focus: "invoices" }));
  const loaded = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(loaded).toEqual(config);
});

test("secrets are stored encrypted and never come back from list or edit queries", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const raw = JSON.stringify(await asSystem(t.db, async (tx) => ({
    accounts: await tx.selectFrom("target_accounts").selectAll().execute(),
    gates: await tx.selectFrom("target_gates").selectAll().execute(),
  })));
  for (const secret of ["hunter22-secret", "gate-pass-123", "bypass-token-123"]) expect(raw).not.toContain(secret);
  const listed = JSON.stringify(await withOrg(t.db, "org-a", (tx) => listProjects(tx, "org-a")));
  const editing = JSON.stringify(await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id)));
  for (const secret of ["hunter22-secret", "gate-pass-123", "bypass-token-123", "v1:"]) {
    expect(listed).not.toContain(secret);
    expect(editing).not.toContain(secret);
  }
  expect(editing).toContain("ana@acme.test");
});

test("another organisation can neither see nor load the project", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  expect(await withOrg(t.db, "org-b", (tx) => projectForEditing(tx, "org-b", id))).toBeNull();
  await expect(withOrg(t.db, "org-b", (tx) => loadProjectConfig(tx, "org-b", id, keys))).rejects.toThrow(/not found/);
  expect((await withOrg(t.db, "org-b", (tx) => listProjects(tx, "org-b"))).map((p) => p.id)).not.toContain(id);
  expect((await asSystem(t.db, (tx) => listProjects(tx, "org-b"))).map((p) => p.id)).not.toContain(id);
});

test("a persona cannot be attached to another organisation's project, even by the system role", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await expect(asSystem(t.db, (tx) => tx.insertInto("personas").values({ org_id: "org-b", project_id: id, key: "x", name: "X", brief: "b", position: 9 }).execute())).rejects.toThrow(/foreign key/);
});

test("ciphertext copied from one organisation's row does not decrypt in another", async () => {
  const a = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const b = await withOrg(t.db, "org-b", (tx) => createProject(tx, "org-b", config, keys));
  const secret = await asSystem(t.db, async (tx) => (await tx.selectFrom("target_accounts").select("password_secret").where("project_id", "=", a).executeTakeFirstOrThrow()).password_secret);
  await asSystem(t.db, (tx) => tx.updateTable("target_accounts").set({ password_secret: secret }).where("project_id", "=", b).execute());
  await expect(withOrg(t.db, "org-b", (tx) => loadProjectConfig(tx, "org-b", b, keys))).rejects.toThrow(/could not be decrypted/);
});

test("replacing the plan keeps accounts and validates the result", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, {
    personas: [{ id: "zed", name: "Zed", brief: "You are new.", accountRef: "ana" }],
    goals: [{ id: "export", instruction: "Export last month." }],
  }));
  const loaded = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(loaded.personas.map((p) => p.id)).toEqual(["zed"]);
  expect(loaded.goals.map((g) => g.id)).toEqual(["export"]);
  expect(loaded.accounts.map((a) => a.ref)).toEqual(["zed", "ana"]);
  await expect(withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: [{ id: "q", name: "Q", brief: "b", accountRef: "nobody" }], goals: [{ id: "g", instruction: "x" }] }))).rejects.toThrow(/unknown account/);
});

test("two plan replacements at the same time leave exactly one of them", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const run = (k: string) => withOrg(t.db, "org-a", async (tx) => {
    await replacePlan(tx, "org-a", id, { personas: [{ id: `p-${k}`, name: k, brief: "b" }], goals: [{ id: `g-${k}`, instruction: "x" }] });
    await sql`select pg_sleep(0.3)`.execute(tx);
  });
  await Promise.allSettled([run("one"), run("two")]);
  const loaded = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  const suffixes = new Set([...loaded.personas.map((p) => p.id.slice(2)), ...loaded.goals.map((g) => g.id.slice(2))]);
  expect(suffixes.size).toBe(1);
});

test("an account a persona uses cannot disappear from under it", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await expect(withOrg(t.db, "org-a", (tx) => tx.deleteFrom("target_accounts").where("project_id", "=", id).where("ref", "=", "ana").execute())).rejects.toThrow(/foreign key/);
});

test("only one basic-auth gate per project", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  await expect(withOrg(t.db, "org-a", (tx) => tx.insertInto("target_gates").values({ org_id: "org-a", project_id: id, kind: "basic_auth", name: "other", secret: "v1:x", secret_hint: "…", position: 9 }).execute())).rejects.toThrow(/duplicate key|unique/);
});

test("parsing a parsed config is stable, even at the origin limit", async () => {
  const many = Schema.parse({ ...config, allowedOrigins: Array.from({ length: 19 }, (_, i) => `https://o${i}.test`) });
  expect(Schema.parse(many)).toEqual(many);
  expect(Schema.safeParse({ ...config, allowedOrigins: Array.from({ length: 20 }, (_, i) => `https://o${i}.test`) }).success).toBe(false);
  await expect(withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys, { focus: "f".repeat(501) }))).rejects.toThrow(/500|too big/i);
});

test("header values and basic-auth usernames cannot smuggle extra headers", () => {
  expect(Schema.safeParse({ ...config, extraHeaders: { "x-a": "ok\r\nset-cookie: x=1" } }).success).toBe(false);
  expect(Schema.safeParse({ ...config, httpCredentials: { username: "a:b", password: "gate-pass-123" } }).success).toBe(false);
  expect(Schema.safeParse({ ...config, extraHeaders: { "x-a": "price €" } }).success).toBe(false);
  expect(Schema.safeParse({ ...config, extraHeaders: { "x-a": "tab\tok" } }).success).toBe(true);
});

test("oversized text is refused by the schema before it reaches the database", () => {
  const big = "x".repeat(20_000);
  expect(Schema.safeParse({ ...config, description: big }).success).toBe(false);
  expect(Schema.safeParse({ ...config, personas: [{ id: "a", name: "A", brief: big }] }).success).toBe(false);
  expect(Schema.safeParse({ ...config, name: "n".repeat(201) }).success).toBe(false);
  expect(Schema.safeParse({ ...config, extraHeaders: { "X-Env": "a" }, secretHeaders: { "x-env": "bypass-token-123" } }).success).toBe(false);
});

test("test accounts are added encrypted, reach the runner, and removing one detaches its personas", async () => {
  const simple = ProjectConfigSchema.parse({ name: "Shop", targetUrl: "https://shop.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Buy." }] });
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", simple, keys));
  const ref = await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: " buyer@shop.test ", password: "buyer-password-9" }, keys));
  expect(ref).toMatch(/^account-[0-9a-f]{12}$/);
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: [{ id: "ana", name: "Ana", brief: "b", accountRef: ref }], goals: simple.goals }));
  const loaded = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(loaded.accounts).toEqual([{ ref, username: "buyer@shop.test", password: "buyer-password-9" }]);
  expect(loaded.personas[0]!.accountRef).toBe(ref);
  const editing = await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id));
  expect(JSON.stringify(editing)).not.toContain("buyer-password-9");
  expect(editing!.accounts).toEqual([{ ref, username: "buyer@shop.test", password_hint: last4("buyer-password-9") }]);

  await expect(withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "x@shop.test", password: "short" }, keys))).rejects.toThrow();
  await expect(withOrg(t.db, "org-b", (tx) => addAccount(tx, "org-b", id, { username: "x@shop.test", password: "long-enough-1" }, keys))).rejects.toThrow(/not found/);
  await expect(withOrg(t.db, "org-b", (tx) => removeAccount(tx, "org-b", id, ref))).rejects.toThrow(/not found/);

  const second = await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "two@shop.test", password: "second-pass-1" }, keys));
  await withOrg(t.db, "org-a", (tx) => removeAccount(tx, "org-a", id, ref));
  const after = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(after.accounts.map((a) => a.ref)).toEqual([second]);
  expect(after.personas[0]!.accountRef).toBeUndefined();
  expect(await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "three@shop.test", password: "third-pass-1" }, keys))).not.toBe(ref);
});

test("saving a plan that points at a removed account says so, and the account limit has its own error", async () => {
  const simple = ProjectConfigSchema.parse({ name: "Shop", targetUrl: "https://shop.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Buy." }] });
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", simple, keys));
  await expect(withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: [{ id: "ana", name: "Ana", brief: "b", accountRef: "account-gone" }], goals: simple.goals }))).rejects.toBeInstanceOf(UnknownAccount);
  for (let i = 0; i < 20; i++) await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: `u${i}@shop.test`, password: "password-123" }, keys));
  await expect(withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "one-more@shop.test", password: "password-123" }, keys))).rejects.toBeInstanceOf(AccountLimit);
});
