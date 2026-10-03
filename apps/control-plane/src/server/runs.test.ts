import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
type Finding = { key: string; dismissal: { reason: string; userId: string; at: string; by: string | null } | null };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[], findings: [] as Finding[], emailsAsked: [] as string[] }));

vi.mock("./auth.ts", () => ({
  signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null),
  getAuth: () => ({ memberEmail: async (orgId: string, userId: string) => { state.emailsAsked.push(`${orgId}/${userId}`); return userId === "u1" ? "ana@acme.test" : null; } }),
}));
vi.mock("./db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../runs/runs.ts", () => ({
  runSummary: async (_tx: unknown, orgId: string, id: string) => ({ id, orgId, findings: state.findings }),
  runIdByNumber: async (_tx: unknown, orgId: string, number: number) => (orgId === "org-2" && number === 17 ? "run-17-of-org-2" : null),
}));

const { runFor } = await import("./runs.ts");
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const request = () => new Headers({ cookie: "session=ana" });

beforeEach(() => {
  state.member = null;
  state.tenants = [];
  state.findings = [];
  state.emailsAsked = [];
});

test("a session that no longer belongs to its workspace counts as signed out, and no run is read", async () => {
  expect(await runFor(request(), RUN)).toEqual({ signedIn: false });
  expect(state.tenants).toEqual([]);
});

test("a run is read in the workspace the membership check returns, for the request made", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  expect(await runFor(request(), RUN)).toEqual({ signedIn: true, member: state.member, run: { id: RUN, orgId: "org-2", findings: [] } });
  expect(await runFor(new Headers(), RUN)).toEqual({ signedIn: false });
  expect(state.tenants).toEqual(["org-2"]);
});

test("a run is found by its number in the member's own workspace, padded or not, and nothing else reads as a run", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  expect(await runFor(request(), "0017")).toEqual({ signedIn: true, member: state.member, run: { id: "run-17-of-org-2", orgId: "org-2", findings: [] } });
  expect(await runFor(request(), "17")).toMatchObject({ run: { id: "run-17-of-org-2" } });
  expect(await runFor(request(), "0018")).toEqual({ signedIn: true, member: state.member, run: null });
  state.tenants = [];
  for (const ref of ["0", "0000", "17a", "-17", "1234567890", "run-17"]) expect(await runFor(request(), ref)).toEqual({ signedIn: true, member: state.member, run: null });
  expect(state.tenants).toEqual([]);
});

test("who marked a finding not a bug is named by their email in the run's workspace, once per person, and someone who left is named by nobody", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  const marked = (key: string, userId: string) => ({ key, dismissal: { reason: "Intended.", userId, at: "2026-10-02T10:00:00.000Z", by: null } });
  state.findings = [marked("f1", "u1"), { key: "f2", dismissal: null }, marked("f3", "u1"), marked("f4", "u-gone")];
  const access = await runFor(request(), RUN);
  expect(access.signedIn && access.run?.findings.map((f) => f.dismissal?.by)).toEqual(["ana@acme.test", undefined, "ana@acme.test", null]);
  expect(state.emailsAsked).toEqual(["org-2/u1", "org-2/u-gone"]);
});

test("a finding Trawler marked is not looked up as a member", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  state.findings = [{ key: "f1", dismissal: { reason: "Intended.", userId: "trawler", at: "2026-10-03T10:00:00.000Z", by: null } }];
  const access = await runFor(request(), RUN);
  expect(access.signedIn && access.run?.findings[0]?.dismissal?.by).toBeNull();
  expect(state.emailsAsked).toEqual([]);
});
