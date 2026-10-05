import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/index.ts";
import { asSystem, withOrg, type Tx } from "../db/tenancy.ts";

export const TOKEN_PREFIX = "trw_";
export const MAX_API_TOKENS = 20;
export const TOKEN_SHAPE = /^trw_[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY_MS = 60_000;

export const TokenNameSchema = z.string().trim().min(1).max(100);

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export class TokenLimit extends Error {
  constructor() {
    super(`a workspace can hold at most ${MAX_API_TOKENS} API tokens`);
  }
}

export class TokenProjectNotFound extends Error {
  constructor() {
    super("that project is not in this workspace");
  }
}

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function createApiToken(tx: Tx, orgId: string, userId: string, input: { name: string; projectId?: string }): Promise<{ id: string; token: string; prefix: string }> {
  const name = TokenNameSchema.parse(input.name);
  const live = await tx.selectFrom("api_tokens").select("id").where("org_id", "=", orgId).where("revoked_at", "is", null).execute();
  if (live.length >= MAX_API_TOKENS) throw new TokenLimit();
  if (input.projectId !== undefined) {
    const project = await tx.selectFrom("projects").select("id").where("id", "=", input.projectId).where("org_id", "=", orgId).executeTakeFirst();
    if (!project) throw new TokenProjectNotFound();
  }
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const prefix = token.slice(0, 8);
  const { id } = await tx
    .insertInto("api_tokens")
    .values({ org_id: orgId, project_id: input.projectId ?? null, name, token_hash: hashOf(token), prefix, created_by: userId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id, token, prefix };
}

export async function listApiTokens(tx: Tx, orgId: string): Promise<ApiTokenRow[]> {
  const rows = await tx
    .selectFrom("api_tokens as t")
    .leftJoin("projects as p", (join) => join.onRef("p.id", "=", "t.project_id").onRef("p.org_id", "=", "t.org_id"))
    .select(["t.id", "t.name", "t.prefix", "t.project_id", "p.name as project_name", "t.created_at", "t.last_used_at"])
    .where("t.org_id", "=", orgId)
    .where("t.revoked_at", "is", null)
    .orderBy("t.created_at", "desc")
    .orderBy("t.id")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, projectId: r.project_id, projectName: r.project_name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function revokeApiToken(tx: Tx, orgId: string, tokenId: string): Promise<boolean> {
  const done = await tx.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", tokenId).where("org_id", "=", orgId).where("revoked_at", "is", null).executeTakeFirst();
  return done.numUpdatedRows > 0n;
}

export interface TokenHolder {
  tokenId: string;
  orgId: string;
  projectId: string | null;
}

export async function authenticateToken(db: Database, token: string, now = new Date()): Promise<TokenHolder | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  return asSystem(db, async (tx) => {
    const row = await tx.selectFrom("api_tokens").select(["id", "org_id", "project_id", "last_used_at"]).where("token_hash", "=", hashOf(token)).where("revoked_at", "is", null).executeTakeFirst();
    if (!row) return null;
    if (row.last_used_at === null || now.getTime() - row.last_used_at.getTime() >= TOUCH_EVERY_MS) {
      await tx.updateTable("api_tokens").set({ last_used_at: now }).where("id", "=", row.id).execute();
    }
    return { tokenId: row.id, orgId: row.org_id, projectId: row.project_id };
  });
}

const CALLS_PER_WINDOW = 120;
const WINDOW_MS = 60_000;
const KEEP_BUCKETS = 10;

export async function withinTokenRate(db: Database, holder: Pick<TokenHolder, "tokenId" | "orgId">, now = Date.now()): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const minute = Math.floor(now / WINDOW_MS);
  return withOrg(db, holder.orgId, async (tx) => {
    const counted = await tx
      .insertInto("api_token_calls")
      .values({ token_id: holder.tokenId, org_id: holder.orgId, minute: String(minute), calls: 1 })
      .onConflict((oc) => oc.columns(["token_id", "minute"]).doUpdateSet((eb) => ({ calls: eb("api_token_calls.calls", "+", 1) })).where("api_token_calls.calls", "<", CALLS_PER_WINDOW))
      .returning("calls")
      .executeTakeFirst();
    if (!counted) return { ok: false as const, retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * WINDOW_MS - now) / 1000)) };
    if (counted.calls === 1) await tx.deleteFrom("api_token_calls").where("token_id", "=", holder.tokenId).where("minute", "<", String(minute - KEEP_BUCKETS)).execute();
    return { ok: true as const };
  });
}
