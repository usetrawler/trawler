import { getAuth } from "../../../server/auth.ts";
import { mcpAuthentication } from "../../../mcp/http.ts";
import { mcpHandler } from "../../../mcp/server.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  const config = getAuth().mcp;
  if (!config) return new Response(null, { status: 404 });
  const principal = await mcpAuthentication(config.pool, config.origin, request);
  if (principal instanceof Response) return principal;
  return mcpHandler.fetch(request, { authInfo: {
    token: "", clientId: principal.clientId, scopes: principal.scopes, expiresAt: principal.expiresAt,
    extra: { grantId: principal.grantId, workspaceId: principal.orgId, projectId: principal.projectId, userId: principal.userId },
  } });
}
export const GET = POST;
export const DELETE = POST;
