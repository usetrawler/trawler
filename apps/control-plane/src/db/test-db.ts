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

export function onServer<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  return connected(TEST_SERVER_URL, work);
}

export function onDatabase<T>(name: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  return connected(databaseUrl(name), work);
}

async function connected<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
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

// pg-pool resolves end() before its idle clients have closed; dropping under them makes the pool emit an unhandled error.
async function untilDisconnected(c: pg.Client, name: string, timeoutMs = 5000): Promise<number> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'", [name]);
    if (rows[0]!.n === 0 || Date.now() >= until) return rows[0]!.n;
    await new Promise((resolve) => setTimeout(resolve, 20));
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
      const open = await onServer(async (c) => {
        const left = await untilDisconnected(c, name);
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        return left;
      });
      if (open) throw new Error(`test database ${name} still had ${open} open connection(s) 5 s after its pool closed; a test left a pool or client open`);
    },
  };
}
