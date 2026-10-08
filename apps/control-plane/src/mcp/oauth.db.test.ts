import { createHmac, randomUUID } from "node:crypto";
import { afterAll, expect, test, vi } from "vitest";
import { authPool, createAuth } from "../auth/auth.ts";
import { onDatabase, testDb } from "../db/test-db.ts";
import { prepareConsent } from "./consent.ts";
import { mcpAuthentication, pruneMcp } from "./http.ts";
import { authenticateMcp, revokeGrant } from "./oauth.ts";
import { tokenHash } from "./config.ts";

const t = await testDb();
const pool = authPool(t.url, 6);
const secret = "integration-test-secret-with-enough-entropy";
const origin = "http://localhost:3000";
const resource = `${origin}/api/mcp`;
const auth = createAuth({ pool, secret, baseURL: origin, mcp: { dcr: true } });
afterAll(async () => { await pool.end(); await t.drop(); });

async function fixture(method = "none") {
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
    token_endpoint_auth_method: method, application_type: "native", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }, false);
  expect(registered.status, await registered.clone().text()).toBe(201);
  const client = await registered.json() as { client_id: string; client_secret?: string };
  if (method === "client_secret_basic") headers.set("authorization", `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`);
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

test("a client registered with a portless loopback redirect may authorize on any port, and only there", async () => {
  const f = await fixture();
  const registered = await f.call("/api/auth/oauth2/register", {
    client_name: "Loopback client", redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none",
    application_type: "native", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }, false);
  expect(registered.status, await registered.clone().text()).toBe(201);
  const { client_id } = await registered.json() as { client_id: string };
  const attempt = (redirect: string) => f.authorize(new URLSearchParams({ ...Object.fromEntries(f.query), client_id, redirect_uri: redirect }));
  const allowed = await attempt("http://localhost:43188/callback");
  expect(allowed.status, await allowed.clone().text()).toBe(302);
  expect(new URL(allowed.headers.get("location")!, origin).pathname).toBe("/mcp/consent");
  const otherPath = await attempt("http://localhost:43188/elsewhere");
  expect(new URL(otherPath.headers.get("location") ?? "http://none.test", origin).pathname).not.toBe("/mcp/consent");
  const otherHost = await attempt("http://127.0.0.1:43188/callback");
  expect(new URL(otherHost.headers.get("location") ?? "http://none.test", origin).pathname).not.toBe("/mcp/consent");
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

test("provider adapter failures yield sanitized 503 without Better Call console output", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
  const query = vi.spyOn((await auth.$context).adapter, "findOne").mockRejectedValueOnce(new Error(`backend failed with ${tokens.access_token} ${tokens.refresh_token}`));
  try {
    const response = await f.call("/api/auth/oauth2/revoke", { token: tokens.access_token, token_type_hint: "access_token", client_id: f.client.client_id }, false);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
    expect(output).not.toContain(tokens.access_token);
    expect(output).not.toContain(tokens.refresh_token);
  } finally { query.mockRestore(); for (const log of logs) log.mockRestore(); }
});


test("confidential refresh uses Basic authentication and a wrong secret cannot revoke a grant", async () => {
  const f = await fixture("client_secret_basic");
  const tokens = await f.issue();
  const response = await f.refresh(tokens.refresh_token, { client_id: "" });
  expect(response.status, await response.clone().text()).toBe(200);
  const next = await response.json() as { access_token: string };
  const bad = new Headers(f.headers);
  bad.delete("cookie");
  bad.set("content-type", "application/x-www-form-urlencoded");
  bad.set("authorization", `Basic ${Buffer.from(`${f.client.client_id}:incorrect-secret`).toString("base64")}`);
  const replay = await auth.handler(new Request(`${origin}/api/auth/oauth2/token`, {
    method: "POST", headers: bad,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource }).toString(),
  }));
  expect(replay.status).toBe(401);
  expect(await authenticateMcp(pool, next.access_token, resource)).toBeTruthy();
  expect((await f.refresh(tokens.refresh_token)).status).toBe(400);
  expect(await authenticateMcp(pool, next.access_token, resource)).toBeNull();
});

test("live membership, expiry, provider revocation and sender constraints are checked on every request", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  expect(await authenticateMcp(pool, tokens.access_token, resource)).toBeTruthy();
  await pool.query(`UPDATE member SET role = 'member' WHERE "userId" = $1`, [f.user.id]);
  expect((await authenticateMcp(pool, tokens.access_token, resource))?.role).toBe("member");
  await pool.query('UPDATE "oauthAccessToken" SET confirmation = $2 WHERE token = $1', [tokenHash(tokens.access_token), { jkt: "sender-key" }]);
  expect(await authenticateMcp(pool, tokens.access_token, resource)).toBeNull();
  await pool.query(`UPDATE "oauthAccessToken" SET confirmation = NULL, "expiresAt" = now() - interval '1 second' WHERE token = $1`, [tokenHash(tokens.access_token)]);
  expect(await authenticateMcp(pool, tokens.access_token, resource)).toBeNull();
  const fresh = await f.issue();
  const revoked = await f.call("/api/auth/oauth2/revoke", { token: fresh.access_token, token_type_hint: "access_token", client_id: f.client.client_id }, false);
  expect(revoked.status).toBe(200);
  expect(await authenticateMcp(pool, fresh.access_token, resource)).toBeNull();
  const live = await f.issue();
  await pool.query('DELETE FROM member WHERE "userId" = $1', [f.user.id]);
  expect(await authenticateMcp(pool, live.access_token, resource)).toBeNull();
  expect((await f.refresh(live.refresh_token)).status).toBe(400);
});

test("production discovery omits registration when DCR is disabled and foreign resources fail closed", async () => {
  const prod = createAuth({ pool, secret, baseURL: "https://app.usetrawler.com", mcp: {} });
  const meta = await prod.handler(new Request("https://app.usetrawler.com/.well-known/oauth-authorization-server/api/auth"));
  expect((await meta.json()).registration_endpoint).toBeUndefined();
  const f = await fixture();
  const tokens = await f.issue();
  const denied = await mcpAuthentication(pool, "https://app.usetrawler.com", new Request("https://app.usetrawler.com/api/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } }));
  expect((denied as Response).status).toBe(401);
});

test("every authorization shows the consent page, so a remembered consent never issues a code on its own", async () => {
  const f = await fixture();
  await f.issue();
  const bare = new URLSearchParams(f.query);
  bare.delete("prompt");
  const again = await f.authorize(bare);
  expect(again.status).toBe(302);
  expect(new URL(again.headers.get("location")!, origin).pathname).toBe("/mcp/consent");
  const silent = new URLSearchParams(f.query);
  silent.set("prompt", "none");
  expect((await f.authorize(silent)).status).toBe(400);
});

test("disconnecting a connection also forgets any consent left behind it", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const principal = await authenticateMcp(pool, tokens.access_token, resource);
  await onDatabase(t.name, (c) => c.query(
    'INSERT INTO "oauthConsent" (id, "clientId", "userId", "referenceId", scopes, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, \'["trawler:read"]\', now(), now())',
    [randomUUID(), f.client.client_id, f.user.id, principal!.orgId]));
  const consents = () => pool.query('SELECT 1 FROM "oauthConsent" WHERE "clientId" = $1', [f.client.client_id]).then((r) => r.rowCount);
  expect(await consents()).toBe(1);
  expect(await revokeGrant(pool, principal!.grantId, f.user.id)).toBe(true);
  expect(await consents()).toBe(0);
});

test("authorize accepts only GET and a request that asks to read, and introspection is closed", async () => {
  const f = await fixture();
  const posted = await f.call("/api/auth/oauth2/authorize", Object.fromEntries(f.query));
  expect(posted.status).toBe(405);
  const writeOnly = new URLSearchParams(f.query);
  writeOnly.set("scope", "trawler:runs:write");
  expect((await f.authorize(writeOnly)).status).toBe(400);
  expect((await f.call("/api/auth/oauth2/introspect", { token: "x".repeat(30) }, false)).status).toBe(403);
});

test("a request body is read the way the provider reads it, and any other type is refused", async () => {
  const f = await fixture();
  const send = (contentType: string, body: string) => auth.handler(new Request(`${origin}/api/auth/oauth2/consent`, {
    method: "POST", headers: new Headers({ ...Object.fromEntries(f.headers), "content-type": contentType }), body,
  }));
  const asJson = await send("Application/JSON; charset=utf-8", JSON.stringify({ accept: true, oauth_query: "not-a-flow" }));
  expect(asJson.status).toBe(403);
  expect(await asJson.json()).toEqual({ error: "access_denied" });
  expect((await send("text/plain", JSON.stringify({ accept: true, oauth_query: "x" }))).status).toBe(415);
  expect((await send("application/x-www-form-urlencoded;application/json", JSON.stringify({ accept: true, oauth_query: "x" }))).status).toBe(415);
});

test("a connection does not depend on the browser session that created it", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  await pool.query('UPDATE session SET "expiresAt" = now() - interval \'1 day\' WHERE "userId" = $1', [f.user.id]);
  expect(await authenticateMcp(pool, tokens.access_token, resource)).toBeTruthy();
  const refreshed = await f.refresh(tokens.refresh_token);
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  const next = await refreshed.json() as { access_token: string };
  expect(await authenticateMcp(pool, next.access_token, resource)).toBeTruthy();
});

test("a refresh never creates a grant: when the grant is gone the token is refused and nothing reappears", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const grants = () => onDatabase(t.name, async (c) => (await c.query("SELECT 1 FROM mcp_grants WHERE user_id = $1", [f.user.id])).rowCount);
  expect(await grants()).toBe(1);
  await onDatabase(t.name, (c) => c.query("DELETE FROM mcp_grants WHERE user_id = $1", [f.user.id]));
  expect((await f.refresh(tokens.refresh_token)).status).toBe(400);
  expect(await grants()).toBe(0);
});

test("expired consent contexts are cleared when a new consent is prepared", async () => {
  const f = await fixture();
  const oauthQuery = new URL((await f.authorize()).headers.get("location")!, origin).searchParams.toString();
  await onDatabase(t.name, (c) => c.query("INSERT INTO mcp_consent_contexts (flow_hash, user_id, org_id, expires_at) VALUES ('stale-flow', $1, $2, now() - interval '2 hours')", [f.user.id, f.session.activeOrganizationId]));
  await prepareConsent(pool, secret, origin, oauthQuery, f.user.id, f.session.activeOrganizationId);
  expect(await onDatabase(t.name, async (c) => (await c.query("SELECT 1 FROM mcp_consent_contexts WHERE flow_hash = 'stale-flow'")).rowCount)).toBe(0);
});

test("pruning removes tokens that expired more than a day ago and keeps newer ones", async () => {
  const f = await fixture();
  const keeper = await fixture();
  await f.issue();
  await keeper.issue();
  const count = (table: string, clientId: string) => onDatabase(t.name, async (c) => (await c.query(`SELECT 1 FROM "${table}" WHERE "clientId" = $1`, [clientId])).rowCount);
  await onDatabase(t.name, async (c) => {
    await c.query('UPDATE "oauthAccessToken" SET "expiresAt" = now() - interval \'2 days\' WHERE "clientId" = $1', [f.client.client_id]);
    await c.query('UPDATE "oauthRefreshToken" SET "expiresAt" = now() - interval \'2 days\' WHERE "clientId" = $1', [f.client.client_id]);
  });
  await pruneMcp(pool, Math.floor(Date.now() / 60_000));
  expect([await count("oauthAccessToken", f.client.client_id), await count("oauthRefreshToken", f.client.client_id)]).toEqual([0, 0]);
  expect(await count("oauthAccessToken", keeper.client.client_id)).toBeGreaterThan(0);
  expect(await count("oauthRefreshToken", keeper.client.client_id)).toBeGreaterThan(0);
});

test("a refresh that narrows the scope below read still succeeds, and the grant stays alive", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const narrowed = await f.refresh(tokens.refresh_token, { scope: "offline_access" });
  expect(narrowed.status, await narrowed.clone().text()).toBe(200);
  const next = await narrowed.json() as { access_token: string; refresh_token: string };
  expect(await authenticateMcp(pool, next.access_token, resource)).toBeNull();
  expect(await onDatabase(t.name, async (c) => (await c.query("SELECT 1 FROM mcp_grants WHERE user_id = $1 AND revoked_at IS NULL", [f.user.id])).rowCount)).toBe(1);
  expect((await f.refresh(next.refresh_token)).status).toBe(200);
});

test("a refresh with a client_id that is not a string is refused as a bad request", async () => {
  const f = await fixture();
  const tokens = await f.issue();
  const headers = new Headers(f.headers);
  headers.delete("cookie");
  const response = await auth.handler(new Request(`${origin}/api/auth/oauth2/token`, {
    method: "POST", headers, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: 5 }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});

test("consent is not remembered after a code is issued, and an authorization cannot ask the provider to skip it with max_age", async () => {
  const f = await fixture();
  await f.issue();
  expect(await pool.query('SELECT 1 FROM "oauthConsent" WHERE "clientId" = $1', [f.client.client_id]).then((r) => r.rowCount)).toBe(0);
  const aged = new URLSearchParams(f.query);
  aged.set("max_age", "1");
  const response = await f.authorize(aged);
  const location = new URL(response.headers.get("location")!, origin);
  expect(location.pathname).toBe("/mcp/consent");
  expect(location.searchParams.has("max_age")).toBe(false);
  expect(location.searchParams.get("prompt")).toContain("consent");
});
