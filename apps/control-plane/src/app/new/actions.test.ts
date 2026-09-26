import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, proposedFor: [] as string[], failWith: null as Error | null }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ setup: { model: "deepseek/deepseek-v4.1-flash", apiKey: "sk-or-v1-unused" } }) }));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/log.ts", () => ({ logError: async () => {}, writeLog: async () => {} }));
vi.mock("@usetrawler/core/setup", async (importOriginal) => ({ ...(await importOriginal<typeof import("@usetrawler/core/setup")>()), createModel: () => ({}) }));
vi.mock("../../setup/propose.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../setup/propose.ts")>()),
  proposeFromUrl: async (_deps: unknown, input: { orgId: string }) => {
    if (state.failWith) throw state.failWith;
    state.proposedFor.push(input.orgId);
    return "p1";
  },
}));

const { startSetup } = await import("./actions.ts");
const { SetupModelFailed } = await import("@usetrawler/core/setup");
const form = () => {
  const f = new FormData();
  f.set("url", "https://app.acme.test");
  return f;
};

beforeEach(() => {
  state.member = null;
  state.proposedFor = [];
  state.failWith = null;
});

test("a session that no longer belongs to any workspace is sent to sign in, and no project is set up", async () => {
  await expect(startSetup({}, form())).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.proposedFor).toEqual([]);
});

test("a project is set up in the workspace the membership check returns", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  await expect(startSetup({}, form())).rejects.toMatchObject({ to: "/projects/p1" });
  expect(state.proposedFor).toEqual(["org-2"]);
});

test("a setup model that writes no plan is named as the cause, and the page is not blamed", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  state.failWith = new SetupModelFailed("the setup model ran out of room before it finished the plan (2 tries)");
  expect(await startSetup({}, form())).toEqual({ error: "Trawler's setup model could not write a plan this time. Try again in a moment.", url: "https://app.acme.test", focus: "" });
  state.failWith = new Error("connect ECONNREFUSED 203.0.113.9:443");
  expect((await startSetup({}, form())).error).toBe("We could not build a plan for this page. Try again in a moment.");
});
