import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { createDb } from "../db/index.ts";
import { testDb } from "../db/test-db.ts";
import { createApiToken, withinTokenRate } from "./tokens.ts";

const t = await testDb();
const otherInstance = createDb(t.url, 2);
afterAll(async () => {
  await otherInstance.destroy();
  await t.drop();
});

let a = { tokenId: "", orgId: "org-a" };
let b = { tokenId: "", orgId: "org-a" };
let foreign = { tokenId: "", orgId: "org-b" };

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  a.tokenId = (await withOrg(t.db, "org-a", (tx) => createApiToken(tx, "org-a", "u", { name: "a" }))).id;
  b.tokenId = (await withOrg(t.db, "org-a", (tx) => createApiToken(tx, "org-a", "u", { name: "b" }))).id;
  foreign.tokenId = (await withOrg(t.db, "org-b", (tx) => createApiToken(tx, "org-b", "u", { name: "c" }))).id;
});

test("a token may make 120 calls a minute, then waits until the next minute, and each token has its own allowance", async () => {
  const now = 1_000_000 * 60_000 + 5_000;
  for (let i = 0; i < 120; i++) expect(await withinTokenRate(t.db, a, now + i)).toEqual({ ok: true });
  expect(await withinTokenRate(t.db, a, now + 500)).toEqual({ ok: false, retryAfterSeconds: 55 });
  expect(await withinTokenRate(t.db, b, now + 500)).toEqual({ ok: true });
  expect(await withinTokenRate(t.db, foreign, now + 500)).toEqual({ ok: true });
  expect(await withinTokenRate(t.db, a, now + 54_000)).toMatchObject({ ok: false, retryAfterSeconds: 1 });
  expect(await withinTokenRate(t.db, a, now + 55_000)).toEqual({ ok: true });
});

test("two server instances share one allowance for a token", async () => {
  const now = 2_000_000 * 60_000;
  for (let i = 0; i < 60; i++) {
    expect(await withinTokenRate(t.db, b, now)).toEqual({ ok: true });
    expect(await withinTokenRate(otherInstance, b, now)).toEqual({ ok: true });
  }
  expect(await withinTokenRate(t.db, b, now)).toMatchObject({ ok: false });
  expect(await withinTokenRate(otherInstance, b, now)).toMatchObject({ ok: false });
});

test("concurrent calls never let more than the allowance through", async () => {
  const now = 3_000_000 * 60_000;
  const results = await Promise.all(Array.from({ length: 150 }, (_, i) => withinTokenRate(i % 2 ? t.db : otherInstance, a, now)));
  expect(results.filter((r) => r.ok)).toHaveLength(120);
});

test("buckets older than a few minutes are swept when a new minute starts, and only for that token", async () => {
  const start = 4_000_000 * 60_000;
  await withinTokenRate(t.db, a, start);
  await withinTokenRate(t.db, b, start);
  await withinTokenRate(t.db, a, start + 20 * 60_000);
  const left = await asSystem(t.db, (tx) => tx.selectFrom("api_token_calls").select(["token_id", "minute"]).where("minute", ">=", String(4_000_000)).execute());
  expect(left.filter((r) => r.token_id === a.tokenId).map((r) => Number(r.minute))).toEqual([4_000_020]);
  expect(left.filter((r) => r.token_id === b.tokenId).map((r) => Number(r.minute))).toEqual([4_000_000]);
});

test("a workspace cannot see another workspace's counters", async () => {
  const seen = await withOrg(t.db, "org-b", (tx) => tx.selectFrom("api_token_calls").select("token_id").execute());
  expect(new Set(seen.map((r) => r.token_id))).toEqual(new Set([foreign.tokenId]));
});
