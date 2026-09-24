import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./index.ts";
import { asSystem, withOrg } from "./tenancy.ts";
import { testDb } from "./test-db.ts";

const t = await testDb();
const db = t.db;
type Row = { id: string; org_id: string; name: string };

beforeAll(async () => {
  await sql`create table widgets (id uuid primary key default gen_random_uuid(), org_id text not null, name text not null)`.execute(db);
  await sql`call make_tenant_table('widgets')`.execute(db);
  await withOrg(db, "org-a", (tx) => sql`insert into widgets (org_id, name) values ('org-a', 'a1'), ('org-a', 'a2')`.execute(tx));
  await withOrg(db, "org-b", (tx) => sql`insert into widgets (org_id, name) values ('org-b', 'b1')`.execute(tx));
});
afterAll(() => t.drop());

const names = async (orgId: string) =>
  withOrg(db, orgId, async (tx) => (await sql<Row>`select * from widgets order by name`.execute(tx)).rows.map((r) => r.name));

test("an organisation sees only its own rows", async () => {
  expect(await names("org-a")).toEqual(["a1", "a2"]);
  expect(await names("org-b")).toEqual(["b1"]);
  expect(await names("org-c")).toEqual([]);
});

test("an organisation cannot change or delete another organisation's rows", async () => {
  const updated = await withOrg(db, "org-b", (tx) => sql`update widgets set name = 'stolen' where org_id = 'org-a'`.execute(tx));
  const deleted = await withOrg(db, "org-b", (tx) => sql`delete from widgets where org_id = 'org-a'`.execute(tx));
  expect(Number(updated.numAffectedRows)).toBe(0);
  expect(Number(deleted.numAffectedRows)).toBe(0);
  expect(await names("org-a")).toEqual(["a1", "a2"]);
});

test("an organisation cannot write rows for another organisation or move its rows away", async () => {
  await expect(withOrg(db, "org-b", (tx) => sql`insert into widgets (org_id, name) values ('org-a', 'planted')`.execute(tx))).rejects.toThrow(/row-level security/);
  await expect(withOrg(db, "org-b", (tx) => sql`update widgets set org_id = 'org-a'`.execute(tx))).rejects.toThrow(/row-level security/);
  expect(await names("org-a")).toEqual(["a1", "a2"]);
});

test("the application role sees nothing when no organisation is set", async () => {
  const rows = await db.transaction().execute(async (tx) => {
    await sql`set local role trawler_app`.execute(tx);
    return (await sql<Row>`select * from widgets`.execute(tx)).rows;
  });
  expect(rows).toEqual([]);
});

test("the organisation and role never leak to the next use of a pooled connection", async () => {
  const single = createDb(t.url, 1);
  try {
    await withOrg(single, "org-a", (tx) => sql`select 1`.execute(tx));
    await expect(withOrg(single, "org-a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const { rows } = await sql<{ role: string; org: string | null }>`select current_user as role, current_setting('app.org_id', true) as org`.execute(single);
    expect(rows[0]!.role).not.toBe("trawler_app");
    expect(rows[0]!.org ?? "").toBe("");
  } finally {
    await single.destroy();
  }
});

test("the system role sees every organisation, for login lookups and ingestion only", async () => {
  const all = await asSystem(db, async (tx) => (await sql<Row>`select name from widgets order by name`.execute(tx)).rows.map((r) => r.name));
  expect(all).toEqual(["a1", "a2", "b1"]);
});

test("an empty organisation id is refused before touching the database", async () => {
  await expect(withOrg(db, "", async () => 1)).rejects.toThrow(/organisation/);
  await expect(withOrg(db, "  ", async () => 1)).rejects.toThrow(/organisation/);
});
