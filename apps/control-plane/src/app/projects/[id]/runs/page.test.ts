import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Page = { before?: number };
const state = vi.hoisted(() => ({ signedIn: true, found: true, tenants: [] as string[], asked: [] as Array<{ orgId: string; projectId: string; page: Page }> }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../../server/auth.ts", () => ({
  getAuth: () => ({ api: {
    getSession: async () => (state.signedIn ? { user: { email: "ana@acme.test" }, session: { activeOrganizationId: "org-1" } } : null),
    getFullOrganization: async () => ({ name: "Acme workspace" }),
  } }),
}));
vi.mock("../../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../../projects/overview.ts", () => ({
  projectRuns: async (_tx: unknown, orgId: string, projectId: string, page: Page) => {
    state.asked.push({ orgId, projectId, page });
    return state.found ? { project: { id: projectId, name: "Acme", targetUrl: "https://app.acme.test/" }, runs: [], olderThan: null } : null;
  },
}));

const { default: ProjectRunsPage } = await import("./page.tsx");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const open = (id: string, before?: string | string[]) => ProjectRunsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ before }) });

beforeEach(() => {
  state.signedIn = true;
  state.found = true;
  state.tenants = [];
  state.asked = [];
});

test("the history is read for the signed-in workspace, from the page the address asks for", async () => {
  const html = renderToStaticMarkup(await open(ID, "40"));
  expect(state.tenants).toEqual(["org-1"]);
  expect(state.asked).toEqual([{ orgId: "org-1", projectId: ID, page: { before: 40 } }]);
  expect(html).toContain("There are no older runs.");
});

test("an address without a usable page starts from the newest runs", async () => {
  for (const before of [undefined, "0", "-3", "4.5", "abc", "2147483648", ["3", "4"]]) await open(ID, before);
  expect(state.asked.map((a) => a.page.before)).toEqual(Array(7).fill(undefined));
});

test("a project of another workspace is not found", async () => {
  state.found = false;
  await expect(open(ID)).rejects.toMatchObject({ notFound: true });
});

test("a malformed project address is not found without reaching the database", async () => {
  await expect(open("not-a-uuid")).rejects.toMatchObject({ notFound: true });
  expect(state.tenants).toEqual([]);
  expect(state.asked).toEqual([]);
});

test("a visitor who is not signed in is sent to sign in", async () => {
  state.signedIn = false;
  await expect(open(ID)).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.asked).toEqual([]);
});
