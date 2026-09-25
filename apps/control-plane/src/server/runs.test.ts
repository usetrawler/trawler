import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[] }));

vi.mock("./auth.ts", () => ({ signedInMember: async () => state.member }));
vi.mock("./db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../runs/runs.ts", () => ({ runSummary: async (_tx: unknown, orgId: string, id: string) => ({ id, orgId }) }));

const { runFor } = await import("./runs.ts");
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  state.member = null;
  state.tenants = [];
});

test("a session that no longer belongs to any workspace counts as signed out, and no run is read", async () => {
  expect(await runFor(new Headers(), RUN)).toEqual({ signedIn: false });
  expect(state.tenants).toEqual([]);
});

test("a run is read in the workspace the membership check returns", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2" };
  expect(await runFor(new Headers(), RUN)).toEqual({ signedIn: true, orgId: "org-2", email: "ana@acme.test", userId: "u1", run: { id: RUN, orgId: "org-2" } });
  expect(state.tenants).toEqual(["org-2"]);
});
