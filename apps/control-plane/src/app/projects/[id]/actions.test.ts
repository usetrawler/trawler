import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ without: null as string | null, startRefusal: null as Error | null, startFails: null as Error | null, logged: [] as string[], member: null as Member | null, tenants: [] as string[], projectInWorkspace: true, keyChecks: 0, keysSaved: 0, keyStillStored: true, runsStarted: 0, stillAsked: [] as unknown[][], startedIn: [] as unknown[], revalidated: [] as string[], check: { ok: true } as Record<string, unknown>, stored: true, platformKey: false, onUsLeft: true, startOptions: [] as Record<string, unknown>[], planGone: false }));

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
vi.mock("../../../server/log.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/log.ts")>()),
  logError: async (message: string) => void state.logged.push(message),
}));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1", ...(state.platformKey ? { setup: { apiKey: "sk-or-v1-" + "p".repeat(40), model: "m" } } : {}) }) }));
vi.mock("../../../projects/projects.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../projects/projects.ts")>();
  return {
    ...original,
    projectExists: async () => state.projectInWorkspace,
    planOf: async (_tx: unknown, _org: string, _project: string, planId?: string) => {
      if (state.planGone) throw new original.PlanNotFound();
      return { id: planId ?? "plan-1", name: "Plan 1" };
    },
  };
});
vi.mock("../../../llm/providers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../llm/providers.ts")>()),
  checkModelCall: async () => { state.keyChecks++; return state.check; },
}));
vi.mock("../../../credentials/credentials.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../credentials/credentials.ts")>()),
  setModelKey: async () => { state.keysSaved++; },
  modelKey: async () => (state.stored ? { provider: "openrouter", key: "sk-or-v1-" + "s".repeat(40), baseUrl: null } : null),
  modelKeyHint: async () => null,
  keyStillStored: async (...args: unknown[]) => { state.stillAsked.push(args); return state.keyStillStored; },
}));
vi.mock("../../../llm/prices.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../llm/prices.ts")>()),
  priceFor: async () => null,
}));
vi.mock("../../../runs/runs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runs/runs.ts")>()),
  personWithoutAccount: async () => state.without,
  refusalToStart: async () => state.startRefusal ?? null,
  firstRunOnUsLeft: async () => state.onUsLeft,
  startRun: async (tx: unknown, _org: string, _project: string, _keys: unknown, options: Record<string, unknown>) => { if (state.startFails) throw state.startFails; state.startedIn.push(tx); state.startOptions.push(options); state.runsStarted++; return { id: "run-1", number: 1 }; },
}));

const { modelsForKeyAction, startRunAction } = await import("./actions.ts");
const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its model key.";
const PROJECT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY = "sk-or-v1-" + "k".repeat(40);
const startForm = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ projectId: PROJECT, planId: "pl1", model: "deepseek/deepseek-v4.1-flash", budget: "2", authorised: "on", ...fields })) form.set(k, v);
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
  state.check = { ok: true };
  state.stored = true;
  state.startRefusal = null;
  state.startFails = null;
  state.logged = [];
  state.platformKey = false;
  state.onUsLeft = true;
  state.startOptions = [];
  state.planGone = false;
});

test("the first run on Trawler starts without a key, on the fixed model and cap whatever the form says, paid by Trawler", async () => {
  state.platformKey = true;
  state.stored = false;
  const asThePanelSendsIt = startForm({ onUs: "1" });
  asThePanelSendsIt.delete("model");
  asThePanelSendsIt.delete("budget");
  await expect(startRunAction({}, asThePanelSendsIt)).rejects.toMatchObject({ to: "/runs/0001" });
  await expect(startRunAction({}, startForm({ onUs: "1", model: "openai/gpt-5-pro", budget: "50" }))).rejects.toMatchObject({ to: "/runs/0001" });
  expect(state.keyChecks).toBe(0);
  expect(state.keysSaved).toBe(0);
  const onTrawler = expect.objectContaining({ agentModel: "deepseek/deepseek-v4.1-flash", judgeModel: "deepseek/deepseek-v4.1-flash", budgetUsd: 1, provider: "openrouter", providerBaseUrl: null, paidBy: "trawler", createdBy: "member-1" });
  expect(state.startOptions).toEqual([onTrawler, onTrawler]);
});

test("the first run on Trawler is refused plainly when this server has no platform key, or the workspace has used it, and nothing starts", async () => {
  state.stored = false;
  expect(await startRunAction({}, startForm({ onUs: "1" }))).toEqual({ error: "Trawler cannot pay for runs on this server. Add a model key to start." });
  state.platformKey = true;
  state.onUsLeft = false;
  expect(await startRunAction({}, startForm({ onUs: "1" }))).toEqual({ error: "This workspace has used its first run on Trawler. Add a model key to start more runs." });
  const { FirstRunOnUsUsed } = await vi.importActual<typeof import("../../../runs/runs.ts")>("../../../runs/runs.ts");
  state.onUsLeft = true;
  state.startFails = new FirstRunOnUsUsed();
  expect(await startRunAction({}, startForm({ onUs: "1" }))).toEqual({ error: "This workspace has used its first run on Trawler. Add a model key to start more runs.", refused: true });
  expect(state.runsStarted).toBe(0);
  expect(state.logged).toEqual([]);
});

test("a run started with a key is paid by the workspace", async () => {
  await expect(startRunAction({}, startForm())).rejects.toMatchObject({ to: "/runs/0001" });
  expect(state.startOptions).toEqual([expect.objectContaining({ paidBy: "workspace", budgetUsd: 2 })]);
});

test("a refusal that arrives while the run starts, such as a pause at that moment, is shown as it is and not logged", async () => {
  const { RunRefused } = await vi.importActual<typeof import("../../../runs/runs.ts")>("../../../runs/runs.ts");
  state.startFails = new RunRefused("Runs on this project are paused. Resume them on the project's page, then start again.");
  expect(await startRunAction({}, startForm())).toEqual({ error: "Runs on this project are paused. Resume them on the project's page, then start again.", refused: true });
  expect(state.logged).toEqual([]);
});

test("Start refuses before any key check while the project has a live run, and names that run", async () => {
  const { RunInProgress } = await vi.importActual<typeof import("../../../runs/runs.ts")>("../../../runs/runs.ts");
  state.startRefusal = new RunInProgress({ id: "live-run", number: 7 });
  expect(await startRunAction({}, startForm())).toEqual({ error: "Run 0007 is still going on this project. Wait for it to finish or stop it, then start again.", refused: true, activeRun: { id: "live-run", number: 7 } });
  expect(state.keyChecks).toBe(0);
  expect(state.runsStarted).toBe(0);
});

test("Start refuses a paused project, a spent monthly budget or paused hosted runs with the reason, before any key check", async () => {
  const { RunRefused } = await vi.importActual<typeof import("../../../runs/runs.ts")>("../../../runs/runs.ts");
  state.startRefusal = new RunRefused("Trawler has paused hosted runs for now. Try again later, or run it on your own machine with the local runner.");
  expect(await startRunAction({}, startForm())).toEqual({ error: "Trawler has paused hosted runs for now. Try again later, or run it on your own machine with the local runner.", refused: true });
  expect(state.keyChecks).toBe(0);
});

test("a refusal about the key or the base URL names that field, so the page can tie the message to it; other refusals name none", async () => {
  state.member = { userId: "owner-1", email: "owner@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
  state.stored = false;
  expect(await startRunAction({}, startForm())).toEqual({ error: "Paste an API key from your model provider to start.", field: "key" });
  expect(await startRunAction({}, startForm({ apiKey: "not a key at all, just words" }))).toEqual({ error: "That does not look like an API key. Copy it again from your provider.", field: "key" });
  expect(await startRunAction({}, startForm({ apiKey: KEY, provider: "custom", baseUrl: "http://models.acme.test/v1" }))).toMatchObject({ field: "baseUrl" });
  state.stored = true;
  state.check = { ok: false, reason: "key", detail: "User not found." };
  expect(await startRunAction({}, startForm({ apiKey: KEY }))).toEqual({ error: "OpenRouter did not accept this key (User not found.).", field: "key" });
  state.check = { ok: false, reason: "model" };
  expect(await startRunAction({}, startForm({ apiKey: KEY }))).toEqual({ error: "This key cannot use deepseek/deepseek-v4.1-flash. Pick another model." });
  state.check = { ok: false, reason: "unavailable" };
  expect(await startRunAction({}, startForm({ apiKey: KEY }))).toEqual({ error: "OpenRouter could not be reached to check the key. Try again in a moment." });
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
  await expect(startRunAction({}, startForm())).rejects.toMatchObject({ to: "/runs/0001" });
  expect(state.runsStarted).toBe(1);
  expect(state.stillAsked).toEqual([[state.startedIn[0], "org-1", "openrouter", null]]);
  expect(state.stillAsked[0]![0]).toBe(state.startedIn[0]);
});

test("Start refuses before checking the key while a signing-in person has no account", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "owner" };
  state.without = "Maya";
  state.keyChecks = 0;
  expect(await startRunAction({}, startForm({ apiKey: KEY }))).toEqual({ error: "Maya needs a test account to sign in." });
  expect(state.keyChecks).toBe(0);
  expect(state.keysSaved).toBe(0);
  state.without = null;
});

test("key checks for new runs are limited to 30 per person and 60 per workspace in 10 minutes, and a refusal before the check does not count", async () => {
  const busy = (userId: string, orgId: string) => ({ userId, email: `${userId}@acme.test`, orgId, orgName: "Acme", role: "owner" });
  state.member = busy("busy-1", "org-busy");
  for (let i = 0; i < 40; i++) expect(await startRunAction({}, startForm({ budget: "0" }))).toEqual({ error: "Set a cap between $0.10 and $50." });
  state.check = { ok: false, reason: "model" };
  for (let i = 0; i < 30; i++) expect(await startRunAction({}, startForm())).toEqual({ error: "This key cannot use deepseek/deepseek-v4.1-flash. Pick another model." });
  expect(await startRunAction({}, startForm())).toEqual({ error: "You have checked the model key too often in the last 10 minutes. Try again in 10 minutes." });
  expect(state.keyChecks).toBe(30);

  state.member = busy("busy-2", "org-busy");
  for (let i = 0; i < 30; i++) await startRunAction({}, startForm());
  expect(state.keyChecks).toBe(60);
  state.member = busy("busy-3", "org-busy");
  expect(await startRunAction({}, startForm())).toEqual({ error: "This workspace's model key was checked too often in the last 10 minutes. Try again in 10 minutes." });
  state.member = busy("quiet-1", "org-quiet");
  expect(await startRunAction({}, startForm())).toEqual({ error: "This key cannot use deepseek/deepseek-v4.1-flash. Pick another model." });
  expect(state.keyChecks).toBe(61);
});

test("a run starts from the plan the form names, and nothing starts without one, or when that plan was removed", async () => {
  state.platformKey = false;
  await expect(startRunAction({}, startForm({ planId: "11111111-1111-4111-8111-111111111111" }))).rejects.toMatchObject({ to: "/runs/0001" });
  expect(state.startOptions).toEqual([expect.objectContaining({ planId: "11111111-1111-4111-8111-111111111111" })]);
  state.startOptions = [];
  expect(await startRunAction({}, startForm({ planId: "" }))).toEqual({ error: "Reload the page and start the run from a plan." });
  state.planGone = true;
  expect(await startRunAction({}, startForm())).toEqual({ error: "This plan was removed. Reload the page and choose another." });
  expect(state.startOptions).toEqual([]);
  expect(state.runsStarted).toBe(1);
});
