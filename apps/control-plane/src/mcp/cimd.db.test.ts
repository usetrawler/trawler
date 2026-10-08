import { createHmac, randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { authPool, createAuth } from "../auth/auth.ts";
import { testDb } from "../db/test-db.ts";
import { prepareConsent } from "./consent.ts";
import { authenticateMcp } from "./oauth.ts";
import { tokenHash } from "./config.ts";

const t = await testDb();
const pool = authPool(t.url, 6);
const secret = "integration-test-secret-with-enough-entropy";
const origin = "http://localhost:3000";
const resource = `${origin}/api/mcp`;
const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata";

const documents = new Map<string, unknown>();
const fetched: string[] = [];
const auth = createAuth({
  pool, secret, baseURL: origin,
  mcp: {
    fetchClientMetadata: async (input) => {
      const url = new Request(input).url;
      fetched.push(url);
      const document = documents.get(url);
      if (document === "network-error") throw new TypeError("metadata host unreachable");
      return document ? Response.json(document, { headers: { "cache-control": "max-age=60" } }) : new Response("not found", { status: 404 });
    },
  },
});
afterAll(async () => { await pool.end(); await t.drop(); });

const metadata = (overrides: Record<string, unknown> = {}) => ({
  client_id: claudeCode, client_name: "Claude Code",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  ...overrides,
});

async function person() {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: `${randomUUID()}@example.test`, emailVerified: true, name: "Alex" }, { method: "admin" });
  const session = await ctx.internalAdapter.createSession(user.id, false) as unknown as { token: string; activeOrganizationId: string };
  const headers = new Headers({
    Origin: origin, "x-real-ip": randomUUID(),
    Cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${createHmac("sha256", secret).update(session.token).digest("base64")}`)}`,
  });
  const verifier = "b".repeat(64);
  const authorize = (clientId: string, redirectUri: string) => auth.handler(new Request(`${origin}/api/auth/oauth2/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", prompt: "consent", scope: "trawler:read offline_access",
    resource, state: "state-for-this-flow", code_challenge_method: "S256", code_challenge: tokenHash(verifier),
  })}`, { headers }));
  const consentOf = (response: Response) => {
    const location = response.headers.get("location");
    const url = location ? new URL(location, origin) : null;
    return url?.pathname === "/mcp/consent" ? url.searchParams.toString() : null;
  };
  return { user, session, headers, verifier, authorize, consentOf };
}

test("a client that is a metadata document URL connects end to end, on the port it chooses", async () => {
  documents.set(claudeCode, metadata());
  const p = await person();
  const redirect = "http://localhost:43188/callback";
  const response = await p.authorize(claudeCode, redirect);
  expect(response.status).toBe(302);
  const query = p.consentOf(response);
  expect(query).toBeTruthy();
  expect(await prepareConsent(pool, secret, origin, query!, p.user.id, p.session.activeOrganizationId))
    .toMatchObject({ client_name: "Claude Code", clientId: claudeCode, clientHost: "claude.ai" });

  const consent = new Headers(p.headers);
  consent.set("content-type", "application/json");
  const accepted = await auth.handler(new Request(`${origin}/api/auth/oauth2/consent`, { method: "POST", headers: consent, body: JSON.stringify({ accept: true, oauth_query: query }) }));
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const result = await accepted.json() as { url?: string; redirect_uri?: string };
  const back = new URL(result.url ?? result.redirect_uri!);
  expect(`${back.origin}${back.pathname}`).toBe(redirect);
  expect(back.searchParams.get("state")).toBe("state-for-this-flow");

  const token = await auth.handler(new Request(`${origin}/api/auth/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Origin: origin, "x-real-ip": randomUUID() },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: claudeCode, redirect_uri: redirect, code: back.searchParams.get("code")!, code_verifier: p.verifier, resource }).toString(),
  }));
  expect(token.status, await token.clone().text()).toBe(200);
  const tokens = await token.json() as { access_token: string; refresh_token: string };
  expect(tokens.refresh_token).toBeTruthy();
  expect(await authenticateMcp(pool, tokens.access_token, resource)).toMatchObject({ clientId: claudeCode, userId: p.user.id, orgId: p.session.activeOrganizationId });
});

test("a metadata document is fetched once and reused while it is fresh", async () => {
  const cached = "https://claude.ai/oauth/cached-client";
  documents.set(cached, metadata({ client_id: cached }));
  const p = await person();
  const first = await p.authorize(cached, "http://localhost:43188/callback");
  const second = await p.authorize(cached, "http://127.0.0.1:50000/callback");
  expect(p.consentOf(first)).toBeTruthy();
  expect(p.consentOf(second)).toBeTruthy();
  expect(fetched.filter((url) => url === cached)).toHaveLength(1);
});

test.each([
  ["a document that names another client_id", "https://claude.ai/other-client", () => documents.set("https://claude.ai/other-client", metadata()), "http://localhost:43188/callback"],
  ["an unreachable metadata host", "https://down.example.test/client.json", () => documents.set("https://down.example.test/client.json", "network-error"), "http://localhost:43188/callback"],
  ["a missing document", "https://gone.example.test/client.json", () => {}, "http://localhost:43188/callback"],
  ["a plain HTTP client_id", "http://claude.ai/oauth/claude-code-client-metadata", () => {}, "http://localhost:43188/callback"],
  ["a client_id on a private address", "https://127.0.0.1/client.json", () => documents.set("https://127.0.0.1/client.json", metadata({ client_id: "https://127.0.0.1/client.json" })), "http://localhost:43188/callback"],
  ["a client with a shared secret", "https://secret.example.test/client.json", () => documents.set("https://secret.example.test/client.json", metadata({ client_id: "https://secret.example.test/client.json", token_endpoint_auth_method: "client_secret_basic" })), "http://localhost:43188/callback"],
  ["a document without a name", "https://nameless.example.test/client.json", () => documents.set("https://nameless.example.test/client.json", metadata({ client_id: "https://nameless.example.test/client.json", client_name: "" })), "http://localhost:43188/callback"],
  ["a redirect the document does not list", claudeCode, () => documents.set(claudeCode, metadata()), "https://evil.test/callback"],
  ["a loopback redirect on another path", claudeCode, () => documents.set(claudeCode, metadata()), "http://localhost:43188/elsewhere"],
])("%s never reaches consent", async (_name, clientId, arrange, redirect) => {
  arrange();
  const p = await person();
  const response = await p.authorize(clientId as string, redirect as string);
  expect(p.consentOf(response)).toBeNull();
});
