import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb, type Database } from "./index.ts";

export const TEST_SERVER_URL = process.env.TRAWLER_TEST_DATABASE_URL ?? "postgres://trawler:trawler@localhost:54329/postgres";
export const TEMPLATE_DATABASE = "trawler_test_template";

export function databaseUrl(name: string): string {
  const url = new URL(TEST_SERVER_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function onServer<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_SERVER_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function testDb(): Promise<{ db: Database; url: string; name: string; drop: () => Promise<void> }> {
  const name = `trawler_test_${randomUUID().replaceAll("-", "")}`;
  await onServer((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`));
  const url = databaseUrl(name);
  const db = createDb(url, 4);
  return {
    db, url, name,
    drop: async () => {
      await db.destroy();
      await onServer((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
