import type pg from "pg";
import { clientHostOf } from "./consent.ts";

export interface Identity {
  workspace: string;
  person: string;
  client: string;
  clientHost: string | null;
}

export async function identityOf(pool: pg.Pool, who: { orgId: string; userId: string; clientId: string }): Promise<Identity | null> {
  const { rows } = await pool.query<{ workspace: string; person: string; client: string | null }>(`
    SELECT o.name AS workspace, u.name AS person, c.name AS client
    FROM organization o JOIN "user" u ON u.id = $2 LEFT JOIN "oauthClient" c ON c."clientId" = $3
    WHERE o.id = $1
  `, [who.orgId, who.userId, who.clientId]);
  const row = rows[0];
  return row ? { workspace: row.workspace, person: row.person, client: row.client?.trim() || who.clientId, clientHost: clientHostOf(who.clientId) } : null;
}
