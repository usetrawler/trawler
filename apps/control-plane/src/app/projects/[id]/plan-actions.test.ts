import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async () => state.member }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../server/log.ts", () => ({ logError: async () => {}, scrubberWith: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../projects/projects.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../projects/projects.ts")>()),
  replacePlan: async () => {},
  addAccount: async () => "a1",
  removeAccount: async () => {},
  projectForEditing: async () => ({ accounts: [] }),
}));

const { addAccountAction, removeAccountAction, savePlanAction } = await import("./plan-actions.ts");
const PROJECT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PLAN = { personas: [{ id: "ama", name: "Ama", brief: "Runs a design studio." }], goals: [{ id: "sign-up", instruction: "Create an account." }] };
const ACCOUNT = { username: "owner@acme.test", password: "hunter22-secret" };

beforeEach(() => {
  state.member = null;
  state.tenants = [];
});

test("a session that no longer belongs to any workspace cannot change the plan or its test accounts, and nothing is read", async () => {
  expect(await savePlanAction(PROJECT, PLAN)).toEqual({ ok: false, error: "Sign in again to save." });
  expect(await addAccountAction(PROJECT, ACCOUNT)).toEqual({ ok: false, error: "Sign in again to add an account." });
  expect(await removeAccountAction(PROJECT, "a1")).toEqual({ ok: false, error: "Sign in again to remove an account." });
  expect(state.tenants).toEqual([]);
});

test("the plan and its test accounts change in the workspace the membership check returns", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2" };
  expect(await savePlanAction(PROJECT, PLAN)).toEqual({ ok: true });
  expect(await addAccountAction(PROJECT, ACCOUNT)).toEqual({ ok: true, ref: "a1", accounts: [] });
  expect(await removeAccountAction(PROJECT, "a1")).toEqual({ ok: true, accounts: [] });
  expect(state.tenants).toEqual(["org-2", "org-2", "org-2", "org-2", "org-2"]);
});
