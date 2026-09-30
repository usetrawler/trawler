import { sql } from "kysely";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { onServer, testDb } from "./test-db.ts";

const first = await testDb();
afterAll(() => first.drop());
const second = await testDb();
afterAll(() => second.drop());

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

test("dropping a test database waits for a connection that is still closing instead of killing it", async () => {
  const t = await testDb();
  const closing = new pg.Client({ connectionString: t.url });
  await closing.connect();
  const errors: string[] = [];
  closing.on("error", (err: Error & { code?: string }) => errors.push(err.code ?? err.message));
  const dropped = t.drop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(errors).toEqual([]);
  await closing.end();
  await dropped;
  expect(errors).toEqual([]);
  expect((await onServer((c) => c.query("SELECT 1 FROM pg_database WHERE datname = $1", [t.name]))).rowCount).toBe(0);
});

test("a connection left open is named when the database is dropped, instead of failing later as an unhandled error", async () => {
  const t = await testDb();
  const leaked = new pg.Client({ connectionString: t.url });
  await leaked.connect();
  leaked.on("error", () => {});
  await expect(t.drop()).rejects.toThrow(new RegExp(`test database ${t.name} still had 1 open connection`));
  expect((await onServer((c) => c.query("SELECT 1 FROM pg_database WHERE datname = $1", [t.name]))).rowCount).toBe(0);
}, 15_000);
