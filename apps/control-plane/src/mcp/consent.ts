import { AsyncLocalStorage } from "node:async_hooks";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type pg from "pg";
import { mcpResource, tokenHash } from "./config.ts";

export const consentWorkspace = new AsyncLocalStorage<{ userId: string; orgId: string }>();

export async function prepareConsent(pool: pg.Pool, secret: string, origin: string, query: string, userId: string, orgId: string) {
  if (query.length > 8192 || !(await verifyOAuthQueryParams(query, secret))) return null;
  const params = new URLSearchParams(query);
  if (params.getAll("resource").length !== 1 || params.get("resource") !== mcpResource(origin)) return null;
  const expiresAt = Number(params.get("exp"));
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) return null;
  const clientId = params.get("client_id");
  await pool.query(`
    INSERT INTO mcp_consent_contexts (flow_hash, user_id, org_id, expires_at)
    SELECT $1, $2, $3, to_timestamp($4) FROM member WHERE "userId" = $2 AND "organizationId" = $3
    ON CONFLICT (flow_hash) DO NOTHING
  `, [tokenHash(query), userId, orgId, expiresAt]);
  const { rows } = await pool.query<{ org_id: string; org_name: string; client_name: string }>(`
    SELECT f.org_id, o.name AS org_name, COALESCE(c.name, c."clientId") AS client_name
    FROM mcp_consent_contexts f JOIN organization o ON o.id = f.org_id
    JOIN member m ON m."userId" = f.user_id AND m."organizationId" = f.org_id
    JOIN "oauthClient" c ON c."clientId" = $3
    WHERE f.flow_hash = $1 AND f.user_id = $2 AND f.expires_at > now() AND COALESCE(c.disabled, false) = false
  `, [tokenHash(query), userId, clientId]);
  const row = rows[0];
  return row ? { ...row, scopes: (params.get("scope") ?? "").split(" "), clientId } : null;
}
