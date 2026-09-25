import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { ProjectLine, RunLine } from "../projects/overview.ts";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, projects: [] as ProjectLine[], recent: [] as RunLine[], askedFor: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../server/shell.ts", () => ({
  shellFor: async (member: Member) => {
    state.askedFor.push(`shell:${member.orgId}`);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [], runs: 0 } };
  },
}));
vi.mock("../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.askedFor.push(`withOrg:${orgId}`); return work({}); } }));
vi.mock("../projects/overview.ts", async (original) => ({
  hostOf: (await original<typeof import("../projects/overview.ts")>()).hostOf,
  workspaceProjects: async (_tx: unknown, orgId: string) => { state.askedFor.push(`projects:${orgId}`); return state.projects; },
  workspaceRuns: async (_tx: unknown, orgId: string, options: { size?: number }) => { state.askedFor.push(`runs:${orgId}:${options.size}`); return { runs: state.recent, olderThan: null }; },
}));

const { default: Home } = await import("./page.tsx");
const memberOf = (orgId: string): Member => ({ userId: "u1", name: "Ana Lopez", email: "ana@acme.test", orgId, orgName: "Acme workspace", role: "member" });
const project: ProjectLine = { id: "p1", name: "Acme", targetUrl: "https://app.acme.test/", site: null, lastRun: null };
const recent: RunLine = {
  id: "r7", number: 7, status: "failed", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.4, tokenCap: null, tokensUsed: 0,
  confirmed: 0, goalsReached: 1, goalsTotal: 6, projectId: "p1", projectName: "Acme", projectSite: null,
};

beforeEach(() => {
  state.member = null;
  state.projects = [];
  state.recent = [];
  state.askedFor = [];
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  await expect(Home()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.askedFor).toEqual([]);
});

test("a workspace without a project goes straight to a new project", async () => {
  state.member = memberOf("org-1");
  await expect(Home()).rejects.toMatchObject({ to: "/new" });
  expect(state.askedFor).toEqual(["withOrg:org-1", "projects:org-1", "runs:org-1:3"]);
});

test("a workspace with projects lands on its overview, greeted by first name, read in its own organisation", async () => {
  state.member = memberOf("org-1");
  state.projects = [project];
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain(">Welcome back, Ana</p>");
  expect(html).toContain('<article aria-labelledby="project-p1"');
  expect(html).toContain(">Acme workspace</p>");
  expect(html).toMatch(/<a href="\/"[^>]*aria-current="page"[^>]*>(?:(?!<\/a>).)*Overview/);
  expect(state.askedFor).toEqual(["withOrg:org-1", "projects:org-1", "runs:org-1:3", "shell:org-1"]);
});

test("the workspace's newest runs reach the overview's line and its recent runs", async () => {
  state.member = memberOf("org-1");
  state.projects = [project];
  state.recent = [recent];
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain(">The latest run failed.</p>");
  expect(html).toMatch(/<section aria-labelledby="recent-runs".*href="\/runs\/r7"/);
});
