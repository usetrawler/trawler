import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring, last4 } from "../lib/secrets.ts";
import { AccountLimit, addAccount, createPlan, createProject, firstPlan, LastPlan, listPlans, listProjects, loadProjectConfig, MAX_PLANS, nextPlanName, PlanInUse, PlanLimit, PlanNameTaken, PlanNotFound, removePlan, renamePlan, projectExists, projectForEditing, ProjectNotFound, removeAccount, replacePlan, UnknownAccount } from "./projects.ts";
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
  goals: [{ id: "sign-in", instruction: "Get in.", personaId: "ana" }, { id: "invoice", instruction: "Send an invoice.", personaId: "ana" }, { id: "browse", instruction: "Find the prices.", personaId: "lee" }],
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

test("a goal meant for everyone is copied onto each person under its own id", async () => {
  const shared = ProjectConfigSchema.parse({ ...config, goals: [{ id: "sign-in", instruction: "Get in." }, { id: "sign-in-lee", instruction: "Taken." , personaId: "lee" }] });
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", shared, keys));
  const loaded = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(loaded.goals).toEqual([
    { id: "sign-in", instruction: "Get in.", personaId: "ana" },
    { id: "sign-in-lee-2", instruction: "Get in.", personaId: "lee" },
    { id: "sign-in-lee", instruction: "Taken.", personaId: "lee" },
  ]);
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
  await expect(withOrg(t.db, "org-b", (tx) => loadProjectConfig(tx, "org-b", id, keys))).rejects.toThrow(ProjectNotFound);
  await expect(withOrg(t.db, "org-b", (tx) => replacePlan(tx, "org-b", id, { personas: config.personas, goals: config.goals }))).rejects.toThrow(ProjectNotFound);
  expect((await withOrg(t.db, "org-b", (tx) => listProjects(tx, "org-b"))).map((p) => p.id)).not.toContain(id);
  expect((await asSystem(t.db, (tx) => listProjects(tx, "org-b"))).map((p) => p.id)).not.toContain(id);
});

test("a persona cannot be attached to another organisation's project, even by the system role", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const planId = (await asSystem(t.db, (tx) => firstPlan(tx, "org-a", id))).id;
  await expect(asSystem(t.db, (tx) => tx.insertInto("personas").values({ org_id: "org-b", project_id: id, plan_id: planId, key: "x", name: "X", brief: "b", position: 9 }).execute())).rejects.toThrow(/foreign key/);
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
  const planId = (await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", id))).id;
  await expect(withOrg(t.db, "org-a", (tx) => tx.insertInto("target_gates").values({ org_id: "org-a", project_id: id, plan_id: planId, kind: "basic_auth", name: "other", secret: "v1:x", secret_hint: "…", position: 9 }).execute())).rejects.toThrow(/duplicate key|unique/);
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

  await expect(withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "x@shop.test", password: "" }, keys))).rejects.toThrow();
  await expect(withOrg(t.db, "org-b", (tx) => addAccount(tx, "org-b", id, { username: "x@shop.test", password: "long-enough-1" }, keys))).rejects.toThrow(ProjectNotFound);
  await expect(withOrg(t.db, "org-b", (tx) => removeAccount(tx, "org-b", id, ref))).rejects.toThrow(ProjectNotFound);

  const second = await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "two@shop.test", password: "second-pass-1" }, keys));
  await withOrg(t.db, "org-a", (tx) => removeAccount(tx, "org-a", id, ref));
  const after = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(after.accounts.map((a) => a.ref)).toEqual([second]);
  expect(after.personas[0]!.accountRef).toBeUndefined();
  expect(await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "three@shop.test", password: "third-pass-1" }, keys))).not.toBe(ref);
});

test("a test account password shorter than 8 characters is stored encrypted and reaches the runner as it was typed", async () => {
  const simple = ProjectConfigSchema.parse({ name: "Shop", targetUrl: "https://shop.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Buy." }] });
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", simple, keys));
  const ref = await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "user", password: "pw12" }, keys));
  expect((await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys))).accounts).toEqual([{ ref, username: "user", password: "pw12" }]);
  const editing = await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id));
  expect(JSON.stringify(editing)).not.toContain("pw12");
});

test("saving a plan that points at a removed account says so, and the account limit has its own error", async () => {
  const simple = ProjectConfigSchema.parse({ name: "Shop", targetUrl: "https://shop.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Buy." }] });
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", simple, keys));
  await expect(withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: [{ id: "ana", name: "Ana", brief: "b", accountRef: "account-gone" }], goals: simple.goals }))).rejects.toBeInstanceOf(UnknownAccount);
  for (let i = 0; i < 20; i++) await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: `u${i}@shop.test`, password: "password-123" }, keys));
  await expect(withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "one-more@shop.test", password: "password-123" }, keys))).rejects.toBeInstanceOf(AccountLimit);
});

test("a project exists only in its own workspace", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  expect(await withOrg(t.db, "org-a", (tx) => projectExists(tx, "org-a", id))).toBe(true);
  expect(await withOrg(t.db, "org-b", (tx) => projectExists(tx, "org-b", id))).toBe(false);
  expect(await withOrg(t.db, "org-a", (tx) => projectExists(tx, "org-a", "0f8fad5b-d9cb-469f-a165-70867728950e"))).toBe(false);
});

test("a person with a test account always counts as signing in", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const editing = await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id));
  expect(editing?.personas.map((p) => [p.key, p.signs_in])).toEqual([["ana", true], ["lee", false]]);
});

test("an order of play that interleaves people comes back exactly as saved", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const interleaved = [
    { id: "submit", instruction: "Submit.", personaId: "ana" },
    { id: "review", instruction: "Review Ana's.", personaId: "lee" },
    { id: "decision", instruction: "See the decision.", personaId: "ana" },
  ];
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: config.personas, goals: interleaved }));
  const loaded = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(loaded.goals.map((g) => g.id)).toEqual(["submit", "review", "decision"]);
  const editing = await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id));
  expect(editing!.goals.map((g) => g.key)).toEqual(["submit", "review", "decision"]);
});

test("a project starts with one plan, named from its focus or \"Plan 1\", that holds its people, goals, accounts and gates", async () => {
  const named = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys, { focus: "Team invitation flow" }));
  const plain = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  expect((await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", named))).name).toBe("Team invitation flow");
  expect((await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", plain))).name).toBe("Plan 1");
  const plan = await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", plain));
  const held = await withOrg(t.db, "org-a", async (tx) => {
    const count = async (table: "personas" | "goals" | "target_accounts" | "target_gates") =>
      Number((await tx.selectFrom(table).select(sql<string>`count(*)`.as("n")).where("plan_id", "=", plan.id).executeTakeFirstOrThrow()).n);
    return [await count("personas"), await count("goals"), await count("target_accounts"), await count("target_gates")];
  });
  expect(held).toEqual([2, 3, 2, 3]);
});

test("a second plan of one project reuses the first plan's keys, but a plan keeps its own accounts and cannot repeat a key", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const second = await withOrg(t.db, "org-a", (tx) => tx.insertInto("plans").values({ org_id: "org-a", project_id: id, name: "Second", position: 1 }).returning("id").executeTakeFirstOrThrow());
  const persona = (key: string, extra: Record<string, unknown> = {}) => ({ org_id: "org-a", project_id: id, plan_id: second.id, key, name: "X", brief: "b", position: 0, ...extra });
  await withOrg(t.db, "org-a", (tx) => tx.insertInto("personas").values(persona("ana")).execute());
  await expect(withOrg(t.db, "org-a", (tx) => tx.insertInto("personas").values(persona("ana")).execute())).rejects.toThrow(/duplicate key|unique/);
  await expect(withOrg(t.db, "org-a", (tx) => tx.insertInto("personas").values(persona("lee", { account_ref: "ana" })).execute())).rejects.toThrow(/foreign key/);
  await expect(withOrg(t.db, "org-a", (tx) => tx.insertInto("plans").values({ org_id: "org-a", project_id: id, name: "SECOND" }).execute())).rejects.toThrow(/duplicate key|unique/);
});

test("another workspace cannot see a plan or hang one on a project that is not its own", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("plans").select("id").where("project_id", "=", id).execute())).toEqual([]);
  await expect(asSystem(t.db, (tx) => tx.insertInto("plans").values({ org_id: "org-b", project_id: id, name: "Sneaky" }).execute())).rejects.toThrow(/foreign key/);
  await expect(withOrg(t.db, "org-b", (tx) => firstPlan(tx, "org-b", id))).rejects.toThrow();
});

const seat = (id: string) => ({ personas: [{ id, name: id, brief: "b" }], goals: [{ id: `g-${id}`, instruction: "Do it.", personaId: id }] });

test("plans are named Plan 1, Plan 2 and so on unless the person chose a name, and a name is free to reuse once its plan is gone", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  expect(await withOrg(t.db, "org-a", (tx) => nextPlanName(tx, "org-a", id))).toBe("Plan 2");
  const second = await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "Plan 2", features: ["Invite a teammate"], ...seat("kofi") }));
  expect(await withOrg(t.db, "org-a", (tx) => nextPlanName(tx, "org-a", id))).toBe("Plan 3");
  await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "  Billing  ", ...seat("lee") }));
  expect((await withOrg(t.db, "org-a", (tx) => listPlans(tx, "org-a", id))).map((p) => [p.name, p.people, p.features])).toEqual([["Plan 1", 2, []], ["Plan 2", 1, ["Invite a teammate"]], ["Billing", 1, []]]);
  await expect(withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "plan 2", ...seat("x") }))).rejects.toThrow(PlanNameTaken);
  await withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", id, second.id));
  await expect(withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "Plan 2", ...seat("kofi") }))).resolves.toMatchObject({ name: "Plan 2" });
});

test("a plan is renamed within its project, and cannot take another plan's name in any letter case", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const second = await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "Plan 2", ...seat("kofi") }));
  const first = await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", id));
  expect(await withOrg(t.db, "org-a", (tx) => renamePlan(tx, "org-a", id, second.id, " Invitations "))).toBe("Invitations");
  await expect(withOrg(t.db, "org-a", (tx) => renamePlan(tx, "org-a", id, second.id, "PLAN 1"))).rejects.toThrow(PlanNameTaken);
  expect(await withOrg(t.db, "org-a", (tx) => renamePlan(tx, "org-a", id, first.id, "Plan 1"))).toBe("Plan 1");
  await expect(withOrg(t.db, "org-b", (tx) => renamePlan(tx, "org-b", id, second.id, "Mine"))).rejects.toThrow();
  await expect(withOrg(t.db, "org-a", (tx) => renamePlan(tx, "org-a", id, "not-a-plan", "X"))).rejects.toThrow(PlanNotFound);
});

test("a project keeps at least one plan and at most ten, and a plan with a live run stays", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const only = await withOrg(t.db, "org-a", (tx) => firstPlan(tx, "org-a", id));
  await expect(withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", id, only.id))).rejects.toThrow(LastPlan);
  for (let n = 2; n <= MAX_PLANS; n++) await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: `Plan ${n}`, ...seat(`p${n}`) }));
  await expect(withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "One too many", ...seat("z") }))).rejects.toThrow(PlanLimit);
  await sql`insert into runs (org_id, project_id, plan_id, plan_name, number, status, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by)
    values ('org-a', ${id}, ${only.id}, 'Plan 1', (select coalesce(max(number), 0) + 1 from runs where org_id = 'org-a'), 'running', '{}', 'm', 'm', 1, 10, 10, 'u')`.execute(t.db);
  await expect(withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", id, only.id))).rejects.toThrow(PlanInUse);
  await sql`update runs set status = 'succeeded' where plan_id = ${only.id}`.execute(t.db);
  await withOrg(t.db, "org-a", (tx) => removePlan(tx, "org-a", id, only.id));
  expect((await sql<{ plan_name: string; plan_id: string | null }>`select plan_name, plan_id from runs where project_id = ${id}`.execute(t.db)).rows).toEqual([{ plan_name: "Plan 1", plan_id: null }]);
});

test("each plan has its own people, goals, test accounts and gates, and the config a run loads is the plan's", async () => {
  const id = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const second = await withOrg(t.db, "org-a", (tx) => createPlan(tx, "org-a", id, { name: "Plan 2", ...seat("kofi") }));
  const ref = await withOrg(t.db, "org-a", (tx) => addAccount(tx, "org-a", id, { username: "kofi@acme.test", password: "kofi-password-1" }, keys, second.id));
  const first = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  const other = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys, second.id));
  expect(first.personas.map((p) => p.id)).toEqual(["ana", "lee"]);
  expect(first.accounts.map((a) => a.username).sort()).toEqual(["ana@acme.test", "zed@acme.test"]);
  expect(first.httpCredentials).toBeDefined();
  expect(other.personas.map((p) => p.id)).toEqual(["kofi"]);
  expect(other.accounts).toEqual([{ ref, username: "kofi@acme.test", password: "kofi-password-1" }]);
  expect(other.httpCredentials).toBeUndefined();
  expect(other.secretHeaders).toEqual({});
  await withOrg(t.db, "org-a", (tx) => replacePlan(tx, "org-a", id, { personas: [{ id: "kofi", name: "Kofi", brief: "b", accountRef: ref }], goals: seat("kofi").goals }, undefined, { planId: second.id, features: ["Pay"] }));
  expect((await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id, second.id)))).toMatchObject({ plan: { id: second.id, name: "Plan 2" }, features: ["Pay"], personas: [{ key: "kofi", account_ref: ref }] });
  await withOrg(t.db, "org-a", (tx) => removeAccount(tx, "org-a", id, ref, second.id));
  expect((await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id, second.id)))!.personas[0]!.account_ref).toBeNull();
  expect((await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys))).accounts).toHaveLength(2);
  await expect(withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys, "11111111-1111-4111-8111-111111111111"))).rejects.toThrow(PlanNotFound);
  expect(await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id, "11111111-1111-4111-8111-111111111111"))).toBeNull();
});
