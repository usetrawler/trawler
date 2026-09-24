import { sql, type Transaction } from "kysely";
import type { Database } from "./index.ts";
import type { DB } from "./types.ts";

export type Tx = Transaction<DB>;

export async function withOrg<T>(db: Database, orgId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!orgId.trim()) throw new Error("an organisation is required for tenant data");
  return db.transaction().execute(async (tx) => {
    await sql`set local role trawler_app`.execute(tx);
    await sql`select set_config('app.org_id', ${orgId}, true)`.execute(tx);
    return work(tx);
  });
}

export async function asSystem<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`set local role trawler_bypass`.execute(tx);
    return work(tx);
  });
}
