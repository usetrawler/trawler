import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { keyStillStored, modelKey, modelKeyDetails, modelKeyHint, removeModelKey, setModelKey } from "./credentials.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const OPENROUTER = "sk-or-v1-" + "a".repeat(40) + "1234";
const ANTHROPIC = "sk-ant-api03-" + "b".repeat(40) + "9876";

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
});

test("one key per workspace, from any provider, stored encrypted and shown only by its hint", async () => {
  expect(await withOrg(t.db, "org-a", (tx) => modelKeyHint(tx, "org-a"))).toBeNull();
  await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "openrouter", key: OPENROUTER }, "u1", keys));
  expect(await withOrg(t.db, "org-a", (tx) => modelKeyHint(tx, "org-a"))).toMatchObject({ provider: "openrouter", baseUrl: null, hint: expect.stringMatching(/1234$/) });
  await withOrg(t.db, "org-a", (tx) => setModelKey(tx, "org-a", { provider: "anthropic", key: ANTHROPIC }, "u2", keys));
  expect(await withOrg(t.db, "org-a", (tx) => modelKey(tx, "org-a", keys))).toEqual({ provider: "anthropic", key: ANTHROPIC, baseUrl: null });
  const { rows } = await sql<{ secret: string }>`select secret from credentials`.execute(t.db);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.secret).not.toContain("bbbbbbbbbb");
});

test("a custom provider needs an https base URL; other providers never keep one", async () => {
  await expect(withOrg(t.db, "org-b", (tx) => setModelKey(tx, "org-b", { provider: "custom", key: "k".repeat(30), baseUrl: "http://llm.internal/v1" }, "u", keys))).rejects.toThrow(/https/);
  await withOrg(t.db, "org-b", (tx) => setModelKey(tx, "org-b", { provider: "custom", key: "k".repeat(30), baseUrl: "https://llm.example.com/v1" }, "u", keys));
  expect(await withOrg(t.db, "org-b", (tx) => modelKey(tx, "org-b", keys))).toEqual({ provider: "custom", key: "k".repeat(30), baseUrl: "https://llm.example.com/v1" });
  await withOrg(t.db, "org-b", (tx) => setModelKey(tx, "org-b", { provider: "openai", key: "sk-" + "o".repeat(40), baseUrl: "https://ignored.example.com" }, "u", keys));
  expect(await withOrg(t.db, "org-b", (tx) => modelKeyHint(tx, "org-b"))).toMatchObject({ provider: "openai", baseUrl: null });
});

test("another organisation neither sees nor can decrypt the key, and a key stored before providers existed still opens", async () => {
  expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("credentials").select("org_id").execute())).toEqual([{ org_id: "org-b" }]);
  const { rows } = await sql<{ secret: string }>`select secret from credentials where org_id = 'org-a'`.execute(t.db);
  expect(() => keys.decrypt(rows[0]!.secret, ["org-b", "credentials", "llm", "key"])).toThrow();
  const legacy = keys.encrypt(OPENROUTER, ["org-a", "credentials", "openrouter", "key"]);
  await sql`update credentials set kind = 'openrouter', secret = ${legacy} where org_id = 'org-a'`.execute(t.db);
  expect(await withOrg(t.db, "org-a", (tx) => modelKey(tx, "org-a", keys))).toMatchObject({ provider: "openrouter", key: OPENROUTER });
});

test("the key's details say who added it and when, and another workspace can neither read nor remove it", async () => {
  for (const org of ["org-c", "org-d"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  const before = Date.now() - 1000;
  await withOrg(t.db, "org-c", (tx) => setModelKey(tx, "org-c", { provider: "openrouter", key: OPENROUTER }, "user-c", keys));
  const details = await withOrg(t.db, "org-c", (tx) => modelKeyDetails(tx, "org-c"));
  expect(details).toMatchObject({ provider: "openrouter", hint: expect.stringMatching(/1234$/), baseUrl: null, addedBy: "user-c" });
  expect(details!.addedAt.getTime()).toBeGreaterThan(before);
  expect(await withOrg(t.db, "org-d", (tx) => modelKeyDetails(tx, "org-d"))).toBeNull();
  expect(await withOrg(t.db, "org-d", (tx) => modelKeyDetails(tx, "org-c"))).toBeNull();
  expect(await withOrg(t.db, "org-d", (tx) => removeModelKey(tx, "org-c"))).toBe(false);
  expect(await withOrg(t.db, "org-c", (tx) => modelKeyDetails(tx, "org-c"))).toMatchObject({ addedBy: "user-c" });
});

test("replacing the key records who replaced it, and removing it leaves the workspace without one", async () => {
  await withOrg(t.db, "org-c", (tx) => setModelKey(tx, "org-c", { provider: "openrouter", key: OPENROUTER }, "user-c", keys));
  await withOrg(t.db, "org-c", (tx) => setModelKey(tx, "org-c", { provider: "anthropic", key: ANTHROPIC }, "user-e", keys));
  expect(await withOrg(t.db, "org-c", (tx) => modelKeyDetails(tx, "org-c"))).toMatchObject({ provider: "anthropic", addedBy: "user-e" });
  expect(await withOrg(t.db, "org-c", (tx) => removeModelKey(tx, "org-c"))).toBe(true);
  expect(await withOrg(t.db, "org-c", (tx) => modelKey(tx, "org-c", keys))).toBeNull();
  expect(await withOrg(t.db, "org-c", (tx) => modelKeyHint(tx, "org-c"))).toBeNull();
  expect(await withOrg(t.db, "org-c", (tx) => removeModelKey(tx, "org-c"))).toBe(false);
});

test("reading and removing a key filter by workspace themselves, not only through row security", async () => {
  for (const org of ["org-sys-c", "org-sys-d"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await withOrg(t.db, "org-sys-c", (tx) => setModelKey(tx, "org-sys-c", { provider: "openrouter", key: OPENROUTER }, "user-c", keys));
  expect(await asSystem(t.db, (tx) => modelKeyDetails(tx, "org-sys-d"))).toBeNull();
  expect(await asSystem(t.db, (tx) => removeModelKey(tx, "org-sys-d"))).toBe(false);
  expect(await asSystem(t.db, (tx) => modelKeyDetails(tx, "org-sys-c"))).toMatchObject({ addedBy: "user-c" });
});

test("a removal names the key by when it was added, to the millisecond, and leaves a key added since", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-when', 'org-when', 'org-when', now())`.execute(t.db);
  await withOrg(t.db, "org-when", (tx) => setModelKey(tx, "org-when", { provider: "openrouter", key: OPENROUTER }, "user-w", keys));
  await sql`update credentials set created_at = '2026-09-26T10:21:33.123456Z' where org_id = 'org-when'`.execute(t.db);
  expect(await withOrg(t.db, "org-when", (tx) => removeModelKey(tx, "org-when", new Date("2026-09-26T10:21:33.124Z")))).toBe(false);
  expect(await withOrg(t.db, "org-when", (tx) => modelKeyHint(tx, "org-when"))).not.toBeNull();
  expect(await withOrg(t.db, "org-when", (tx) => removeModelKey(tx, "org-when", new Date("2026-09-26T10:21:33.123Z")))).toBe(true);
  expect(await withOrg(t.db, "org-when", (tx) => modelKeyHint(tx, "org-when"))).toBeNull();
});

test("a run about to start sees whether the key it checked is still the workspace's, by provider and base URL", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-still', 'org-still', 'org-still', now())`.execute(t.db);
  const still = (provider: "openrouter" | "anthropic" | "custom", baseUrl: string | null) => withOrg(t.db, "org-still", (tx) => keyStillStored(tx, "org-still", provider, baseUrl));
  expect(await still("openrouter", null)).toBe(false);
  await withOrg(t.db, "org-still", (tx) => setModelKey(tx, "org-still", { provider: "custom", key: ANTHROPIC, baseUrl: "https://llm.example.com/v1" }, "user-s", keys));
  expect(await still("custom", "https://llm.example.com/v1")).toBe(true);
  expect(await still("custom", "https://other.example.com/v1")).toBe(false);
  expect(await still("anthropic", null)).toBe(false);
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-keyless', 'org-keyless', 'org-keyless', now())`.execute(t.db);
  expect(await asSystem(t.db, (tx) => keyStillStored(tx, "org-keyless", "custom", "https://llm.example.com/v1"))).toBe(false);
});
