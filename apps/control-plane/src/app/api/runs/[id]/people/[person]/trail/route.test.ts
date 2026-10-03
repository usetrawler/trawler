import type { NextRequest } from "next/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ member: null as null | { orgId: string; userId: string }, asked: [] as unknown[][], tenants: [] as string[] }));
vi.mock("../../../../../../../server/auth.ts", () => ({ signedInMember: async () => state.member }));
vi.mock("../../../../../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../../../../../server/runs.ts", () => ({ runIdFor: async (orgId: string, ref: string) => (orgId === "org-2" && ref === "0007" ? "run-7" : null) }));
vi.mock("../../../../../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../../../../../runs/trail.ts", () => ({
  personTrail: async (_tx: unknown, ...args: unknown[]) => { state.asked.push(args); return args[2] === "ana" ? { turns: [], entries: [], olderThan: null } : null; },
}));

const { GET } = await import("./route.ts");
const get = (run: string, person: string, query = "") => GET(new Request(`http://localhost:3000/api/runs/${run}/people/${person}/trail${query}`) as NextRequest, { params: Promise.resolve({ id: run, person }) });

beforeEach(() => {
  state.member = null;
  state.asked = [];
  state.tenants = [];
});

test("a signed-out request is refused and nothing is read", async () => {
  const res = await get("0007", "ana");
  expect(res.status).toBe(401);
  expect(state.tenants).toEqual([]);
});

test("a trail is read in the member's own workspace, newest page or before a cursor, and never cached", async () => {
  state.member = { orgId: "org-2", userId: "u1" };
  const res = await get("0007", "ana");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ turns: [], entries: [], olderThan: null });
  await get("0007", "ana", "?before=1234");
  expect(state.asked).toEqual([["org-2", "run-7", "ana", undefined], ["org-2", "run-7", "ana", 1234]]);
  expect(state.tenants).toEqual(["org-2", "org-2"]);
});

test("an unknown run or person, or a malformed cursor or person, is not found", async () => {
  state.member = { orgId: "org-2", userId: "u1" };
  expect((await get("0008", "ana")).status).toBe(404);
  expect((await get("0007", "nobody")).status).toBe(404);
  for (const query of ["?before=0", "?before=-1", "?before=abc", "?before=1e3", `?before=${"9".repeat(16)}`]) expect((await get("0007", "ana", query)).status).toBe(404);
  expect((await get("0007", "x".repeat(101))).status).toBe(404);
  expect(state.asked).toEqual([["org-2", "run-7", "nobody", undefined]]);
});
