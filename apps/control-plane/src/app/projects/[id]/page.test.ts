import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ runs: 0, counted: [] as Array<[string, string]> }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/auth.ts", () => ({
  getAuth: () => ({ api: {
    getSession: async () => ({ user: { email: "ana@acme.test" }, session: { activeOrganizationId: "org-1" } }),
    getFullOrganization: async () => ({ name: "Acme workspace" }),
  } }),
  canManageBilling: async () => false,
}));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _orgId: string, work: (tx: unknown) => unknown) => work({}) }));
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
  state.runs = 0;
  state.counted = [];
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
