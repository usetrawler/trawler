import { sql } from "kysely";
import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import { logError } from "../server/log.ts";
import type { ArtifactStore } from "./store.ts";

export const RETENTION_DAYS = 30;

export async function removeExpiredArtifacts(db: Database, store: ArtifactStore, options: { batch?: number } = {}): Promise<number> {
  const batch = options.batch ?? 100;
  const failed: string[] = [];
  let removed = 0;
  while (true) {
    const lastBatch = await asSystem(db, async (tx) => {
      let expired = tx
        .selectFrom("artifacts")
        .select(["id", "org_id", "run_id", "storage_key"])
        .where("created_at", "<", sql<Date>`now() - make_interval(days => ${RETENTION_DAYS})`)
        .orderBy("created_at")
        .limit(batch)
        .forUpdate()
        .skipLocked();
      if (failed.length > 0) expired = expired.where("id", "not in", failed);
      const rows = await expired.execute();
      for (const row of rows) {
        try {
          await store.remove(row.storage_key);
        } catch (err) {
          failed.push(row.id);
          await logError("an expired artifact could not be deleted", { orgId: row.org_id, runId: row.run_id, err });
          continue;
        }
        await tx.deleteFrom("artifacts").where("id", "=", row.id).execute();
        removed++;
      }
      return rows.length < batch;
    });
    if (lastBatch) return removed;
  }
}
