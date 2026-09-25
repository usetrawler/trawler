import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { RunLine } from "../../../../projects/overview.ts";

type Asked = { orgId: string; projectId?: string; show?: string; before?: number };
const state = vi.hoisted(() => ({
  signedIn: true, found: true, runs: [] as RunLine[], olderThan: null as number | null,
  tenants: [] as string[], heads: [] as Array<[string, string]>, asked: [] as Array<{ orgId: string; projectId?: string; show?: string; before?: number }>,
  counted: [] as Array<[string, string | undefined]>, shells: [] as Array<string | null | undefined>,
}));
const ID = vi.hoisted(() => "0f8fad5b-d9cb-469f-a165-70867728950e");

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../../server/auth.ts", () => ({
  signedInMember: async (headers: Headers) => (state.signedIn && headers.get("cookie") === "session=ana" ? { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" } : null),
}));
vi.mock("../../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../../server/shell.ts", () => ({
  shellFor: async (member: { name: string; email: string; orgId: string; orgName: string }) => {
    state.shells.push(member.orgId);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [{ id: ID, name: "Acme", address: "app.acme.test" }], runs: 60 } };
  },
}));
vi.mock("../../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../../projects/overview.ts", async (original) => ({
  hostOf: (await original<typeof import("../../../../projects/overview.ts")>()).hostOf,
  projectHead: async (_tx: unknown, orgId: string, projectId: string) => {
    state.heads.push([orgId, projectId]);
    return state.found ? { id: projectId, name: "Acme", targetUrl: "https://app.acme.test/" } : null;
  },
  workspaceRuns: async (_tx: unknown, orgId: string, options: Omit<Asked, "orgId">) => {
    state.asked.push({ orgId, ...options });
    return { runs: state.runs, olderThan: state.olderThan };
  },
  runCounts: async (_tx: unknown, orgId: string, projectId?: string) => {
    state.counted.push([orgId, projectId]);
    return { all: 3, completed: 1, attention: 2 };
  },
}));

const { default: ProjectRunsPage } = await import("./page.tsx");
const open = (id: string, search: { show?: string | string[]; before?: string | string[] } = {}) => ProjectRunsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) });
const run: RunLine = {
  id: "r12", number: 12, status: "failed", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.2, tokenCap: null, tokensUsed: 0,
  confirmed: 0, goalsReached: 0, goalsTotal: 3, projectId: ID, projectName: "Acme", projectSite: null,
};

beforeEach(() => {
  state.signedIn = true;
  state.found = true;
  state.runs = [];
  state.olderThan = null;
  state.tenants = [];
  state.heads = [];
  state.asked = [];
  state.counted = [];
  state.shells = [];
});

test("the project's runs are the workspace's history narrowed to it, read in the signed-in workspace, with the address's filter and page", async () => {
  const html = renderToStaticMarkup(await open(ID, { show: "completed", before: "40" }));
  expect(state.tenants).toEqual(["org-1"]);
  expect(state.heads).toEqual([["org-1", ID]]);
  expect(state.asked).toEqual([{ orgId: "org-1", projectId: ID, show: "completed", before: 40 }]);
  expect(state.counted).toEqual([["org-1", ID]]);
  expect(state.shells).toEqual(["org-1"]);
  expect(html).toMatch(/>Project · <a href="https:\/\/app\.acme\.test\/" target="_blank"[^>]*>app\.acme\.test</);
  expect(html).not.toContain("Back to the plan");
  expect(html).toContain(">Acme</h1>");
  expect(html).toContain(">Acme workspace</p>");
  expect(html).toMatch(new RegExp(`<a href="/projects/${ID}/runs\\?show=completed" aria-current="page"`));
  expect(html).toContain("There are no older runs here.");
});

test("the runs, the project's counts and the next page reach the list, each row led by its date", async () => {
  state.runs = [run];
  state.olderThan = 12;
  const html = renderToStaticMarkup(await open(ID, { show: "attention" }));
  expect(html).toContain('href="/runs/r12"');
  expect(html).not.toContain(">Acme</strong>");
  expect(html).toMatch(/>All <span[^>]*>3<\/span>.*>Completed <span[^>]*>1<\/span>.*>Needs attention <span[^>]*>2<\/span>/);
  expect(html).toContain(`<a href="/projects/${ID}/runs?show=attention&amp;before=12"`);
});

test("the project is marked in the nav as the section the page belongs to, the Runs tab is the page, and a new run starts at the plan's Start", async () => {
  const html = renderToStaticMarkup(await open(ID));
  expect(html).toMatch(new RegExp(`<nav aria-label="Workspace".*<a href="/projects/${ID}" aria-current="true"`));
  const tabs = html.match(/<nav aria-label="Project">.*?<\/nav>/)?.[0] ?? "";
  expect(tabs).toMatch(new RegExp(`<a href="/projects/${ID}" class="[^"]*">Plan</a>`));
  expect(tabs).toMatch(new RegExp(`<a href="/projects/${ID}/runs" aria-current="page"[^>]*>Runs<span[^>]*>3</span></a>`));
  expect(html).toMatch(new RegExp(`<a href="/projects/${ID}#start"[^>]*>New run<`));
  expect(html).not.toContain("Back to the plan");
});

test("an address without a usable page starts from the newest runs", async () => {
  for (const before of [undefined, "0", "-3", "4.5", "abc", "2147483648", ["3", "4"]]) await open(ID, { before });
  expect(state.asked.map((a) => a.before)).toEqual(Array(7).fill(undefined));
});

test("a project of another workspace is not found, and its runs are not read", async () => {
  state.found = false;
  await expect(open(ID)).rejects.toMatchObject({ notFound: true });
  expect(state.asked).toEqual([]);
  expect(state.counted).toEqual([]);
});

test("a malformed project address is not found without reaching the database", async () => {
  await expect(open("not-a-uuid")).rejects.toMatchObject({ notFound: true });
  expect(state.tenants).toEqual([]);
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  state.signedIn = false;
  await expect(open(ID)).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.tenants).toEqual([]);
  expect(state.asked).toEqual([]);
});
