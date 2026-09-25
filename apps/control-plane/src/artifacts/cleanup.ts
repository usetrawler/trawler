import { sql } from "kysely";
import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import { logError } from "../server/log.ts";
import type { ArtifactStore } from "./store.ts";

export const RETENTION_DAYS = 30;
export const DISCARD_GRACE_MINUTES = 10;
export const MAX_FAILURES_PER_RUN = 10;

export async function removeExpiredArtifacts(db: Database, store: ArtifactStore, options: { batch?: number } = {}): Promise<number> {
  const batch = options.batch ?? 100;
  const failed: string[] = [];
  let firstFailure: unknown;
  let removed = 0;
  while (failed.length < MAX_FAILURES_PER_RUN) {
    const rows = await asSystem(db, (tx) => {
      let expired = tx
        .selectFrom("artifacts")
        .select(["id", "storage_key"])
        .where((eb) => eb.or([
          eb("created_at", "<", sql<Date>`now() - make_interval(days => ${RETENTION_DAYS})`),
          eb("discarded_at", "<", sql<Date>`now() - make_interval(mins => ${DISCARD_GRACE_MINUTES})`),
        ]))
        .orderBy("created_at")
        .limit(batch);
      if (failed.length > 0) expired = expired.where("id", "not in", failed);
      return expired.execute();
    });
    for (const row of rows) {
      try {
        await store.remove(row.storage_key);
      } catch (err) {
        failed.push(row.id);
        firstFailure ??= err;
        if (failed.length >= MAX_FAILURES_PER_RUN) break;
        continue;
      }
      const deleted = await asSystem(db, (tx) => tx.deleteFrom("artifacts").where("id", "=", row.id).executeTakeFirst());
      removed += Number(deleted.numDeletedRows);
    }
    if (rows.length < batch) break;
  }
  if (failed.length > 0) await logError("expired artifacts could not be deleted", { failed: failed.length, err: firstFailure });
  return removed;
}
