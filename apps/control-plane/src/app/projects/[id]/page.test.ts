import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({
  member: null as { userId: string; name: string; email: string; orgId: string; orgName: string; role: string } | null,
  runs: 0, counted: [] as Array<[string, string]>, tenants: [] as string[], shells: [] as string[], planned: [] as Array<Record<string, unknown>>,
  runState: { paused: false, liveRun: null } as { paused: boolean; liveRun: { id: string; number: number } | null },
  refusal: null as Error | null,
  plans: [] as Array<{ id: string; name: string; features: string[]; people: number }>,
  platformKey: true, onUsLeft: true, refusalFor: [] as unknown[], people: 0, beta: undefined as string[] | undefined,
}));
const ID = vi.hoisted(() => "0f8fad5b-d9cb-469f-a165-70867728950e");
const FREE = vi.hoisted(() => ({ plan: "free" as const, limits: { projects: 1, runsPerDay: 3, people: 4 } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  unstable_isUnrecognizedActionError: () => false,
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/auth.ts", () => ({
  signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null),
  canManageBilling: () => false,
}));
vi.mock("../../../server/shell.ts", () => ({
  shellFor: async (member: Member) => {
    state.shells.push(member.orgId);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [{ id: ID, name: "Acme", address: "app.acme.test" }, { id: "other", name: "Globex", address: "shop.globex.test" }], runs: 60 } };
  },
}));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../credentials/credentials.ts", () => ({ modelKeyHint: async () => null }));
const PLANS = [{ id: "11111111-1111-4111-8111-111111111111", name: "Plan 1", features: ["Send an invoice"], people: 2 }, { id: "22222222-2222-4222-8222-222222222222", name: "Plan 2", features: [], people: 1 }];
vi.mock("../../../projects/projects.ts", () => ({
  MAX_PLANS: 10,
  listPlans: async () => state.plans,
  projectForEditing: async (_tx: unknown, _orgId: string, id: string, planId?: string) => ({
    id, plan: { id: planId, name: state.plans.find((p) => p.id === planId)?.name }, name: "Acme", target_url: "https://app.acme.test/", docs_url: null, description: "Invoices.", focus: null, features: ["Send an invoice"], allowed_origins: [],
    personas: Array.from({ length: state.people }, (_, i) => ({ key: `p${i}`, name: `P${i}`, brief: "b", signs_in: false, account_ref: null })), goals: [], accounts: [], gates: [],
  }),
}));
vi.mock("../../../projects/overview.ts", async (original) => ({
  hostOf: (await original<typeof import("../../../projects/overview.ts")>()).hostOf,
  projectRunCount: async (_tx: unknown, orgId: string, id: string) => { state.counted.push([orgId, id]); return state.runs; },
}));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1", ...(state.platformKey ? { setup: { apiKey: "sk-or-v1-" + "p".repeat(40), model: "m" } } : {}), ...(state.beta ? { betaEmails: state.beta } : {}) }) }));
vi.mock("../../../runs/runs.ts", async (original) => ({
  RunInProgress: (await original<typeof import("../../../runs/runs.ts")>()).RunInProgress,
  TooManyPeople: (await original<typeof import("../../../runs/runs.ts")>()).TooManyPeople,
  firstRunOnUsLeft: async () => state.onUsLeft,
  projectRunState: async () => state.runState,
  refusalToStart: async (_tx: unknown, _org: string, _id: string, paidBy: unknown) => { state.refusalFor.push(paidBy); return state.refusal; },
}));
vi.mock("../../../runs/plans.ts", () => ({ workspacePlan: async () => FREE }));
vi.mock("./plan-workspace.tsx", () => ({ PlanWorkspace: (props: Record<string, unknown>) => { state.planned.push(props); return null; } }));

const { default: ProjectPage } = await import("./page.tsx");
const render = async (plan?: string) => renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve(plan ? { plan } : {}) }));

beforeEach(() => {
  state.member = { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };
  state.runs = 0;
  state.counted = [];
  state.tenants = [];
  state.shells = [];
  state.planned = [];
  state.runState = { paused: false, liveRun: null };
  state.refusal = null;
  state.platformKey = true;
  state.onUsLeft = true;
  state.refusalFor = [];
  state.people = 0;
  state.plans = [...PLANS];
  state.beta = undefined;
});

test("while the beta list is set, an account outside it is told so on the Start panel before Start, and one on it, or any account without a list, is not", async () => {
  state.beta = ["lee@acme.test"];
  await render();
  state.beta = ["lee@acme.test", "ana@acme.test"];
  await render();
  state.member = { ...state.member!, email: "Ana@Acme.test" };
  await render();
  state.beta = undefined;
  await render();
  expect(state.planned.map((props) => props.closedBeta)).toEqual(["Hosted runs are in private beta. Write to contact@usetrawler.com to get access.", undefined, undefined, undefined]);
});

test("the Start panel offers the first run on Trawler while the workspace has not used it and this server can pay; refusals are judged for the run the panel will start", async () => {
  await render();
  state.onUsLeft = false;
  await render();
  state.onUsLeft = true;
  state.platformKey = false;
  await render();
  expect(state.planned.map((props) => props.firstRunOnUs)).toEqual([true, false, false]);
  expect(state.refusalFor).toEqual(["trawler", "workspace", "workspace"]);
});

test("a plan with more people than the first run on Trawler takes is judged as a run paid with a key", async () => {
  state.people = 5;
  await render();
  expect(state.planned[0]!.firstRunOnUs).toBe(true);
  expect(state.refusalFor).toEqual(["workspace"]);
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  state.member = null;
  await expect(ProjectPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.tenants).toEqual([]);
});

test("the plan is the page marked in the nav, under its project, and the nav is read for the signed-in workspace", async () => {
  const html = await render();
  const marked = (html.match(/<nav aria-label="Workspace".*?<\/nav>/)?.[0] ?? "").match(/<a [^>]*aria-current="[^"]*"[^>]*>/g) ?? [];
  expect(marked).toEqual([expect.stringMatching(new RegExp(`^<a href="/projects/${ID}" aria-current="page"`))]);
  expect(state.shells).toEqual(["org-1"]);
  expect(html).toContain(">Acme workspace</p>");
});

test("the plan is the project's Plan tab, next to its Runs with their number, without the setup steps", async () => {
  state.runs = 3;
  const html = await render();
  const tabs = html.match(/<nav aria-label="Project">.*?<\/nav>/)?.[0] ?? "";
  expect(tabs).toMatch(new RegExp(`<a href="/projects/${ID}" aria-current="page"[^>]*>Plan</a>`));
  expect(tabs).toMatch(new RegExp(`<a href="/projects/${ID}/runs" class="[^"]*">Runs<span[^>]*>3</span></a>`));
  expect(state.counted).toEqual([["org-1", ID]]);
  expect(html).not.toContain('aria-label="Progress"');
  expect(html).toMatch(new RegExp(`<a href="/projects/${ID}\\?plan=[0-9a-f-]+#start"[^>]*>New run<`));
  expect(html).toMatch(/>Project · <a href="https:\/\/app\.acme\.test\/"[^>]*>app\.acme\.test</);
});

test("the plan shows the features it was set up for, with a way to change them", async () => {
  const html = await render();
  expect(html).toContain("Send an invoice");
  expect(html).toMatch(new RegExp(`<a [^>]*href="/projects/${ID}/features\\?plan=[0-9a-f-]+"[^>]*>Change features</a>`));
});

test("a project without runs still offers its Runs tab, counted as none", async () => {
  const html = await render();
  expect(html).toContain(">Acme</h1>");
  expect(html).toMatch(new RegExp(`<a href="/projects/${ID}/runs" class="[^"]*">Runs<span[^>]*>0</span></a>`));
});

test("the Start panel is told whether the project has had a run, so the authorisation is asked only before the first", async () => {
  await render();
  state.runs = 3;
  await render();
  expect(state.planned.map((props) => props.authorisedBefore)).toEqual([false, true]);
});

test("the Start panel is told what refuses a start right now, with the live run to open", async () => {
  const { RunInProgress } = await vi.importActual<typeof import("../../../runs/runs.ts")>("../../../runs/runs.ts");
  state.refusal = new RunInProgress({ id: "live-run", number: 7 });
  await render();
  expect(state.planned[0]!.startRefusal).toEqual({ message: "Run 0007 is still going on this project. Wait for it to finish or stop it, then start again.", activeRun: { id: "live-run", number: 7 } });
  state.planned = [];
  state.refusal = null;
  await render();
  expect(state.planned[0]!.startRefusal).toBeUndefined();
});

test("a project whose run state cannot be read is not found", async () => {
  state.runState = null as unknown as typeof state.runState;
  await expect(render()).rejects.toMatchObject({ notFound: true });
});

test("the plan editor gets the workspace's plan, and too many people for it is left to the editor, which sees the plan as it is edited", async () => {
  const { TooManyPeople } = await import("../../../runs/runs.ts");
  state.refusal = new TooManyPeople(FREE, 5);
  renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) }));
  expect(state.planned[0]!.workspacePlan).toEqual(FREE);
  expect(state.planned[0]!.startRefusal).toBeUndefined();
});

test("the plan tab lists the project's plans, opens the one asked for and falls back to the first", async () => {
  const html = await render(PLANS[1]!.id);
  expect(html).toMatch(/<a [^>]*href="\/projects\/[^"]+\?plan=11111111-1111-4111-8111-111111111111"[^>]*>Plan 1/);
  expect(html).toMatch(/<a [^>]*href="[^"]+\?plan=22222222-2222-4222-8222-222222222222"[^>]*aria-current="page"[^>]*>Plan 2|<a [^>]*aria-current="page"[^>]*href="[^"]+\?plan=22222222-2222-4222-8222-222222222222"[^>]*>Plan 2/);
  expect(html).toContain("Add plan");
  expect(state.planned.at(-1)).toMatchObject({ planId: PLANS[1]!.id });
  await render("33333333-3333-4333-8333-333333333333");
  expect(state.planned.at(-1)).toMatchObject({ planId: PLANS[0]!.id });
});

test("a project with one plan cannot remove it", async () => {
  state.plans = [PLANS[0]!];
  const html = await render();
  expect(html).not.toContain("Remove plan");
  state.plans = [...PLANS];
  expect(await render()).toContain("Remove plan");
});
