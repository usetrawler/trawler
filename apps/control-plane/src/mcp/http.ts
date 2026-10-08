import type pg from "pg";
import { consentWorkspace } from "./consent.ts";
import { mcpResource, tokenHash } from "./config.ts";
import { authenticateMcp, persistGrant } from "./oauth.ts";

const MAX_BODY = 64 * 1024;

export function oauthError(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function boundedBody(request: Request): Promise<string | Response> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) return oauthError("request_too_large", 413);
  if (!request.body) return "";
  const reader = request.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel();
        return oauthError("request_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function withinMcpRate(pool: pg.Pool, key: string, max: number): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const result = await pool.query(`
    INSERT INTO mcp_rate_limits (key, minute, calls) VALUES ($1, $2, 1)
    ON CONFLICT (key, minute) DO UPDATE SET calls = mcp_rate_limits.calls + 1
      WHERE mcp_rate_limits.calls < $3
    RETURNING calls
  `, [tokenHash(key), minute, max]);
  if (minute % 10 === 0) await pool.query("DELETE FROM mcp_rate_limits WHERE minute < $1", [minute - 60]);
  return !!result.rowCount;
}

interface SessionLookup {
  (headers: Headers): Promise<{ user: { id: string } } | null>;
}

export function oauthBoundary(handler: (r: Request) => Promise<Response>, pool: pg.Pool, origin: string, session: SessionLookup) {
  const resource = mcpResource(origin);
  return async (incoming: Request): Promise<Response> => {
    const path = new URL(incoming.url).pathname;
    if (!path.includes("/oauth2/") && !path.includes("/.well-known/")) return handler(incoming);
    try {
      if (path.includes("/.well-known/")) return await handler(incoming);
      // Framework/admin client and consent mutations are not public MCP operations.
      const endpoint = path.slice(path.lastIndexOf("/oauth2/") + 8);
      if (!["authorize", "token", "revoke", "consent", "continue", "register", "introspect"].includes(endpoint)) return oauthError("access_denied", 403);
      const address = incoming.headers.get("x-real-ip")?.slice(0, 128) ?? "unknown";
      if (!(await withinMcpRate(pool, `oauth:${endpoint}:${address}`, endpoint === "token" ? 120 : 30))) {
        const limited = oauthError("rate_limit_exceeded", 429);
        limited.headers.set("Retry-After", "60");
        return limited;
      }
      let request = incoming;
      let body: Record<string, unknown> = {};
      if (incoming.method === "POST") {
        const raw = await boundedBody(incoming);
        if (raw instanceof Response) return raw;
        try {
          body = incoming.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        } catch { return oauthError("invalid_request"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return oauthError("invalid_request");
        request = new Request(incoming.url, { method: incoming.method, headers: incoming.headers, body: raw });
      }
      if (endpoint === "authorize") {
        const query = new URL(request.url).searchParams;
        if (query.getAll("resource").length !== 1 || query.get("resource") !== resource) return oauthError("invalid_target");
        if (query.get("code_challenge_method") !== "S256" || !/^[\w-]{43}$/.test(query.get("code_challenge") ?? "") ||
            !query.get("state") || query.get("state")!.length > 512) return oauthError("invalid_request");
      }
      if (endpoint === "token" && body.grant_type === "refresh_token") {
        if (typeof body.refresh_token !== "string") return oauthError("invalid_grant");
        const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.get("authorization") ?? "");
        let clientId = body.client_id;
        if (basic) {
          const encodedId = Buffer.from(basic[1]!, "base64").toString("utf8").split(":", 1)[0]!;
          try { clientId = decodeURIComponent(encodedId.replace(/\+/g, " ")); } catch { return oauthError("invalid_client", 401); }
        }
        const { rows } = await pool.query<{ code_hash: string; revoked: Date | null; revoked_at: Date | null }>(`
          SELECT g.code_hash, r.revoked, g.revoked_at FROM "oauthRefreshToken" r
          JOIN mcp_grants g ON g.code_hash = r."authorizationCodeId"
          JOIN member m ON m."userId" = g.user_id AND m."organizationId" = g.org_id
          WHERE r.token = $1 AND r."clientId" = $2 AND g.resource = $3
        `, [tokenHash(body.refresh_token), clientId, resource]);
        const found = rows[0];
        if (!found || found.revoked_at) return oauthError("invalid_grant");
      }
      if (endpoint === "token" && body.grant_type === "authorization_code") {
        if (typeof body.code !== "string") return oauthError("invalid_grant");
        const claimed = await pool.query(`
          INSERT INTO mcp_code_claims (code_hash, expires_at)
          SELECT $1, "expiresAt" FROM verification WHERE identifier = $1 AND "expiresAt" > now()
          ON CONFLICT (code_hash) DO NOTHING RETURNING code_hash
        `, [tokenHash(body.code)]);
        if (!claimed.rowCount) return oauthError("invalid_grant");
        await pool.query("DELETE FROM mcp_code_claims WHERE expires_at < now() - interval '1 hour'");
      }
      const invoke = async () => {
        const response = await handler(request);
        if (response.status >= 500) return oauthError("temporarily_unavailable", 503);
        if (endpoint === "token" && response.ok) {
          const tokens = await response.clone().json() as { access_token?: string };
          if (!tokens.access_token) return oauthError("temporarily_unavailable", 503);
          await persistGrant(pool, tokens.access_token, resource);
        }
        return response;
      };
      if (endpoint === "consent" && body.accept === true) {
        const person = await session(request.headers);
        if (!person || typeof body.oauth_query !== "string") return oauthError("access_denied", 403);
        const { rows } = await pool.query<{ org_id: string }>(`
          SELECT f.org_id FROM mcp_consent_contexts f JOIN member m ON m."userId" = f.user_id AND m."organizationId" = f.org_id
          WHERE flow_hash = $1 AND user_id = $2 AND expires_at > now()
        `, [tokenHash(body.oauth_query), person.user.id]);
        if (!rows[0]) return oauthError("access_denied", 403);
        return await consentWorkspace.run({ userId: person.user.id, orgId: rows[0].org_id }, invoke);
      }
      return await invoke();
    } catch {
      // Provider/driver errors can contain request values. Never log their messages or bodies.
      return oauthError("temporarily_unavailable", 503);
    }
  };
}

export async function mcpAuthentication(pool: pg.Pool, origin: string, request: Request) {
  const resource = mcpResource(origin);
  const authorization = request.headers.get("authorization");
  const token = /^Bearer ([A-Za-z0-9_-]{20,512})$/i.exec(authorization ?? "")?.[1];
  const reject = () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Authentication required" } }, {
    status: 401,
    headers: { "Cache-Control": "no-store", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="trawler:read"` },
  });
  if (!token) return reject();
  try {
    const principal = await authenticateMcp(pool, token, resource);
    if (!principal) return reject();
    if (!(await withinMcpRate(pool, `grant:${principal.grantId}`, 120))) return oauthError("rate_limit_exceeded", 429);
    return principal;
  } catch { return oauthError("temporarily_unavailable", 503); }
}
