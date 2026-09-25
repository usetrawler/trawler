import { APIError } from "better-auth/api";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  signedIn: true,
  manager: true,
  renamed: [] as unknown[],
  renameFails: null as null | Error,
  listed: [] as string[],
  listingFails: false,
  saved: [] as unknown[],
  removed: [] as string[],
  revalidated: 0,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => { state.revalidated++; } }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  getAuth: () => ({ api: {
    getSession: async () => (state.signedIn ? { user: { id: "user-1", email: "ana@acme.test" }, session: { activeOrganizationId: "org-1" } } : null),
    updateOrganization: async (options: unknown) => {
      if (state.renameFails) throw state.renameFails;
      state.renamed.push(options);
      return {};
    },
  } }),
  canManageBilling: async () => state.manager,
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _orgId: string, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("../../credentials/credentials.ts", async (original) => ({
  ...(await original<typeof import("../../credentials/credentials.ts")>()),
  setModelKey: async (_tx: unknown, orgId: string, input: unknown, userId: string) => { state.saved.push({ orgId, input, userId }); },
  removeModelKey: async (_tx: unknown, orgId: string) => { state.removed.push(orgId); return true; },
}));
vi.mock("../../llm/providers.ts", async (original) => ({
  ...(await original<typeof import("../../llm/providers.ts")>()),
  listModels: async (endpoint: { baseUrl: string }) => {
    state.listed.push(endpoint.baseUrl);
    if (state.listingFails) throw new Error("401");
    return ["some/model"];
  },
}));

const { removeModelKeyAction, renameWorkspaceAction, replaceModelKeyAction } = await import("./actions.ts");
const OPENROUTER = "sk-or-v1-" + "a".repeat(40);
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its settings.";

beforeEach(() => {
  Object.assign(state, { signedIn: true, manager: true, renamed: [], renameFails: null, listed: [], listingFails: false, saved: [], removed: [], revalidated: 0 });
});

test("a member who is neither owner nor admin can rename nothing, replace no key and remove no key", async () => {
  state.manager = false;
  expect(await renameWorkspaceAction({}, form({ name: "Acme Labs" }))).toEqual({ error: OWNERS_AND_ADMINS });
  expect(await replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).toEqual({ error: OWNERS_AND_ADMINS });
  expect(await removeModelKeyAction()).toEqual({ error: OWNERS_AND_ADMINS });
  expect([state.renamed, state.listed, state.saved, state.removed]).toEqual([[], [], [], []]);
});

test("an owner renames the active workspace with the name trimmed", async () => {
  expect(await renameWorkspaceAction({}, form({ name: "  Acme Labs  " }))).toEqual({ saved: true });
  expect(state.renamed).toEqual([{ headers: expect.any(Headers), body: { organizationId: "org-1", data: { name: "Acme Labs" } } }]);
  expect(state.revalidated).toBe(1);
});

test("a blank name, or one the workspace rules refuse, gets the workspace rule as its message", async () => {
  expect(await renameWorkspaceAction({}, form({ name: "   " }))).toEqual({ error: "Workspace names are 1 to 100 plain characters." });
  expect(state.renamed).toEqual([]);
  state.renameFails = new APIError("BAD_REQUEST", { code: "INVALID_WORKSPACE", message: "workspace names are 1 to 100 plain characters" });
  expect(await renameWorkspaceAction({}, form({ name: "Acme​Labs" }))).toEqual({ error: "Workspace names are 1 to 100 plain characters." });
});

test("an owner replaces the key once the provider lists models for it, and it is saved as theirs", async () => {
  expect(await replaceModelKeyAction({}, form({ apiKey: ` ${OPENROUTER} ` }))).toEqual({ saved: true });
  expect(state.listed).toEqual(["https://openrouter.test/api/v1"]);
  expect(state.saved).toEqual([{ orgId: "org-1", input: { provider: "openrouter", key: OPENROUTER, baseUrl: null }, userId: "user-1" }]);
});

test("a key the provider will not list models for is not saved", async () => {
  state.listingFails = true;
  expect(await replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).toEqual({ error: "OpenRouter did not list models for this key. Check the key and the provider." });
  expect(state.saved).toEqual([]);
});

test("something that is not a key, or an OpenAI-compatible key without an https base URL, is refused before any call", async () => {
  expect(await replaceModelKeyAction({}, form({ apiKey: "hello" }))).toEqual({ error: "That does not look like an API key. Copy it again from your provider." });
  expect(await replaceModelKeyAction({}, form({ apiKey: "k".repeat(30), provider: "custom", baseUrl: "http://llm.internal/v1" }))).toEqual({ error: "The base URL must use https." });
  expect([state.listed, state.saved]).toEqual([[], []]);
});

test("an owner removes the key of the active workspace", async () => {
  expect(await removeModelKeyAction()).toEqual({ saved: true });
  expect(state.removed).toEqual(["org-1"]);
});

test("someone who is not signed in is sent to sign in", async () => {
  state.signedIn = false;
  await expect(removeModelKeyAction()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.removed).toEqual([]);
});
