import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { checkOpenRouterKey, openRouterKey, openRouterKeyHint, setOpenRouterKey } from "./credentials.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const KEY_A = "sk-or-v1-" + "a".repeat(40) + "1234";
const KEY_B = "sk-or-v1-" + "b".repeat(40) + "9876";

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
});

test("the key is stored encrypted, shown only by its hint, and replaced in place", async () => {
  expect(await withOrg(t.db, "org-a", (tx) => openRouterKeyHint(tx, "org-a"))).toBeNull();
  await withOrg(t.db, "org-a", (tx) => setOpenRouterKey(tx, "org-a", KEY_A, "u1", keys));
  const { rows } = await sql<{ secret: string; hint: string }>`select secret, hint from credentials`.execute(t.db);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.secret).not.toContain(KEY_A.slice(10, 30));
  expect(await withOrg(t.db, "org-a", (tx) => openRouterKeyHint(tx, "org-a"))).toBe(rows[0]!.hint);
  expect(rows[0]!.hint).toMatch(/1234$/);
  expect(await withOrg(t.db, "org-a", (tx) => openRouterKey(tx, "org-a", keys))).toBe(KEY_A);
  await withOrg(t.db, "org-a", (tx) => setOpenRouterKey(tx, "org-a", KEY_B, "u2", keys));
  expect(await withOrg(t.db, "org-a", (tx) => openRouterKey(tx, "org-a", keys))).toBe(KEY_B);
  expect((await sql`select 1 from credentials`.execute(t.db)).rows).toHaveLength(1);
});

test("another organisation neither sees nor can decrypt the key", async () => {
  expect(await withOrg(t.db, "org-b", (tx) => openRouterKeyHint(tx, "org-b"))).toBeNull();
  expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("credentials").selectAll().execute())).toEqual([]);
  const { rows } = await sql<{ secret: string }>`select secret from credentials where org_id = 'org-a'`.execute(t.db);
  expect(() => keys.decrypt(rows[0]!.secret, ["org-b", "credentials", "openrouter", "key"])).toThrow();
  await expect(withOrg(t.db, "org-b", (tx) => tx.insertInto("credentials").values({ org_id: "org-a", kind: "openrouter", secret: "x", hint: "x", created_by: "u" }).execute())).rejects.toThrow();
});

test("a key is checked with OpenRouter before it is accepted", async () => {
  const answering = (status: number): typeof fetch => async (url, init) => {
    expect(String(url)).toBe("https://or.test/api/v1/key");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY_A}`);
    return new Response("{}", { status });
  };
  const opts = (status: number) => ({ baseUrl: "https://or.test/api/v1", fetch: answering(status) });
  expect(await checkOpenRouterKey(KEY_A, opts(200))).toBe("ok");
  expect(await checkOpenRouterKey(KEY_A, opts(401))).toBe("invalid");
  expect(await checkOpenRouterKey(KEY_A, opts(503))).toBe("unavailable");
  expect(await checkOpenRouterKey("not a key", opts(200))).toBe("invalid");
  expect(await checkOpenRouterKey(KEY_A, { baseUrl: "https://or.test/api/v1", fetch: async () => { throw new Error("offline"); } })).toBe("unavailable");
  await expect(withOrg(t.db, "org-a", (tx) => setOpenRouterKey(tx, "org-a", "bad key!", "u", keys))).rejects.toThrow();
});
