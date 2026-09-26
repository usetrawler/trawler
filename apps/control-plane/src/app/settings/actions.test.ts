import { APIError } from "better-auth/api";
import { beforeEach, expect, test, vi } from "vitest";

type Check = { ok: true; checked: boolean } | { ok: false; reason: "key" | "private" | "unavailable" };
const state = vi.hoisted(() => ({
  member: null as null | { userId: string; name: string; email: string; orgId: string; orgName: string; role: string },
  renamed: [] as unknown[],
  renameFails: null as null | Error,
  checked: [] as string[],
  check: { ok: true, checked: true } as Check,
  saved: [] as unknown[],
  removed: [] as Array<{ orgId: string; tx: unknown }>,
  cancelled: [] as Array<{ orgId: string; tx: unknown }>,
  live: 0,
  tenants: [] as string[],
  revalidated: 0,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => { state.revalidated++; } }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  signedInMember: async () => state.member,
  canManageBilling: (member: { role: string }) => member.role === "owner" || member.role === "admin",
  getAuth: () => ({ api: {
    updateOrganization: async (options: unknown) => {
      if (state.renameFails) throw state.renameFails;
      state.renamed.push(options);
      return {};
    },
  } }),
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({ tx: orgId }); } }));
vi.mock("../../credentials/credentials.ts", async (original) => ({
  ...(await original<typeof import("../../credentials/credentials.ts")>()),
  setModelKey: async (_tx: unknown, orgId: string, input: unknown, userId: string) => { state.saved.push({ orgId, input, userId }); },
  removeModelKey: async (tx: unknown, orgId: string) => { state.removed.push({ orgId, tx }); return true; },
}));
vi.mock("../../runs/runs.ts", () => ({ cancelLiveRuns: async (tx: unknown, orgId: string) => { state.cancelled.push({ orgId, tx }); return state.live; } }));
vi.mock("../../llm/providers.ts", async (original) => ({
  ...(await original<typeof import("../../llm/providers.ts")>()),
  checkKey: async (endpoint: { baseUrl: string }) => {
    state.checked.push(endpoint.baseUrl);
    return state.check;
  },
}));

const { removeModelKeyAction, renameWorkspaceAction, replaceModelKeyAction } = await import("./actions.ts");
const OPENROUTER = "sk-or-v1-" + "a".repeat(40);
const CUSTOM = "k-" + "b".repeat(40);
const owner = { userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its settings.";

beforeEach(() => {
  Object.assign(state, { member: owner, renamed: [], renameFails: null, checked: [], check: { ok: true, checked: true }, saved: [], removed: [], cancelled: [], live: 0, tenants: [], revalidated: 0 });
});

test("a member of this workspace who is neither owner nor admin renames nothing, and replaces or removes no key", async () => {
  state.member = { ...owner, role: "member" };
  expect(await renameWorkspaceAction({}, form({ name: "Mine" }))).toEqual({ error: OWNERS_AND_ADMINS });
  expect(await replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).toEqual({ error: OWNERS_AND_ADMINS });
  expect(await removeModelKeyAction()).toEqual({ error: OWNERS_AND_ADMINS });
  expect([state.renamed, state.checked, state.saved, state.removed, state.cancelled, state.revalidated]).toEqual([[], [], [], [], [], 0]);
});

test("an admin may change the settings too", async () => {
  state.member = { ...owner, role: "admin" };
  expect(await renameWorkspaceAction({}, form({ name: "Acme Labs" }))).toEqual({ saved: true });
});

test("someone signed out, or no longer in the workspace, is sent to sign in", async () => {
  state.member = null;
  await expect(renameWorkspaceAction({}, form({ name: "x" }))).rejects.toMatchObject({ to: "/sign-in" });
  await expect(replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).rejects.toMatchObject({ to: "/sign-in" });
  await expect(removeModelKeyAction()).rejects.toMatchObject({ to: "/sign-in" });
});

test("a rename is trimmed and goes to the workspace the member belongs to, then every page shows it", async () => {
  expect(await renameWorkspaceAction({}, form({ name: "  Acme Labs  " }))).toEqual({ saved: true });
  expect(state.renamed).toEqual([{ headers: expect.any(Headers), body: { organizationId: "org-1", data: { name: "Acme Labs" } } }]);
  expect(state.revalidated).toBe(1);
});

test("a blank name is refused with the workspace-name rule, and a refused one with its reason as a sentence", async () => {
  expect(await renameWorkspaceAction({}, form({ name: "   " }))).toEqual({ error: "Workspace names are 1 to 100 plain characters." });
  state.renameFails = new APIError("BAD_REQUEST", { message: "workspace names are 1 to 100 plain characters" });
  expect(await renameWorkspaceAction({}, form({ name: "\u0007" }))).toEqual({ error: "Workspace names are 1 to 100 plain characters." });
  expect(state.renamed).toEqual([]);
});

test("a key is saved for the member's workspace only once the provider accepts it, and says when it was saved unchecked", async () => {
  expect(await replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).toEqual({ saved: true, unchecked: false });
  expect(state.checked).toEqual(["https://openrouter.test/api/v1"]);
  expect(state.saved).toEqual([{ orgId: "org-1", input: { provider: "openrouter", key: OPENROUTER, baseUrl: null }, userId: "user-1" }]);
  state.check = { ok: true, checked: false };
  expect(await replaceModelKeyAction({}, form({ apiKey: CUSTOM, provider: "custom", baseUrl: "https://llm.example.com/v1" }))).toEqual({ saved: true, unchecked: true });
  expect(state.saved.at(-1)).toEqual({ orgId: "org-1", input: { provider: "custom", key: CUSTOM, baseUrl: "https://llm.example.com/v1" }, userId: "user-1" });
  expect(state.tenants).toEqual(["org-1", "org-1"]);
  expect(state.revalidated).toBe(2);
});

test("a key the provider refuses, one on a private network, or one that cannot be checked right now is not saved", async () => {
  state.check = { ok: false, reason: "key" };
  expect(await replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).toEqual({ error: "OpenRouter refused this key. Copy it again from your provider, and check the provider picked below it." });
  state.check = { ok: false, reason: "private" };
  expect(await replaceModelKeyAction({}, form({ apiKey: CUSTOM, provider: "custom", baseUrl: "https://10.0.0.8/v1" }))).toEqual({ error: "That base URL is on a private network. Hosted runs reach only public addresses; the local runner reaches private ones." });
  state.check = { ok: false, reason: "unavailable" };
  expect(await replaceModelKeyAction({}, form({ apiKey: OPENROUTER }))).toEqual({ error: "OpenRouter could not be reached to check the key. Try again in a minute." });
  expect([state.saved, state.revalidated]).toEqual([[], 0]);
});

test("a malformed key or an http base URL is refused before the provider is asked", async () => {
  expect(await replaceModelKeyAction({}, form({ apiKey: "short" }))).toEqual({ error: "That does not look like an API key. Copy it again from your provider." });
  expect(await replaceModelKeyAction({}, form({ apiKey: CUSTOM, provider: "custom", baseUrl: "http://llm.example.com/v1" }))).toEqual({ error: "The base URL must use https." });
  expect([state.checked, state.saved]).toEqual([[], []]);
});

test("removing the key also stops the workspace's runs that are going, in the same transaction, and says how many", async () => {
  state.live = 2;
  expect(await removeModelKeyAction()).toEqual({ saved: true, stoppedRuns: 2 });
  expect(state.removed).toEqual([{ orgId: "org-1", tx: { tx: "org-1" } }]);
  expect(state.cancelled).toEqual([{ orgId: "org-1", tx: state.removed[0]!.tx }]);
  expect(state.cancelled[0]!.tx).toBe(state.removed[0]!.tx);
  expect(state.revalidated).toBe(1);
  state.live = 0;
  expect(await removeModelKeyAction()).toEqual({ saved: true, stoppedRuns: 0 });
});
