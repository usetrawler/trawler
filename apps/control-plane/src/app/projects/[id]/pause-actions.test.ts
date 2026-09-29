import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ signedIn: true, paused: [] as unknown[][], resumed: [] as unknown[][], fails: null as Error | null, revalidated: [] as string[], logged: [] as string[], live: null as { id: string; number: number } | null }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => void state.revalidated.push(path) }));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async () => (state.signedIn ? { userId: "u-1", orgId: "org-1", email: "a@acme.test", orgName: "Acme", role: "member" } : null) }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../server/log.ts", () => ({ logError: async (message: string) => void state.logged.push(message) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _orgId: string, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("../../../runs/runs.ts", () => ({
  pauseProject: async (...args: unknown[]) => {
    if (state.fails) throw state.fails;
    if (state.live && args[4] !== state.live.id) return { unconfirmed: state.live };
    state.paused.push(args.slice(1));
    return { stopped: state.live };
  },
  resumeProject: async (...args: unknown[]) => { if (state.fails) throw state.fails; state.resumed.push(args.slice(1)); },
}));

const { pauseRunsAction, resumeRunsAction } = await import("./pause-actions.ts");
const { ProjectNotFound } = await import("../../../projects/projects.ts");
const PROJECT = "0f8fad5b-d9cb-469f-a165-70867728950e";

const RUN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

beforeEach(() => Object.assign(state, { signedIn: true, paused: [], resumed: [], fails: null, revalidated: [], logged: [], live: null }));

test("any member pauses a project of their workspace, which says which run it stopped and refreshes the pages", async () => {
  expect(await pauseRunsAction(PROJECT, null)).toEqual({ stopped: null });
  expect(state.paused).toEqual([["org-1", PROJECT, "u-1", null]]);
  state.live = { id: RUN, number: 8 };
  expect(await pauseRunsAction(PROJECT, RUN)).toEqual({ stopped: { id: RUN, number: 8 } });
  expect(await resumeRunsAction(PROJECT)).toEqual({});
  expect(state.resumed).toEqual([["org-1", PROJECT]]);
  expect(state.revalidated).toEqual(["/", "/", "/"]);
});

test("a live run the person was not asked about is named back instead of stopped, and nothing is refreshed", async () => {
  state.live = { id: RUN, number: 8 };
  expect(await pauseRunsAction(PROJECT, null)).toEqual({ liveRun: { id: RUN, number: 8 } });
  expect(await pauseRunsAction(PROJECT, "not-a-run")).toEqual({ liveRun: { id: RUN, number: 8 } });
  expect(state.paused).toEqual([]);
  expect(state.revalidated).toEqual([]);
});

test("a stranger, a malformed project or one of another workspace changes nothing and gets a plain answer", async () => {
  state.signedIn = false;
  expect(await pauseRunsAction(PROJECT, null)).toEqual({ error: "Sign in again." });
  state.signedIn = true;
  expect(await pauseRunsAction("not-a-project", null)).toEqual({ error: "This project was not found." });
  state.fails = new ProjectNotFound();
  expect(await resumeRunsAction(PROJECT)).toEqual({ error: "This project was not found." });
  expect(state.paused).toEqual([]);
  expect(state.logged).toEqual([]);
});

test("an unexpected failure is logged and answered with a retry", async () => {
  state.fails = new Error("connection lost");
  expect(await pauseRunsAction(PROJECT, null)).toEqual({ error: "Runs could not be paused. Try again." });
  expect(state.logged).toEqual(["runs could not be paused"]);
});
