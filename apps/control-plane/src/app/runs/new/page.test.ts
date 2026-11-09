import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const ACME = vi.hoisted(() => "0f8fad5b-d9cb-469f-a165-70867728950e");
const GLOBEX = vi.hoisted(() => "1f8fad5b-d9cb-469f-a165-70867728950e");
const PLANS = vi.hoisted(() => [{ id: "11111111-1111-4111-8111-111111111111", name: "Plan 1", features: [], people: 2 }, { id: "22222222-2222-4222-8222-222222222222", name: "Plan 2", features: [], people: 1 }]);
const FREE = vi.hoisted(() => ({ plan: "free" as const, limits: { projects: 1, runsPerDay: 3, people: 4 } }));
const state = vi.hoisted(() => ({
  member: null as Member | null,
  projects: [] as Array<{ id: string; name: string; address: string | null }>,
  plans: [] as Array<{ id: string; name: string; features: string[]; people: number }>,
  target: "https://app.acme.test/",
  people: [] as Array<{ key: string; name: string; brief: string; signs_in: boolean; account_ref: string | null }>,
  accounts: [] as Array<{ ref: string; username: string; password_hint: string }>,
  runs: 0, onUsLeft: true, platformKey: true, refusal: null as Error | null, refusalFor: [] as unknown[], beta: undefined as string[] | undefined,
  runState: { paused: false, liveRun: null } as { paused: boolean; liveRun: { id: string; number: number } | null } | null,
  confirmedAt: null as Date | null,
  started: [] as Array<Record<string, unknown>>, ci: [] as Array<Record<string, unknown>>, edited: [] as Array<[string, string | undefined]>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null), canManageBilling: () => false }));
vi.mock("../../../server/shell.ts", () => ({ shellFor: async (member: Member) => ({ user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: state.projects } }) }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _orgId: string, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("../../../credentials/credentials.ts", () => ({ modelKeyHint: async () => null }));
vi.mock("../../../projects/projects.ts", () => ({
  listPlans: async () => state.plans,
  projectForEditing: async (_tx: unknown, _orgId: string, id: string, planId?: string) => {
    state.edited.push([id, planId]);
    return { id, plan: { id: planId, name: state.plans.find((p) => p.id === planId)?.name }, name: id === ACME ? "Acme" : "Globex", target_url: state.target, personas: state.people, goals: state.people.map((p, i) => ({ key: `g${i}`, instruction: "Look.", persona_key: p.key })), accounts: state.accounts };
  },
}));
vi.mock("../../../projects/overview.ts", () => ({ projectRunCount: async () => state.runs, testingConfirmedAt: async () => state.confirmedAt }));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ ...(state.platformKey ? { setup: { apiKey: "sk", model: "m" } } : {}), ...(state.beta ? { betaEmails: state.beta } : {}) }) }));
vi.mock("../../../runs/runs.ts", async (original) => ({
  RunInProgress: (await original<typeof import("../../../runs/runs.ts")>()).RunInProgress,
  TooManyPeople: (await original<typeof import("../../../runs/runs.ts")>()).TooManyPeople,
  firstRunOnUsLeft: async () => state.onUsLeft,
  projectRunState: async () => state.runState,
  refusalToStart: async (_tx: unknown, _org: string, _id: string, paidBy: unknown) => { state.refusalFor.push(paidBy); return state.refusal; },
}));
vi.mock("../../../runs/plans.ts", () => ({ workspacePlan: async () => FREE }));
vi.mock("../../projects/[id]/start-run.tsx", () => ({ StartRun: (props: Record<string, unknown>) => { state.started.push(props); return null; } }));
vi.mock("../../projects/[id]/ci-only.tsx", () => ({ CiOnlyPanel: (props: Record<string, unknown>) => { state.ci.push(props); return null; } }));

const { default: StartPage } = await import("./page.tsx");
const render = async (search: { project?: string; plan?: string } = {}) => renderToStaticMarkup(await StartPage({ searchParams: Promise.resolve(search) }));
const person = (key: string, name: string, extra: { signs_in?: boolean; account_ref?: string | null } = {}) => ({ key, name, brief: "b", signs_in: false, account_ref: null, ...extra });

beforeEach(() => {
  Object.assign(state, {
    member: { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" },
    projects: [{ id: ACME, name: "Acme", address: "app.acme.test" }, { id: GLOBEX, name: "Globex", address: "shop.globex.test" }],
    plans: [...PLANS], target: "https://app.acme.test/", people: [person("ama", "Ama"), person("kwame", "Kwame")], accounts: [],
    runs: 0, onUsLeft: true, platformKey: true, refusal: null, refusalFor: [], beta: undefined, runState: { paused: false, liveRun: null }, confirmedAt: null,
    started: [], ci: [], edited: [],
  });
});

test("New run opens one page that picks the project and plan, the first of each unless the address names others", async () => {
  const html = await render();
  expect(html).toContain(">Start run</h1>");
  expect(state.edited).toEqual([[ACME, PLANS[0]!.id]]);
  expect(html).toMatch(/<form [^>]*action="\/runs\/new" method="get">/);
  expect(html).toMatch(new RegExp(`<option value="${ACME}" selected="">Acme · app\\.acme\\.test</option><option value="${GLOBEX}">Globex · shop\\.globex\\.test</option>`));
  expect(html).toContain(">Plan 1 · 2 people</option>");
  await render({ project: GLOBEX, plan: PLANS[1]!.id });
  expect(state.edited.at(-1)).toEqual([GLOBEX, PLANS[1]!.id]);
  await render({ project: "unknown", plan: "unknown" });
  expect(state.edited.at(-1)).toEqual([ACME, PLANS[0]!.id]);
  expect(state.started.at(-1)).toMatchObject({ projectId: ACME, planId: PLANS[0]!.id, personas: 2, goalsPerTurn: [1, 1] });
});

test("before a workspace has a project, New run sends it to add one, and a visitor who is not signed in to sign in", async () => {
  state.projects = [];
  await expect(render()).rejects.toMatchObject({ to: "/new" });
  state.member = null;
  await expect(render()).rejects.toMatchObject({ to: "/sign-in" });
});

test("it says how each person gets in, warns about one who needs a test account, and Start refuses until they have one", async () => {
  state.accounts = [{ ref: "a1", username: "kwame@acme.test", password_hint: "…1234" }];
  state.people = [person("ama", "Ama"), person("kwame", "Kwame", { signs_in: true, account_ref: "a1" }), person("priya", "Priya", { signs_in: true })];
  const html = await render();
  const who = html.slice(html.indexOf('id="who-signs-in"'));
  expect(who).toMatch(/>Ama<\/span><span class="text-sm text-muted">Signs up as a new user</);
  expect(who).toMatch(/>Kwame<\/span><span class="text-sm text-muted">Signs in as kwame@acme\.test</);
  expect(who).toMatch(/>Priya<\/span><span class="text-sm text-warn">Needs a test account to sign in</);
  expect(who).toContain(`href="/projects/${ACME}?plan=${PLANS[0]!.id}"`);
  expect(state.started.at(-1)!.blocked).toBe("Priya needs a test account to sign in.");
});

test("Start refuses while the plan has more people than the workspace's plan takes", async () => {
  state.people = Array.from({ length: 5 }, (_, i) => person(`p${i}`, `P${i}`));
  await render();
  expect(state.started[0]!.blocked).toMatch(/^The Free plan takes up to 4 people in a run, and the plan on this project has 5\./);
});

test("the authorisation is asked only before the project's first run, or until testing was confirmed", async () => {
  await render();
  state.runs = 3;
  await render();
  state.runs = 0;
  state.confirmedAt = new Date("2026-10-01T00:00:00Z");
  await render();
  expect(state.started.map((props) => props.authorisedBefore)).toEqual([false, true, true]);
});

test("Start is told what refuses a start right now, with the live run to open", async () => {
  const { RunInProgress } = await vi.importActual<typeof import("../../../runs/runs.ts")>("../../../runs/runs.ts");
  state.refusal = new RunInProgress({ id: "live-run", number: 7 });
  await render();
  expect(state.started[0]!.refusal).toEqual({ message: "Run 0007 is still going on this project. Wait for it to finish or stop it, then start again.", activeRun: { id: "live-run", number: 7 } });
});

test("the first run on Trawler is offered while the workspace has not used it and this server can pay, and refusals are judged for the run Start will begin", async () => {
  await render();
  state.onUsLeft = false;
  await render();
  state.onUsLeft = true;
  state.platformKey = false;
  await render();
  expect(state.started.map((props) => props.firstRunOnUs)).toEqual([true, false, false]);
  expect(state.refusalFor).toEqual(["trawler", "workspace", "workspace"]);
  state.refusalFor = [];
  state.platformKey = true;
  state.people = Array.from({ length: 5 }, (_, i) => person(`p${i}`, `P${i}`));
  await render();
  expect(state.refusalFor).toEqual(["workspace"]);
});

test("an account outside the beta list is told so on Start", async () => {
  state.beta = ["lee@acme.test"];
  await render();
  state.beta = undefined;
  await render();
  expect(state.started.map((props) => props.closedBeta)).toEqual(["Hosted runs are in private beta. Write to contact@usetrawler.com to get access.", undefined]);
});

test("a product on a private network is run from CI: the page says so, the CI panel asks for the authorisation, and no account is called missing", async () => {
  state.target = "http://localhost:8080/";
  state.people = [person("priya", "Priya", { signs_in: true })];
  const html = await render();
  expect(html).toContain(">Run from CI</h1>");
  expect(state.started).toEqual([]);
  expect(state.ci[0]).toMatchObject({ projectId: ACME, host: "localhost:8080", confirmedAt: null });
  expect(html).toContain("In CI the job can give the people their accounts");
  expect(html).toMatch(/>Priya<\/span><span class="text-sm text-muted">Needs a test account to sign in</);
});

test("a project whose runs are paused says so and offers nothing to start", async () => {
  state.runState = { paused: true, liveRun: { id: "r", number: 9 } };
  const html = await render();
  expect(html).toMatch(/Runs on this project are paused, and <a href="\/runs\/0009"[^>]*>Run 0009<\/a> is still stopping/);
  expect(state.started).toEqual([]);
  expect(state.ci).toEqual([]);
});

test("a paused product on a private network still offers the CI authorisation, which pausing does not touch", async () => {
  state.target = "http://localhost:8080/";
  state.runState = { paused: true, liveRun: null };
  const html = await render();
  expect(state.ci).toHaveLength(1);
  expect(html).not.toContain("Runs on this project are paused");
});

test("each project's start panel is its own, so nothing confirmed or typed for one carries over when the picker switches to another", async () => {
  const keyed = (tree: unknown, name: string): unknown[] => {
    if (Array.isArray(tree)) return tree.flatMap((t) => keyed(t, name));
    if (!tree || typeof tree !== "object") return [];
    const node = tree as { type?: { name?: string }; key?: unknown; props?: { children?: unknown } };
    return [...(node.type?.name === name ? [node.key] : []), ...keyed(node.props?.children, name)];
  };
  state.target = "http://localhost:8080/";
  expect(keyed(await StartPage({ searchParams: Promise.resolve({ project: GLOBEX }) }), "CiOnlyPanel")).toEqual([GLOBEX]);
  state.target = "https://app.acme.test/";
  expect(keyed(await StartPage({ searchParams: Promise.resolve({ project: ACME, plan: PLANS[1]!.id }) }), "StartRun")).toEqual([PLANS[1]!.id]);
});
