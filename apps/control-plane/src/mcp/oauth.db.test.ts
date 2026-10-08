import { createHmac, randomUUID } from "node:crypto";
import { afterAll, expect, test, vi } from "vitest";
import { authPool, createAuth } from "../auth/auth.ts";
import { testDb } from "../db/test-db.ts";
import { prepareConsent } from "./consent.ts";
import { mcpAuthentication } from "./http.ts";
import { authenticateMcp, revokeGrant } from "./oauth.ts";
import { tokenHash } from "./config.ts";

const t = await testDb();
const pool = authPool(t.url, 6);
const secret = "integration-test-secret-with-enough-entropy";
const origin = "http://localhost:3000";
const resource = `${origin}/api/mcp`;
const auth = createAuth({ pool, secret, baseURL: origin, mcp: { dcr: true } });
afterAll(async () => { await pool.end(); await t.drop(); });

async function fixture() {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: `${randomUUID()}@example.test`, emailVerified: true, name: "Alex" }, { method: "admin" });
  const session = await ctx.internalAdapter.createSession(user.id, false) as unknown as { id: string; token: string; activeOrganizationId: string };
  const headers = new Headers({
    "Content-Type": "application/json", Origin: origin, "x-real-ip": randomUUID(),
    Cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${createHmac("sha256", secret).update(session.token).digest("base64")}`)}`,
  });
  const call = (path: string, body?: unknown, withSession = true) => {
    const h = new Headers(headers);
    if (!withSession) h.delete("cookie");
    const form = ["token", "revoke", "introspect"].some(endpoint => path.endsWith(`/oauth2/${endpoint}`));
    if (form) h.set("content-type", "application/x-www-form-urlencoded");
    return auth.handler(new Request(`${origin}${path}`, body === undefined ? { headers: h } : { method: "POST", headers: h, body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body) }));
  };
  const registered = await call("/api/auth/oauth2/register", {
    client_name: "Integration client", redirect_uris: ["http://localhost:9876/callback"],
    token_endpoint_auth_method: "none", application_type: "native", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }, false);
  expect(registered.status, await registered.clone().text()).toBe(201);
  const client = await registered.json() as { client_id: string };
  const verifier = "a".repeat(64);
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://localhost:9876/callback", response_type: "code", prompt: "consent", scope: "trawler:read offline_access", resource, state: "state-for-this-flow", code_challenge_method: "S256", code_challenge: tokenHash(verifier) });
  const authorize = (q = query) => call(`/api/auth/oauth2/authorize?${q}`);
  const code = async () => {
    const response = await authorize();
    expect(response.status, await response.clone().text()).toBe(302);
    const consentUrl = new URL(response.headers.get("location")!, origin);
    expect(consentUrl.pathname).toBe("/mcp/consent");
    const oauthQuery = consentUrl.searchParams.toString();
    expect(await prepareConsent(pool, secret, origin, oauthQuery, user.id, session.activeOrganizationId)).toBeTruthy();
    const accepted = await call("/api/auth/oauth2/consent", { accept: true, oauth_query: oauthQuery });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const result = await accepted.json() as { url?: string; redirect_uri?: string };
    const redirect = new URL(result.url ?? result.redirect_uri!);
    expect(redirect.searchParams.get("state")).toBe("state-for-this-flow");
    return redirect.searchParams.get("code")!;
  };
  const redeem = (code: string, extra: Record<string, unknown> = {}) => call("/api/auth/oauth2/token", {
    grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "http://localhost:9876/callback", code, code_verifier: verifier, resource, ...extra,
  }, false);
  const issue = async () => {
    const response = await redeem(await code());
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as { access_token: string; refresh_token: string };
  };
  const refresh = (token: string, extra: Record<string, unknown> = {}) => call("/api/auth/oauth2/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token, resource, ...extra }, false);
  return { user, session, headers, client, call, query, code, authorize, redeem, issue, refresh };
}

test("discovery and challenges use the configured origin even with spoofed host headers", async () => {
  const response = await auth.handler(new Request(`${origin}/.well-known/oauth-protected-resource/api/mcp`, { headers: { host: "evil.test", "x-forwarded-host": "evil.test" } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource, authorization_servers: [`${origin}/api/auth`], scopes_supported: ["trawler:read", "trawler:runs:write"] });
  const metadata = await auth.handler(new Request(`${origin}/.well-known/oauth-authorization-server/api/auth`));
  expect(metadata.status, await metadata.clone().text()).toBe(200);
  expect(await metadata.json()).toMatchObject({ issuer: `${origin}/api/auth`, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
  const challenge = await mcpAuthentication(pool, origin, new Request(resource));
  expect(challenge).toBeInstanceOf(Response);
  expect((challenge as Response).status).toBe(401);
  expect((challenge as Response).headers.get("www-authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/api/mcp`);
});

test("a code issues a durable, fixed-workspace grant and refresh rotates exactly once", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const principal = await authenticateMcp(pool, tokens.access_token, resource);
  expect(principal).toMatchObject({ userId: f.user.id, orgId: f.session.activeOrganizationId, projectId: null, clientId: f.client.client_id });
  expect(principal!.scopes).toEqual(expect.arrayContaining(["trawler:read", "offline_access"]));
  const refreshed = await f.refresh(tokens.refresh_token);
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  const next = await refreshed.json() as { access_token: string; refresh_token: string };
  expect(next.refresh_token).not.toBe(tokens.refresh_token);
  expect((await authenticateMcp(pool, next.access_token, resource))!.grantId).toBe(principal!.grantId);
  expect((await f.refresh(tokens.refresh_token)).status).toBe(400);
  expect(await authenticateMcp(pool, next.access_token, resource)).toBeNull();
});

test("two simultaneous code claims and two refresh claims each issue only one response", async () => {
  const f = await fixture();
  const code = await f.code();
  const claims = await Promise.all([f.redeem(code), f.redeem(code)]);
  expect(claims.filter(r => r.status === 200)).toHaveLength(1);
  const g = await fixture();
  const tokens = await g.issue();
  const refreshed = await Promise.all([g.refresh(tokens.refresh_token), g.refresh(tokens.refresh_token)]);
  expect(refreshed.filter(r => r.status === 200)).toHaveLength(1);
});

test("bad redirect, resource, PKCE, expiry, reused code and revoked grants are refused", async () => {
  const f = await fixture();
  for (const [field, value] of [["redirect_uri", "https://evil.test/callback"], ["resource", "https://stage.usetrawler.com/api/mcp"], ["code_verifier", "wrong"]]) {
    expect([400, 401]).toContain((await f.redeem(await f.code(), { [field!]: value })).status);
  }
  const expired = await f.code();
  await pool.query('UPDATE verification SET "expiresAt" = now() - interval \'1 second\' WHERE identifier = $1', [tokenHash(expired)]);
  expect((await f.redeem(expired)).status).toBe(400);
  const tokens = await f.issue();
  expect(await authenticateMcp(pool, tokens.access_token, "https://app.usetrawler.com/api/mcp")).toBeNull();
  const principal = await authenticateMcp(pool, tokens.access_token, resource);
  expect(await revokeGrant(pool, principal!.grantId, f.user.id)).toBe(true);
  expect(await authenticateMcp(pool, tokens.access_token, resource)).toBeNull();
  expect((await f.refresh(tokens.refresh_token)).status).toBe(400);
});

test("provider failures yield 503 without logging request credentials", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const error = vi.spyOn(console, "error");
  const log = vi.spyOn(console, "log");
  const query = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error(`backend failure ${tokens.access_token} ${tokens.refresh_token}`));
  try {
    const response = await mcpAuthentication(pool, origin, new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
    expect((response as Response).status).toBe(503);
    expect(JSON.stringify([...error.mock.calls, ...log.mock.calls])).not.toContain(tokens.access_token);
    expect(JSON.stringify([...error.mock.calls, ...log.mock.calls])).not.toContain(tokens.refresh_token);
  } finally { query.mockRestore(); error.mockRestore(); log.mockRestore(); }
});
