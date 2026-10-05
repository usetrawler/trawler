import type { Database } from "../db/index.ts";
import { authenticateToken, withinTokenRate, type TokenHolder } from "../api-tokens/tokens.ts";
import { getDb } from "./db.ts";

const BEARER = /^Bearer (\S+)$/;
const NO_STORE = { "cache-control": "no-store" };

const refuse = (status: number, error: string, headers: Record<string, string> = {}) => Response.json({ error }, { status, headers: { ...NO_STORE, ...headers } });

export async function tokenWorkspace(headers: Headers, db: Database = getDb()): Promise<{ ok: true; holder: TokenHolder } | { ok: false; response: Response }> {
  const given = BEARER.exec(headers.get("authorization") ?? "")?.[1];
  if (!given) return { ok: false, response: refuse(401, "Send the API token as 'Authorization: Bearer <token>'.", { "www-authenticate": "Bearer" }) };
  const holder = await authenticateToken(db, given);
  if (!holder) return { ok: false, response: refuse(401, "That API token is not valid or was revoked.", { "www-authenticate": "Bearer" }) };
  const rate = await withinTokenRate(db, holder);
  if (!rate.ok) return { ok: false, response: refuse(429, "Too many calls with this token. Slow down.", { "retry-after": String(rate.retryAfterSeconds) }) };
  return { ok: true, holder };
}
