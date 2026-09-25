import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ member: null as { userId: string; email: string; orgId: string; orgName: string; role: string } | null, runs: 0, counted: [] as Array<[string, string]>, tenants: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/auth.ts", () => ({
  signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null),
  canManageBilling: () => false,
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
vi.mock("../../../projects/overview.ts", () => ({ projectRunCount: async (_tx: unknown, orgId: string, id: string) => { state.counted.push([orgId, id]); return state.runs; } }));
vi.mock("./plan-workspace.tsx", () => ({ PlanWorkspace: () => null }));

const { default: ProjectPage } = await import("./page.tsx");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const render = async () => renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id: ID }) }));

beforeEach(() => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };
  state.runs = 0;
  state.counted = [];
  state.tenants = [];
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  state.member = null;
  await expect(ProjectPage({ params: Promise.resolve({ id: ID }) })).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.tenants).toEqual([]);
});

test("a project with runs leads from its plan to all its runs", async () => {
  state.runs = 3;
  expect(await render()).toMatch(new RegExp(`<a href="/projects/${ID}/runs"[^>]*>All runs · 3</a>`));
  expect(state.counted).toEqual([["org-1", ID]]);
});

test("a project without runs has no link to an empty list", async () => {
  const html = await render();
  expect(html).toContain(">Acme</h1>");
  expect(html).not.toContain(`/projects/${ID}/runs`);
});
