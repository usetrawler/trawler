import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({
  member: null as { userId: string; name: string; email: string; orgId: string; orgName: string; role: string } | null,
  runs: 0, counted: [] as Array<[string, string]>, tenants: [] as string[], shells: [] as string[], planned: [] as Array<Record<string, unknown>>,
}));
const ID = vi.hoisted(() => "0f8fad5b-d9cb-469f-a165-70867728950e");

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
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
vi.mock("../../../projects/projects.ts", () => ({
  projectForEditing: async (_tx: unknown, _orgId: string, id: string) => ({
    id, name: "Acme", target_url: "https://app.acme.test/", docs_url: null, description: "Invoices.", focus: null, allowed_origins: [],
    personas: [], goals: [], accounts: [], gates: [],
  }),
}));
vi.mock("../../../projects/overview.ts", async (original) => ({
  hostOf: (await original<typeof import("../../../projects/overview.ts")>()).hostOf,
  projectRunCount: async (_tx: unknown, orgId: string, id: string) => { state.counted.push([orgId, id]); return state.runs; },
}));
vi.mock("./plan-workspace.tsx", () => ({ PlanWorkspace: (props: Record<string, unknown>) => { state.planned.push(props); return null; } }));

const { default: ProjectPage } = await import("./page.tsx");
const render = async () => renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id: ID }) }));

beforeEach(() => {
  state.member = { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };
  state.runs = 0;
  state.counted = [];
  state.tenants = [];
  state.shells = [];
  state.planned = [];
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  state.member = null;
  await expect(ProjectPage({ params: Promise.resolve({ id: ID }) })).rejects.toMatchObject({ to: "/sign-in" });
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
  expect(html).toMatch(new RegExp(`<a href="/projects/${ID}#start"[^>]*>New run<`));
  expect(html).toMatch(/>Project · <a href="https:\/\/app\.acme\.test\/"[^>]*>app\.acme\.test</);
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
