import { sql } from "kysely";
import type pg from "pg";
import type { Tx } from "../db/tenancy.ts";

export interface McpSettings {
  connectionsAllowed: boolean;
  runControlAllowed: boolean;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = { connectionsAllowed: true, runControlAllowed: false };

export const CONNECTIONS_OFF = "MCP connections are switched off for this workspace. Ask an owner or admin to switch them on in Settings.";
export const RUN_CONTROL_OFF = "Run control is switched off for this workspace, so a connection can read but not start or stop runs.";

export async function mcpSettings(tx: Tx, orgId: string): Promise<McpSettings> {
  const row = await tx.selectFrom("workspace_mcp_settings").select(["connections_allowed", "run_control_allowed"]).where("org_id", "=", orgId).executeTakeFirst();
  return row ? { connectionsAllowed: row.connections_allowed, runControlAllowed: row.run_control_allowed } : DEFAULT_MCP_SETTINGS;
}

export async function mcpSettingsOf(pool: pg.Pool, orgId: string): Promise<McpSettings> {
  const { rows } = await pool.query<{ connections_allowed: boolean; run_control_allowed: boolean }>(
    "SELECT connections_allowed, run_control_allowed FROM workspace_mcp_settings WHERE org_id = $1", [orgId]);
  return rows[0] ? { connectionsAllowed: rows[0].connections_allowed, runControlAllowed: rows[0].run_control_allowed } : DEFAULT_MCP_SETTINGS;
}

export async function setMcpSettings(tx: Tx, orgId: string, next: McpSettings, by: string): Promise<{ revokedGrants: number; strippedGrants: number }> {
  await tx.insertInto("workspace_mcp_settings")
    .values({ org_id: orgId, connections_allowed: next.connectionsAllowed, run_control_allowed: next.runControlAllowed, updated_by: by })
    .onConflict((oc) => oc.column("org_id").doUpdateSet({ connections_allowed: next.connectionsAllowed, run_control_allowed: next.runControlAllowed, updated_by: by, updated_at: new Date() }))
    .execute();
  let revokedGrants = 0;
  let strippedGrants = 0;
  if (!next.connectionsAllowed) {
    revokedGrants = Number((await tx.updateTable("mcp_grants").set({ revoked_at: new Date() }).where("org_id", "=", orgId).where("revoked_at", "is", null).executeTakeFirst()).numUpdatedRows);
  }
  if (!next.runControlAllowed) {
    strippedGrants = Number((await tx.updateTable("mcp_grants")
      .set({ scopes: sql`array_remove(scopes, 'trawler:runs:write')` })
      .where("org_id", "=", orgId).where("revoked_at", "is", null).where(sql<boolean>`'trawler:runs:write' = ANY(scopes)`).executeTakeFirst()).numUpdatedRows);
  }
  return { revokedGrants, strippedGrants };
}
