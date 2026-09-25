import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { ProjectLine } from "../projects/overview.ts";

type Member = { userId: string; email: string; orgId: string };
const state = vi.hoisted(() => ({ member: null as Member | null, projects: [] as ProjectLine[], askedFor: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../server/auth.ts", () => ({ getAuth: () => ({ api: { getFullOrganization: async () => ({ name: "Acme workspace" }) } }), signedInMember: async () => state.member }));
vi.mock("../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.askedFor.push(`withOrg:${orgId}`); return work({}); } }));
vi.mock("../projects/overview.ts", () => ({ workspaceProjects: async (_tx: unknown, orgId: string) => { state.askedFor.push(`projects:${orgId}`); return state.projects; } }));

const { default: Home } = await import("./page.tsx");
const memberOf = (orgId: string): Member => ({ userId: "u1", email: "ana@acme.test", orgId });

beforeEach(() => {
  state.member = null;
  state.projects = [];
  state.askedFor = [];
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  await expect(Home()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.askedFor).toEqual([]);
});

test("a workspace without a project goes straight to a new project", async () => {
  state.member = memberOf("org-1");
  await expect(Home()).rejects.toMatchObject({ to: "/new" });
  expect(state.askedFor).toEqual(["withOrg:org-1", "projects:org-1"]);
});

test("a workspace with projects lands on its projects, read in its own organisation", async () => {
  state.member = memberOf("org-1");
  state.projects = [{ id: "p1", name: "Acme", targetUrl: "https://app.acme.test/", runs: 0, lastRun: null }];
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain(">Acme</a>");
  expect(html).toContain("Acme workspace");
  expect(html).toMatch(/<a href="\/"[^>]*aria-current="page"[^>]*>Projects<\/a>/);
  expect(state.askedFor).toEqual(["withOrg:org-1", "projects:org-1"]);
});
