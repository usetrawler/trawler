import { getAuth } from "../../../server/auth.ts";
import { artifactStore } from "../../../server/artifacts.ts";
import { getDb } from "../../../server/db.ts";
import { mcpAuthentication } from "../../../mcp/http.ts";
import { createMcpEndpoint } from "../../../mcp/server.ts";
import { runApiDeps } from "../../../run-api/deps.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let endpoint: ReturnType<typeof createMcpEndpoint> | undefined;

export async function POST(request: Request): Promise<Response> {
  const config = getAuth().mcp;
  if (!config) return new Response(null, { status: 404 });
  const principal = await mcpAuthentication(config.pool, config.origin, request);
  if (principal instanceof Response) return principal;
  endpoint ??= createMcpEndpoint({ db: getDb(), pool: config.pool, store: artifactStore(), origin: config.origin, runApi: runApiDeps });
  return endpoint.fetch(request, { authInfo: {
    token: "", clientId: principal.clientId, scopes: principal.scopes, expiresAt: principal.expiresAt,
    extra: { grantId: principal.grantId, workspaceId: principal.orgId, projectId: principal.projectId, userId: principal.userId, role: principal.role },
  } });
}
export const GET = POST;
export const DELETE = POST;
