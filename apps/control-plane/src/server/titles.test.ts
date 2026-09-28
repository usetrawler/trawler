import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[], projects: {} as Record<string, string>, runs: {} as Record<string, { number: number; projectName: string }>, captures: {} as Record<string, { runNumber: number; projectId: string }> }));

vi.mock("./auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("./db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../projects/overview.ts", () => ({
  projectHead: async (_tx: unknown, orgId: string, id: string) => (state.projects[`${orgId}/${id}`] ? { id, name: state.projects[`${orgId}/${id}`], targetUrl: "https://acme.test/" } : null),
  runHead: async (_tx: unknown, orgId: string, id: string) => state.runs[`${orgId}/${id}`] ?? null,
}));
vi.mock("../artifacts/artifacts.ts", () => ({ screenCapture: async (_db: unknown, orgId: string, id: string) => state.captures[`${orgId}/${id}`] ?? null }));

const { capturePageTitle, projectPageTitle, runPageTitle } = await import("./titles.ts");
const { getAccessFallbackHTTPStatus, isHTTPAccessFallbackError } = await import("next/dist/client/components/http-access-fallback/http-access-fallback.js");
const notFoundBy = async (title: Promise<unknown>) => {
  const error = await title.then(() => null, (e: unknown) => e);
  return isHTTPAccessFallbackError(error) ? getAccessFallbackHTTPStatus(error) : error;
};
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const request = () => new Headers({ cookie: "session=ana" });

beforeEach(() => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-a", orgName: "Acme", role: "member" };
  state.tenants = [];
  state.projects = { [`org-a/${PROJECT}`]: "Acme Shop" };
  state.runs = { [`org-a/${ID}`]: { number: 17, projectName: "Acme Shop" } };
  state.captures = { [`org-a/${ID}`]: { runNumber: 17, projectId: PROJECT } };
});

test("a project's pages, a run and a screen capture are named after what they show, read in the member's own workspace", async () => {
  expect(await projectPageTitle(request(), PROJECT, "Plan")).toEqual({ title: "Acme Shop · Plan" });
  expect(await projectPageTitle(request(), PROJECT, "Runs")).toEqual({ title: "Acme Shop · Runs" });
  expect(await runPageTitle(request(), ID)).toEqual({ title: "Run 0017 · Acme Shop" });
  expect(await capturePageTitle(request(), ID)).toEqual({ title: "Screen capture · Run 0017 · Acme Shop" });
  expect(state.tenants.every((org) => org === "org-a")).toBe(true);
});

test("a project, run or capture the workspace cannot see switches the metadata to the not-found page's, naming nothing", async () => {
  state.member = { ...state.member!, orgId: "org-b" };
  expect(await notFoundBy(projectPageTitle(request(), PROJECT, "Plan"))).toBe(404);
  expect(await notFoundBy(runPageTitle(request(), ID))).toBe(404);
  expect(await notFoundBy(capturePageTitle(request(), ID))).toBe(404);
  expect(state.tenants.every((org) => org === "org-b")).toBe(true);
});

test("an id that is not a uuid is not found without a query, and a signed-out request reads nothing, since the page sends it to sign in", async () => {
  expect(await notFoundBy(projectPageTitle(request(), "plan", "Plan"))).toBe(404);
  expect(await notFoundBy(runPageTitle(request(), "0017"))).toBe(404);
  expect(await projectPageTitle(new Headers(), PROJECT, "Plan")).toEqual({});
  expect(await runPageTitle(new Headers(), ID)).toEqual({});
  expect(await capturePageTitle(new Headers(), ID)).toEqual({});
  expect(state.tenants).toEqual([]);
});

test("a capture whose project is deleted between the two reads still names its run", async () => {
  state.projects = {};
  expect(await capturePageTitle(request(), ID)).toEqual({ title: "Screen capture · Run 0017" });
});
