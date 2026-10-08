import type pg from "pg";
import { canControlRuns } from "./access.ts";
import { clientHostOf } from "./consent.ts";

export interface Connection {
  id: string;
  clientName: string;
  clientHost: string | null;
  projectId: string | null;
  runControl: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function connectionsOf(pool: pg.Pool, userId: string, orgId: string, role: string): Promise<Connection[]> {
  const { rows } = await pool.query<{ id: string; client_id: string; client_name: string | null; project_id: string | null; scopes: string[]; created_at: Date; last_used_at: Date | null }>(`
    SELECT g.id, g.client_id, c.name AS client_name, g.project_id, g.scopes, g.created_at, g.last_used_at
    FROM mcp_grants g JOIN "oauthClient" c ON c."clientId" = g.client_id
    WHERE g.user_id = $1 AND g.org_id = $2 AND g.revoked_at IS NULL
    ORDER BY g.created_at DESC, g.id
  `, [userId, orgId]);
  return rows.map((row) => ({
    id: row.id, clientName: row.client_name?.trim() || row.client_id, clientHost: clientHostOf(row.client_id), projectId: row.project_id,
    runControl: row.scopes.includes("trawler:runs:write") && canControlRuns(role), createdAt: row.created_at, lastUsedAt: row.last_used_at,
  }));
}
