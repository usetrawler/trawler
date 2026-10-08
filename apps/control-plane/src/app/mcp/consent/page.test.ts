import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  person: null as null | { user: { name: string; email: string }; session: object },
  workspace: null as null | "choosing" | { orgId: string; orgName: string; role: string },
  consent: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("../../auth-client.ts", () => ({ authClient: { signOut: async () => ({}) } }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _org: string, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("../../../projects/projects.ts", () => ({ listProjects: async () => [{ id: "p-1", name: "Checkout" }] }));
vi.mock("../../../mcp/consent.ts", () => ({ prepareConsent: async () => state.consent }));
vi.mock("../../../server/auth.ts", () => ({
  getAuth: () => ({
    mcp: { pool: {}, secret: "s", origin: "http://localhost:3000" },
    api: { getSession: async () => state.person },
    workspaceOf: async () => state.workspace,
  }),
}));

const { default: ConsentPage } = await import("./page.tsx");
const render = async () => renderToStaticMarkup(await ConsentPage({ searchParams: Promise.resolve({ client_id: "c" }) }));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const person = { user: { name: "Ana", email: "ana@acme.test" }, session: {} };
const consent = (over: Record<string, unknown> = {}) => ({
  org_id: "org-1", org_name: "Acme", client_name: "Claude Code", clientId: "https://claude.ai/oauth/claude-code-client-metadata", clientHost: "claude.ai",
  redirectTarget: "http://localhost:43188", scopes: ["trawler:read", "offline_access"], settings: { connectionsAllowed: true, runControlAllowed: false }, ...over,
});

beforeEach(() => {
  state.person = person;
  state.workspace = { orgId: "org-1", orgName: "Acme", role: "owner" };
  state.consent = consent();
});

test("a person who has not finished setting up a workspace is told so, and can switch account or leave", async () => {
  state.workspace = "choosing";
  state.consent = null;
  const html = await render();
  expect(words(html)).toContain("Finish setting up your workspace in Trawler first, then start the connection again from your assistant.");
  expect(html).toContain("Not you? Switch account");
  expect(html).toContain('href="/"');
});

test("an expired or foreign request is explained without offering to switch account to somebody who is not signed in", async () => {
  state.person = null;
  state.workspace = null;
  state.consent = null;
  const html = await render();
  expect(words(html)).toContain("This request has expired, or it was made for another account.");
  expect(html).not.toContain("Not you? Switch account");
});

test("a client published at an https host says so, and any other client is labelled unverified, always with where the person is sent back to", async () => {
  expect(words(await render())).toContain("Published at claude.ai");
  state.consent = consent({ clientHost: null, redirectTarget: "http://localhost:43188" });
  const text = words(await render());
  expect(text).toContain("Trawler has not verified who made it");
  expect(text).toContain("you are sent back to http://localhost:43188");
});

test("with connections switched off the page says so, offers Cancel and Go to Trawler, and links to Settings only for an owner or admin", async () => {
  state.consent = consent({ settings: { connectionsAllowed: false, runControlAllowed: false } });
  const owner = await render();
  expect(words(owner)).toContain("MCP connections are switched off for this workspace.");
  expect(owner).toContain('href="/settings"');
  expect(owner).toContain("Cancel the connection");
  expect(owner).not.toContain("Allow read access");
  state.workspace = { orgId: "org-1", orgName: "Acme", role: "member" };
  const member = await render();
  expect(member).not.toContain('href="/settings"');
  expect(member).toContain("Cancel the connection");
});

test("run control is offered only to a role that may use it, and the reason is given otherwise", async () => {
  state.consent = consent({ scopes: ["trawler:read", "trawler:runs:write"], settings: { connectionsAllowed: true, runControlAllowed: true } });
  expect(await render()).toContain("Allow read access");
  expect(words(await render())).toContain("Read access and run control");
  state.workspace = { orgId: "org-1", orgName: "Acme", role: "viewer" };
  const text = words(await render());
  expect(text).not.toContain("Read access and run control");
  expect(text).toContain("Your role in this workspace does not allow controlling runs");
});
