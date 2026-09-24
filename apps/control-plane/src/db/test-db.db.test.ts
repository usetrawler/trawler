import { sql } from "kysely";
import { afterAll, expect, test } from "vitest";
import { testDb } from "./test-db.ts";

const first = await testDb();
const second = await testDb();
afterAll(async () => {
  await first.drop();
  await second.drop();
});

test("every test database starts from the migrated schema", async () => {
  const { rows } = await sql<{ version: string }>`select version from flyway_schema_history where success order by installed_rank`.execute(first.db);
  expect(rows.map((r) => r.version)).toContain("1");
});

test("test databases are isolated from each other", async () => {
  await sql`create table only_here (id int)`.execute(first.db);
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_name = 'only_here'`.execute(second.db);
  expect(rows[0]!.n).toBe(0);
});

test("dropping a test database removes it", async () => {
  const third = await testDb();
  const name = third.name;
  await third.drop();
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_database where datname = ${name}`.execute(first.db);
  expect(rows[0]!.n).toBe(0);
});
