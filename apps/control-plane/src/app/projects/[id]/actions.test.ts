import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[], projectInWorkspace: true, keyChecks: 0, keysSaved: 0, keyStillStored: true, runsStarted: 0, stillAsked: [] as unknown[][], startedIn: [] as unknown[], revalidated: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => { state.revalidated.push(path); } }));
vi.mock("../../../server/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/auth.ts")>()),
  signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null),
}));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => null }));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));
vi.mock("../../../projects/projects.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../projects/projects.ts")>()),
  projectExists: async () => state.projectInWorkspace,
}));
vi.mock("../../../llm/providers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../llm/providers.ts")>()),
  checkModelCall: async () => { state.keyChecks++; return { ok: true }; },
}));
vi.mock("../../../credentials/credentials.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../credentials/credentials.ts")>()),
  setModelKey: async () => { state.keysSaved++; },
  modelKey: async () => ({ provider: "openrouter", key: "sk-or-v1-" + "s".repeat(40), baseUrl: null }),
  modelKeyHint: async () => null,
  keyStillStored: async (...args: unknown[]) => { state.stillAsked.push(args); return state.keyStillStored; },
}));
vi.mock("../../../llm/prices.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../llm/prices.ts")>()),
  priceFor: async () => null,
}));
vi.mock("../../../runs/runs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runs/runs.ts")>()),
  startRun: async (tx: unknown) => { state.startedIn.push(tx); state.runsStarted++; return { id: "run-1", number: 1 }; },
}));

const { modelsForKeyAction, startRunAction } = await import("./actions.ts");
const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its model key.";
const PROJECT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY = "sk-or-v1-" + "k".repeat(40);
const startForm = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ projectId: PROJECT, model: "deepseek/deepseek-v4.1-flash", budget: "2", authorised: "on", ...fields })) form.set(k, v);
  return form;
};

beforeEach(() => {
  state.member = { userId: "member-1", email: "member@acme.test", orgId: "org-1", orgName: "Acme", role: "member" };
  state.tenants = [];
  state.projectInWorkspace = true;
  state.keyChecks = 0;
  state.keysSaved = 0;
  state.keyStillStored = true;
  state.runsStarted = 0;
  state.stillAsked = [];
  state.startedIn = [];
  state.revalidated = [];
});

test("a session that no longer belongs to its workspace can neither list models nor start a run, and nothing is read", async () => {
  state.member = null;
  expect(await modelsForKeyAction({})).toEqual({ ok: false, error: "Sign in again." });
  await expect(startRunAction({}, startForm())).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.tenants).toEqual([]);
});

test("a member who is neither owner nor admin is told who may change the model key, when listing models", async () => {
  expect(await modelsForKeyAction({ key: KEY })).toEqual({ ok: false, error: OWNERS_AND_ADMINS });
});

test("a member who is neither owner nor admin is told who may change the model key, when starting with a new key", async () => {
  expect(await startRunAction({}, startForm({ apiKey: KEY }))).toEqual({ error: OWNERS_AND_ADMINS });
  expect(state.keysSaved).toBe(0);
});

test("a key typed on the page of a project outside the member's workspace is neither checked nor saved", async () => {
  state.member = { userId: "owner-1", email: "owner@acme.test", orgId: "org-2", orgName: "Other", role: "owner" };
  state.projectInWorkspace = false;
  expect(await startRunAction({}, startForm({ apiKey: KEY }))).toEqual({ error: "The run could not start. Try again." });
  expect(state.tenants).toEqual(["org-2"]);
  expect([state.keyChecks, state.keysSaved]).toEqual([0, 0]);
});

test("a malformed project id starts nothing, checks and saves no key, and reads nothing", async () => {
  state.member = { userId: "owner-1", email: "owner@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
  expect(await startRunAction({}, startForm({ projectId: "not-a-uuid", apiKey: KEY }))).toEqual({ error: "The run could not start. Try again." });
  expect(state.tenants).toEqual([]);
  expect([state.keyChecks, state.keysSaved]).toEqual([0, 0]);
});

test("a run whose saved key is removed or changed while it starts is refused, not started without a key", async () => {
  state.keyStillStored = false;
  expect(await startRunAction({}, startForm())).toEqual({ error: "The workspace's model key was removed or changed while the run was starting. Check the key and start again." });
  expect(state.runsStarted).toBe(0);
  expect(state.revalidated).toEqual([`/projects/${PROJECT}`]);
});

test("a run whose saved key is still there starts and opens, checked in the same transaction that starts it", async () => {
  await expect(startRunAction({}, startForm())).rejects.toMatchObject({ to: "/runs/run-1" });
  expect(state.runsStarted).toBe(1);
  expect(state.stillAsked).toEqual([[state.startedIn[0], "org-1", "openrouter", null]]);
  expect(state.stillAsked[0]![0]).toBe(state.startedIn[0]);
});
