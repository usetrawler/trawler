import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[], judgedBy: [] as string[], dismissed: [] as unknown[][], undone: [] as unknown[][], failWith: null as Error | null, logged: [] as string[], stopped: [] as Array<{ runId: string; reason: string }> }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => null }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../server/log.ts", () => ({ logError: async (message: string) => { state.logged.push(message); } }));
vi.mock("../../../runs/dismissals.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runs/dismissals.ts")>()),
  dismissFinding: async (_tx: unknown, ...args: unknown[]) => { if (state.failWith) throw state.failWith; state.dismissed.push(args); },
  undoDismissal: async (_tx: unknown, ...args: unknown[]) => { if (state.failWith) throw state.failWith; state.undone.push(args); },
}));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../runs/runs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runs/runs.ts")>()),
  cancelRun: async (_tx: unknown, _orgId: string, runId: string, reason: string) => { state.stopped.push({ runId, reason }); return true; },
  judgeAgain: async (_tx: unknown, _orgId: string, _runId: string, _key: string, requestedBy: string) => { state.judgedBy.push(requestedBy); },
}));

const { cancelRunAction, dismissFindingAction, judgeAgainAction, undoDismissalAction } = await import("./actions.ts");
const { CannotDismiss } = await import("../../../runs/dismissals.ts");
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  state.member = null;
  state.tenants = [];
  state.judgedBy = [];
  state.dismissed = [];
  state.undone = [];
  state.failWith = null;
  state.logged = [];
  state.stopped = [];
});

test("a session that no longer belongs to any workspace can neither stop a run nor judge again, and nothing is read", async () => {
  expect(await cancelRunAction(RUN)).toBe(false);
  expect(await judgeAgainAction(RUN, "f1")).toEqual({ error: "Sign in again." });
  expect(state.tenants).toEqual([]);
});

test("a run is stopped and judged again in the workspace the membership check returns, for the member who asked", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  expect(await cancelRunAction(RUN)).toBe(true);
  expect(await judgeAgainAction(RUN, "f1")).toEqual({});
  expect(state.tenants).toEqual(["org-2", "org-2"]);
  expect(state.judgedBy).toEqual(["u1"]);
  expect(state.stopped).toEqual([{ runId: RUN, reason: "stopped" }]);
});

test("not a bug and its undo are refused to a session without a workspace and to a malformed run or finding, and nothing is read", async () => {
  expect(await dismissFindingAction(RUN, "f1", "Intended.")).toEqual({ error: "Sign in again." });
  expect(await undoDismissalAction(RUN, "f1")).toEqual({ error: "Sign in again." });
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  for (const [run, key] of [["run-1", "f1"], [RUN, ""], [RUN, "k".repeat(201)], [RUN, 7]] as const) {
    expect(await dismissFindingAction(run, key as string, "Intended.")).toEqual({ error: "This finding was not found." });
    expect(await undoDismissalAction(run, key as string)).toEqual({ error: "This finding was not found." });
  }
  expect(state.tenants).toEqual([]);
});

test("not a bug is marked and undone in the member's workspace, by the member, and a refusal or a failure says so", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  expect(await dismissFindingAction(RUN, "ana:f1", "Intended.")).toEqual({});
  expect(await undoDismissalAction(RUN, "ana:f1")).toEqual({});
  expect(state.tenants).toEqual(["org-2", "org-2"]);
  expect(state.dismissed).toEqual([["org-2", RUN, "ana:f1", "Intended.", "u1"]]);
  expect(state.undone).toEqual([["org-2", RUN, "ana:f1"]]);

  state.failWith = new CannotDismiss("It is already marked not a bug.");
  expect(await dismissFindingAction(RUN, "ana:f1", "Intended.")).toEqual({ error: "It is already marked not a bug." });
  expect(state.logged).toEqual([]);
  state.failWith = new Error("connection lost");
  expect(await dismissFindingAction(RUN, "ana:f1", "Intended.")).toEqual({ error: "It could not be marked not a bug. Try again." });
  expect(await undoDismissalAction(RUN, "ana:f1")).toEqual({ error: "It could not be undone. Try again." });
  expect(state.logged).toEqual(["finding could not be marked not a bug", "not a bug could not be undone"]);
});
