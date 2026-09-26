import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ runs: {} as Record<string, number>, counted: [] as unknown[], started: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../../server/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/auth.ts")>()),
  signedInMember: async () => ({ userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" }),
}));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => null }));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _orgId: string, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("../../../projects/overview.ts", () => ({ projectRunCount: async (_tx: unknown, orgId: string, projectId: string) => { state.counted.push([orgId, projectId]); return state.runs[projectId] ?? 0; } }));
vi.mock("../../../credentials/credentials.ts", () => ({
  modelKey: async () => ({ provider: "openrouter", key: "sk-or-v1-" + "k".repeat(40), baseUrl: null }),
  modelKeyHint: async () => null,
  setModelKey: async () => {},
  keyStillStored: async () => true,
}));
vi.mock("../../../projects/projects.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../../projects/projects.ts")>()), projectExists: async () => true }));
vi.mock("../../../llm/prices.ts", () => ({ priceFor: async () => ({ promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 }), openRouterPrices: async () => new Map() }));
vi.mock("../../../llm/providers.ts", async (original) => ({ ...(await original<typeof import("../../../llm/providers.ts")>()), checkModelCall: async () => ({ ok: true }) }));
vi.mock("../../../runs/runs.ts", () => ({ startRun: async (_tx: unknown, _orgId: string, projectId: string) => { state.started.push(projectId); return { id: "new-run", number: 2 }; } }));

const { startRunAction } = await import("./actions.ts");
const RAN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NEW = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const start = (projectId: string, authorised: boolean) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ projectId, model: "deepseek/deepseek-v4.1-flash", budget: "2", ...(authorised ? { authorised: "on" } : {}) })) form.set(k, v);
  return startRunAction({}, form);
};

beforeEach(() => {
  Object.assign(state, { runs: { [RAN]: 1 }, counted: [], started: [] });
});

test("a product that has had a run starts again without the box, because its first Start confirmed it", async () => {
  await expect(start(RAN, false)).rejects.toMatchObject({ to: "/runs/new-run" });
  expect(state.counted).toEqual([["org-1", RAN]]);
  expect(state.started).toEqual([RAN]);
});

test("the confirmation is per product: another product of the same workspace still needs the box", async () => {
  expect(await start(NEW, false)).toEqual({ error: "Confirm that you may test this product." });
  expect(state.started).toEqual([]);
  await expect(start(NEW, true)).rejects.toMatchObject({ to: "/runs/new-run" });
  expect(state.started).toEqual([NEW]);
});

test("a malformed product address without the box is refused before any database call", async () => {
  expect(await start("p1", false)).toEqual({ error: "Confirm that you may test this product." });
  expect(state.counted).toEqual([]);
});
