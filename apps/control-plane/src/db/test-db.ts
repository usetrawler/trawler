import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createDb, type Database } from "./index.ts";

export const TEST_SERVER_URL = "postgres://trawler:trawler@localhost:54329/postgres";

declare module "vitest" {
  export interface ProvidedContext {
    testTemplate: string;
  }
}

export function databaseUrl(name: string): string {
  const url = new URL(TEST_SERVER_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function onServer<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_SERVER_URL });
  try {
    await client.connect();
  } catch (err) {
    const code = (err as { code?: string; errors?: Array<{ code?: string }> }).code ?? (err as { errors?: Array<{ code?: string }> }).errors?.[0]?.code;
    throw new Error(`the test database server at localhost:54329 is not reachable (${code ?? String(err)}); run \`npm run db:up\`, or \`npm run test:unit\` for tests without a database`);
  }
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function testDb(): Promise<{ db: Database; url: string; name: string; drop: () => Promise<void> }> {
  const name = `trawler_test_${randomUUID().replaceAll("-", "")}`;
  await onServer((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${inject("testTemplate")}`));
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
