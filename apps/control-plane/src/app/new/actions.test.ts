import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string };
const state = vi.hoisted(() => ({ member: null as Member | null, proposedFor: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({ signedInMember: async () => state.member }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ setup: { model: "deepseek/deepseek-v4.1-flash", apiKey: "sk-or-v1-unused" } }) }));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/log.ts", () => ({ logError: async () => {}, writeLog: async () => {} }));
vi.mock("@usetrawler/core/setup", () => ({ createModel: () => ({}) }));
vi.mock("../../setup/propose.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../setup/propose.ts")>()),
  proposeFromUrl: async (_deps: unknown, input: { orgId: string }) => { state.proposedFor.push(input.orgId); return "p1"; },
}));

const { startSetup } = await import("./actions.ts");
const form = () => {
  const f = new FormData();
  f.set("url", "https://app.acme.test");
  return f;
};

beforeEach(() => {
  state.member = null;
  state.proposedFor = [];
});

test("a session that no longer belongs to any workspace is sent to sign in, and no project is set up", async () => {
  await expect(startSetup({}, form())).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.proposedFor).toEqual([]);
});

test("a project is set up in the workspace the membership check returns", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2" };
  await expect(startSetup({}, form())).rejects.toMatchObject({ to: "/projects/p1" });
  expect(state.proposedFor).toEqual(["org-2"]);
});
