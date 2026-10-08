import { AsyncLocalStorage } from "node:async_hooks";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type pg from "pg";
import { mcpResource, tokenHash } from "./config.ts";
import { mcpSettingsOf } from "./settings.ts";

export function clientHostOf(clientId: string | null): string | null {
  if (!clientId) return null;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.host : null;
  } catch { return null; }
}

export function redirectTargetOf(uri: string | null): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.origin !== "null" ? url.origin : `${url.protocol}//${url.host}`;
  } catch { return null; }
}

export function flowKey(query: string): string {
  const pairs = [...new URLSearchParams(query)].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).sort();
  return tokenHash(pairs.join("&"));
}

export const consentWorkspace = new AsyncLocalStorage<{ userId: string; orgId: string }>();

export async function prepareConsent(pool: pg.Pool, secret: string, origin: string, query: string, userId: string, orgId: string) {
  if (query.length > 8192 || !(await verifyOAuthQueryParams(query, secret))) return null;
  const params = new URLSearchParams(query);
  if (params.getAll("resource").length !== 1 || params.get("resource") !== mcpResource(origin)) return null;
  const expiresAt = Number(params.get("exp"));
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) return null;
  const clientId = params.get("client_id");
  await pool.query("DELETE FROM mcp_consent_contexts WHERE expires_at < now() - interval '1 hour'");
  await pool.query(`
    INSERT INTO mcp_consent_contexts (flow_hash, user_id, org_id, expires_at)
    SELECT $1, $2, $3, to_timestamp($4) FROM member WHERE "userId" = $2 AND "organizationId" = $3
    ON CONFLICT (flow_hash) DO NOTHING
  `, [flowKey(query), userId, orgId, expiresAt]);
  const { rows } = await pool.query<{ org_id: string; org_name: string; client_name: string }>(`
    SELECT f.org_id, o.name AS org_name, COALESCE(c.name, c."clientId") AS client_name
    FROM mcp_consent_contexts f JOIN organization o ON o.id = f.org_id
    JOIN member m ON m."userId" = f.user_id AND m."organizationId" = f.org_id
    JOIN "oauthClient" c ON c."clientId" = $3
    WHERE f.flow_hash = $1 AND f.user_id = $2 AND f.expires_at > now() AND COALESCE(c.disabled, false) = false
  `, [flowKey(query), userId, clientId]);
  const row = rows[0];
  return row ? { ...row, scopes: (params.get("scope") ?? "").split(" "), clientId, clientHost: clientHostOf(clientId), redirectTarget: redirectTargetOf(params.get("redirect_uri")), settings: await mcpSettingsOf(pool, row.org_id) } : null;
}
