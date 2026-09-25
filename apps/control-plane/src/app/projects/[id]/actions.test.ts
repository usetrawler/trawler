import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../../server/auth.ts", () => ({
  signedInMember: async () => state.member,
  canManageBilling: async () => false,
}));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => null }));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));

const { modelsForKeyAction, startRunAction } = await import("./actions.ts");
const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its model key.";
const startForm = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ projectId: "p1", model: "deepseek/deepseek-v4.1-flash", budget: "2", authorised: "on", ...fields })) form.set(k, v);
  return form;
};

beforeEach(() => {
  state.member = { userId: "member-1", email: "member@acme.test", orgId: "org-1" };
  state.tenants = [];
});

test("a session that no longer belongs to any workspace can neither list models nor start a run, and nothing is read", async () => {
  state.member = null;
  expect(await modelsForKeyAction({})).toEqual({ ok: false, error: "Sign in again." });
  await expect(startRunAction({}, startForm())).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.tenants).toEqual([]);
});

test("a member who is neither owner nor admin is told who may change the model key, when listing models", async () => {
  expect(await modelsForKeyAction({ key: "sk-or-v1-" + "k".repeat(40) })).toEqual({ ok: false, error: OWNERS_AND_ADMINS });
});

test("a member who is neither owner nor admin is told who may change the model key, when starting with a new key", async () => {
  expect(await startRunAction({}, startForm({ apiKey: "sk-or-v1-" + "k".repeat(40) }))).toEqual({ error: OWNERS_AND_ADMINS });
});
