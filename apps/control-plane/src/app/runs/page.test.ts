import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { RunLine } from "../../projects/overview.ts";

type Asked = { orgId: string; show?: string; before?: number; projectId?: string };
const state = vi.hoisted(() => ({
  orgId: "org-1" as string | null, signedIn: true, projects: [] as Array<{ id: string; name: string; address: string }>,
  runs: [] as RunLine[], olderThan: null as number | null,
  asked: [] as Array<{ orgId: string; show?: string; before?: number; projectId?: string }>, counted: [] as Array<[string, string | undefined]>, tenants: [] as string[], shells: [] as Array<string | null | undefined>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  signedInMember: async (headers: Headers) => (state.signedIn && state.orgId && headers.get("cookie") === "session=ana" ? { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: state.orgId, orgName: "Acme workspace", role: "member" } : null),
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../server/shell.ts", () => ({
  shellFor: async (member: { name: string; email: string; orgId: string; orgName: string }) => {
    state.shells.push(member.orgId);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: state.projects, runs: 60 } };
  },
}));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../projects/overview.ts", () => ({
  workspaceRuns: async (_tx: unknown, orgId: string, options: Omit<Asked, "orgId">) => {
    state.asked.push({ orgId, ...options });
    return { runs: state.runs, olderThan: state.olderThan };
  },
  runCounts: async (_tx: unknown, orgId: string, projectId?: string) => {
    state.counted.push([orgId, projectId]);
    return { all: 60, completed: 48, attention: 11 };
  },
}));

const { default: RunsPage } = await import("./page.tsx");
const open = (search: { show?: string | string[]; before?: string | string[] } = {}) => RunsPage({ searchParams: Promise.resolve(search) });
const run: RunLine = {
  id: "r12", number: 12, status: "failed", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.2, tokenCap: null, tokensUsed: 0,
  confirmed: 0, goalsReached: 0, goalsTotal: 3, projectId: "p1", projectName: "Acme", projectSite: null,
};

beforeEach(() => {
  state.orgId = "org-1";
  state.signedIn = true;
  state.projects = [{ id: "p1", name: "Acme", address: "app.acme.test" }, { id: "p2", name: "Globex", address: "shop.globex.test" }];
  state.runs = [];
  state.olderThan = null;
  state.asked = [];
  state.counted = [];
  state.tenants = [];
  state.shells = [];
});

test("the workspace's runs and counts are read in its own organisation, with the filter and page the address asks for", async () => {
  const html = renderToStaticMarkup(await open({ show: "attention", before: "40" }));
  expect(state.tenants).toEqual(["org-1"]);
  expect(state.asked).toEqual([{ orgId: "org-1", show: "attention", before: 40 }]);
  expect(state.counted).toEqual([["org-1", undefined]]);
  expect(state.shells).toEqual(["org-1"]);
  expect(html).toContain(">Every run, newest first.</h1>");
  expect(html).toMatch(/<a href="\/runs\?show=attention" aria-current="page"/);
  expect(html).toMatch(/<a href="\/runs"[^>]*aria-current="page"[^>]*>(?:(?!<\/a>).)*All runs/);
});

test("the runs, the counts and the next page reach the list", async () => {
  state.runs = [run];
  state.olderThan = 12;
  const html = renderToStaticMarkup(await open({ show: "attention", before: "40" }));
  expect(html).toContain('href="/runs/r12"');
  expect(html).toMatch(/>All <span[^>]*>60<\/span>.*>Completed <span[^>]*>48<\/span>.*>Needs attention <span[^>]*>11<\/span>/);
  expect(html).toContain('<a href="/runs?show=attention&amp;before=12"');
  expect(html).toMatch(/<a href="\/runs\?show=attention"[^>]*>Newest runs<\/a>/);
});

test("past the last page the list says there is nothing older", async () => {
  expect(renderToStaticMarkup(await open({ before: "3" }))).toContain("There are no older runs here.");
  expect(renderToStaticMarkup(await open())).toContain("No runs yet. Start one from a project&#x27;s plan.");
});

test("an address without a usable filter or page shows all runs from the newest", async () => {
  await open({ show: "everything", before: "-1" });
  expect(state.asked).toEqual([{ orgId: "org-1", show: "all", before: undefined }]);
});

test("a new run starts from the plan of the most recently active project, or from a new project", async () => {
  expect(renderToStaticMarkup(await open())).toMatch(/<a href="\/projects\/p1#start"[^>]*>New run</);
  state.projects = [];
  expect(renderToStaticMarkup(await open())).toMatch(/<a href="\/new"[^>]*>New run</);
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in before anything is read", async () => {
  state.signedIn = false;
  await expect(open()).rejects.toMatchObject({ to: "/sign-in" });
  state.signedIn = true;
  state.orgId = null;
  await expect(open()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.tenants).toEqual([]);
  expect(state.asked).toEqual([]);
});
