import { createHash } from "node:crypto";
import { sql } from "kysely";
import { IDEMPOTENCY_WINDOW_HOURS } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";

export interface StoredStart {
  requestHash: string;
  projectId: string;
  response: unknown;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const keyHashOf = (key: string): string => sha256(`key:${key}`);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

export const requestHashOf = (request: unknown): string => sha256(JSON.stringify(canonical(request)));

export async function storedStart(tx: Tx, orgId: string, projectId: string, keyHash: string): Promise<StoredStart | null> {
  const row = await tx.selectFrom("run_idempotency").select(["request_hash", "project_id", "response"]).where("org_id", "=", orgId).where("project_id", "=", projectId).where("key_hash", "=", keyHash).where("expires_at", ">", sql<Date>`now()`).where("response", "is not", null).executeTakeFirst();
  return row ? { requestHash: row.request_hash, projectId: row.project_id, response: row.response } : null;
}

export async function claimStart(tx: Tx, orgId: string, keyHash: string, requestHash: string, projectId: string): Promise<StoredStart | null> {
  const expires = sql<Date>`now() + ${sql.lit(`${IDEMPOTENCY_WINDOW_HOURS} hours`)}::interval`;
  const claimed = await tx.insertInto("run_idempotency")
    .values({ org_id: orgId, key_hash: keyHash, request_hash: requestHash, project_id: projectId, expires_at: expires })
    .onConflict((oc) => oc.columns(["org_id", "project_id", "key_hash"]).doUpdateSet({ request_hash: requestHash, project_id: projectId, run_id: null, response: null, created_at: sql<Date>`now()`, expires_at: expires }).where("run_idempotency.expires_at", "<=", sql<Date>`now()`))
    .returning("key_hash").executeTakeFirst();
  if (claimed) return null;
  const existing = await storedStart(tx, orgId, projectId, keyHash);
  if (!existing) throw new Error("an idempotency key exists without a stored answer");
  return existing;
}

export async function recordStart(tx: Tx, orgId: string, projectId: string, keyHash: string, runId: string, response: unknown): Promise<void> {
  const recorded = await tx.updateTable("run_idempotency").set({ run_id: runId, response: JSON.stringify(response) }).where("org_id", "=", orgId).where("project_id", "=", projectId).where("key_hash", "=", keyHash).executeTakeFirst();
  if (recorded.numUpdatedRows !== 1n) throw new Error("the idempotency key claimed by this start is gone");
}
