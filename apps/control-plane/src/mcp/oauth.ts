import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getOAuthProviderApi, type ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import type pg from "pg";
import { MCP_SCOPES, mcpResource, tokenHash } from "./config.ts";
import { consentWorkspace } from "./consent.ts";

export function oauthPlugins(pool: pg.Pool, origin: string, dcr: boolean, fetchMetadata: ClientMetadataResourceFetch = fetchClientMetadataResource) {
  const resource = mcpResource(origin);
  const provider = mcp({
      resource,
      loginPage: "/sign-in",
      consentPage: "/mcp/consent",
      scopes: MCP_SCOPES,
      grantTypes: ["authorization_code", "refresh_token"],
      disableJwtPlugin: true,
      storeTokens: "hashed",
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      codeExpiresIn: 300,
      refreshTokenReuseInterval: 0,
      allowDynamicClientRegistration: dcr,
      allowUnauthenticatedClientRegistration: dcr,
      clientPrivileges: () => false,
      postLogin: {
        page: "/welcome",
        shouldRedirect: () => false,
        consentReferenceId: async ({ user, session }) => {
          const chosen = consentWorkspace.getStore();
          if (chosen && chosen.userId !== user.id) throw new APIError("FORBIDDEN", { error: "access_denied" });
          const orgId = chosen?.orgId ?? session.activeOrganizationId;
          const found = await pool.query('SELECT 1 FROM member WHERE "userId" = $1 AND "organizationId" = $2', [user.id, orgId]);
          if (!orgId || !found.rowCount) throw new APIError("FORBIDDEN", { error: "access_denied" });
          return String(orgId);
        },
      },
      customTokenResponseFields: async ({ grantType, user, verificationValue, scopes }) => {
        if (grantType !== "authorization_code") return {};
        const orgId = verificationValue?.referenceId;
        const query = verificationValue?.query;
        if (!user || !orgId || !query?.client_id || !scopes.includes("trawler:read")) {
          throw new APIError("FORBIDDEN", { error: "access_denied" });
        }
        // The provider has already consumed and verified this authorization code.
        // Its original resource and workspace, rather than the current browser session, bind the grant.
        const originalResource = verificationValue.resource;
        if (!originalResource || originalResource.length !== 1 || originalResource[0] !== resource) {
          throw new APIError("BAD_REQUEST", { error: "invalid_target" });
        }
        const found = await pool.query('SELECT 1 FROM member WHERE "userId" = $1 AND "organizationId" = $2', [user.id, orgId]);
        if (!found.rowCount) throw new APIError("FORBIDDEN", { error: "access_denied" });
        // The opaque token rows retain the same authorizationCodeId throughout refresh rotation.
        // Filled by the HTTP boundary after the provider returns a successful token response.
        return {};
      },
    });
  return [
    provider,
    {
      id: "mcp-refresh-replay",
      hooks: { before: [{
        matcher: (ctx: { path?: string; body?: Record<string, unknown> }) => ctx.path === "/oauth2/token" && ctx.body?.grant_type === "refresh_token",
        handler: createAuthMiddleware(async (ctx) => {
          if (typeof ctx.body?.refresh_token !== "string") return;
          const { rows } = await pool.query<{ client_id: string; code_hash: string }>(`
            SELECT r."clientId" AS client_id, g.code_hash FROM "oauthRefreshToken" r
            JOIN mcp_grants g ON g.code_hash = r."authorizationCodeId"
            WHERE r.token = $1 AND r.revoked IS NOT NULL AND g.resource = $2
          `, [tokenHash(ctx.body.refresh_token), resource]);
          if (!rows[0]) return;
          // Use the original token endpoint context: assertions bind to its
          // audience, and public clients legitimately have no secret.
          const client = await getOAuthProviderApi(ctx, provider.options, "refresh_token").authenticateClient({ requireCredentials: false });
          if (client.clientId === rows[0].client_id) {
            await pool.query("UPDATE mcp_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE code_hash = $1", [rows[0].code_hash]);
          }
          throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
        }),
      }] },
    },
    cimd({
      fetchClientMetadataResource: fetchMetadata,
      metadataProfile: "mcp-2026-07-28",
      metadataFetchPolicy: { maximumConcurrentFetches: 8, maximumConcurrentFetchesPerOrigin: 2, maximumFetchesPerMinute: 60, maximumFetchesPerOriginPerMinute: 10 },
      maxCacheEntries: 500,
    }),
  ];
}

export interface McpPrincipal {
  grantId: string;
  userId: string;
  orgId: string;
  projectId: string | null;
  clientId: string;
  scopes: string[];
  role: string;
  expiresAt: number;
}

export async function authenticateMcp(pool: pg.Pool, rawToken: string, resource: string): Promise<McpPrincipal | null> {
  const { rows } = await pool.query<{
    id: string; user_id: string; org_id: string; project_id: string | null; client_id: string; scopes: string[]; role: string; expires_at: Date;
  }>(`
    SELECT g.id, g.user_id, g.org_id, g.project_id, g.client_id,
           ARRAY(
             SELECT scope FROM (SELECT jsonb_array_elements_text(a.scopes) AS scope INTERSECT SELECT unnest(g.scopes)) held
             WHERE scope <> 'trawler:runs:write' OR COALESCE(w.run_control_allowed, false)
           ) AS scopes,
           m.role, a."expiresAt" AS expires_at
    FROM "oauthAccessToken" a
    JOIN mcp_grants g ON g.code_hash = a."authorizationCodeId"
    JOIN "oauthClient" c ON c."clientId" = a."clientId"
    JOIN member m ON m."userId" = g.user_id AND m."organizationId" = g.org_id
    LEFT JOIN workspace_mcp_settings w ON w.org_id = g.org_id
    WHERE a.token = $1 AND a.revoked IS NULL AND a.confirmation IS NULL AND a."expiresAt" > now()
      AND g.revoked_at IS NULL AND g.resource = $2 AND a.resources = jsonb_build_array($2::text)
      AND a."userId" = g.user_id AND a."clientId" = g.client_id AND a."referenceId" = g.org_id
      AND COALESCE(c.disabled, false) = false AND COALESCE(w.connections_allowed, true)
  `, [tokenHash(rawToken), resource]);
  const row = rows[0];
  if (!row || !row.scopes.includes("trawler:read")) return null;
  return { grantId: row.id, userId: row.user_id, orgId: row.org_id, projectId: row.project_id, clientId: row.client_id, scopes: row.scopes, role: row.role, expiresAt: Math.floor(row.expires_at.getTime() / 1000) };
}

export class GrantRefused extends Error {}

export async function persistGrant(pool: pg.Pool, accessToken: string, resource: string): Promise<void> {
  const token = await pool.query<{ org: string }>('SELECT "referenceId" AS org FROM "oauthAccessToken" WHERE token = $1', [tokenHash(accessToken)]);
  const org = token.rows[0]?.org;
  if (!org) throw new Error("grant persistence failed");
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mcp-settings:${org}`]);
    const settings = await client.query<{ connections_allowed: boolean; run_control_allowed: boolean }>("SELECT connections_allowed, run_control_allowed FROM workspace_mcp_settings WHERE org_id = $1", [org]);
    if (!(settings.rows[0]?.connections_allowed ?? true)) throw new GrantRefused();
    const runControlAllowed = settings.rows[0]?.run_control_allowed ?? false;
    const result = await client.query(`
      INSERT INTO mcp_grants (id, code_hash, user_id, org_id, client_id, resource, scopes)
      SELECT $1, a."authorizationCodeId", a."userId", a."referenceId", a."clientId", $2,
             ARRAY(SELECT scope FROM jsonb_array_elements_text(a.scopes) AS scope WHERE scope <> 'trawler:runs:write' OR $4::boolean)
      FROM "oauthAccessToken" a
      JOIN member m ON m."userId" = a."userId" AND m."organizationId" = a."referenceId"
      WHERE a.token = $3 AND a.resources = jsonb_build_array($2::text)
      ON CONFLICT (code_hash) DO NOTHING
    `, [crypto.randomUUID(), resource, tokenHash(accessToken), runControlAllowed]);
    if (!result.rowCount) {
      const existing = await client.query("SELECT 1 FROM mcp_grants g JOIN \"oauthAccessToken\" a ON a.\"authorizationCodeId\" = g.code_hash WHERE a.token = $1", [tokenHash(accessToken)]);
      if (!existing.rowCount) throw new Error("grant persistence failed");
    }
    await client.query("COMMIT");
  } catch (error) {
    if (!(error instanceof GrantRefused)) failure = error instanceof Error ? error : new Error(String(error));
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release(failure);
  }
}

export async function revokeGrant(pool: pg.Pool, grantId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`
    WITH revoked AS (
      UPDATE mcp_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING client_id, user_id, org_id
    ), forgotten AS (
      DELETE FROM "oauthConsent" o USING revoked WHERE o."clientId" = revoked.client_id AND o."userId" = revoked.user_id AND o."referenceId" = revoked.org_id
    )
    SELECT 1 FROM revoked
  `, [grantId, userId]);
  return !!rowCount;
}

