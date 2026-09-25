import { expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../server/auth.ts", () => ({
  getAuth: () => ({ api: { getSession: async () => ({ user: { id: "member-1", email: "member@acme.test" }, session: { activeOrganizationId: "org-1" } }) } }),
  canManageBilling: async () => false,
}));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => null }));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));

const { modelsForKeyAction, startRunAction } = await import("./actions.ts");
const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its model key.";

test("a member who is neither owner nor admin is told who may change the model key, when listing models", async () => {
  expect(await modelsForKeyAction({ key: "sk-or-v1-" + "k".repeat(40) })).toEqual({ ok: false, error: OWNERS_AND_ADMINS });
});

test("a member who is neither owner nor admin is told who may change the model key, when starting with a new key", async () => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ projectId: "p1", model: "deepseek/deepseek-v4.1-flash", budget: "2", authorised: "on", apiKey: "sk-or-v1-" + "k".repeat(40) })) form.set(k, v);
  expect(await startRunAction({}, form)).toEqual({ error: OWNERS_AND_ADMINS });
});
