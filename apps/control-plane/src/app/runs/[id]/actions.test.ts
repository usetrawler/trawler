import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[], judgedBy: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async () => state.member }));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => null }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../server/log.ts", () => ({ logError: async () => {} }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../runs/runs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runs/runs.ts")>()),
  cancelRun: async () => {},
  judgeAgain: async (_tx: unknown, _orgId: string, _runId: string, _key: string, requestedBy: string) => { state.judgedBy.push(requestedBy); },
}));

const { cancelRunAction, judgeAgainAction } = await import("./actions.ts");
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  state.member = null;
  state.tenants = [];
  state.judgedBy = [];
});

test("a session that no longer belongs to any workspace can neither stop a run nor judge again, and nothing is read", async () => {
  expect(await cancelRunAction(RUN)).toBe(false);
  expect(await judgeAgainAction(RUN, "f1")).toEqual({ error: "Sign in again." });
  expect(state.tenants).toEqual([]);
});

test("a run is stopped and judged again in the workspace the membership check returns, for the member who asked", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2" };
  expect(await cancelRunAction(RUN)).toBe(true);
  expect(await judgeAgainAction(RUN, "f1")).toEqual({});
  expect(state.tenants).toEqual(["org-2", "org-2"]);
  expect(state.judgedBy).toEqual(["u1"]);
});
