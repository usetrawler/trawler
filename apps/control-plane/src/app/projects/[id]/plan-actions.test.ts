import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, tenants: [] as string[], replaced: [] as unknown[][], fail: null as Error | null, renamed: [] as unknown[][], removed: [] as unknown[][] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../server/log.ts", () => ({ logError: async () => {}, scrubberWith: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../../projects/projects.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../projects/projects.ts")>()),
  replacePlan: async (...args: unknown[]) => { state.replaced.push(args.slice(3)); },
  addAccount: async () => "a1",
  removeAccount: async () => {},
  projectForEditing: async () => ({ accounts: [] }),
  renamePlan: async (...args: unknown[]) => { if (state.fail) throw state.fail; state.renamed.push(args.slice(2)); return args[4] as string; },
  removePlan: async (...args: unknown[]) => { if (state.fail) throw state.fail; state.removed.push(args.slice(2)); },
}));

const { LastPlan, PlanInUse, PlanNameTaken, PlanNotFound } = await import("../../../projects/projects.ts");
const { addAccountAction, removeAccountAction, removePlanAction, renamePlanAction, savePlanAction } = await import("./plan-actions.ts");
const PROJECT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PLAN_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PLAN = { personas: [{ id: "ama", name: "Ama", brief: "Runs a design studio." }], goals: [{ id: "sign-up", instruction: "Create an account.", personaId: "ama" }] };
const ACCOUNT = { username: "owner@acme.test", password: "hunter22-secret" };

beforeEach(() => {
  state.member = null;
  state.tenants = [];
  state.fail = null;
  state.renamed = [];
  state.removed = [];
});

test("a session that no longer belongs to any workspace cannot change the plan or its test accounts, and nothing is read", async () => {
  expect(await savePlanAction(PROJECT, PLAN_ID, PLAN)).toEqual({ ok: false, error: "Sign in again to save." });
  expect(await addAccountAction(PROJECT, PLAN_ID, ACCOUNT)).toEqual({ ok: false, error: "Sign in again to add an account." });
  expect(await removeAccountAction(PROJECT, PLAN_ID, "a1")).toEqual({ ok: false, error: "Sign in again to remove an account." });
  expect(state.tenants).toEqual([]);
});

test("every goal belongs to a person, and every person needs a goal", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  const shared = { ...PLAN, goals: [{ id: "sign-up", instruction: "Create an account." }] };
  expect(await savePlanAction(PROJECT, PLAN_ID, shared)).toMatchObject({ ok: false });
  const idle = { ...PLAN, personas: [...PLAN.personas, { id: "kofi", name: "Kofi", brief: "Reviews the work." }] };
  expect(await savePlanAction(PROJECT, PLAN_ID, idle)).toEqual({ ok: false, error: "Give Kofi at least one goal." });
  expect(state.tenants).toEqual([]);
});

test("a test account takes a password of any length up to 1000 characters", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  expect(await addAccountAction(PROJECT, PLAN_ID, { username: "user", password: "pw12" })).toEqual({ ok: true, ref: "a1", accounts: [] });
  const refused = { ok: false, error: "Enter the password the account signs in with (up to 1000 characters)." };
  expect(await addAccountAction(PROJECT, PLAN_ID, { username: "user", password: "" })).toEqual(refused);
  expect(await addAccountAction(PROJECT, PLAN_ID, { username: "user", password: "x".repeat(1001) })).toEqual(refused);
});

test("the plan and its test accounts change in the workspace the membership check returns", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  expect(await savePlanAction(PROJECT, PLAN_ID, PLAN)).toEqual({ ok: true });
  expect(await addAccountAction(PROJECT, PLAN_ID, ACCOUNT)).toEqual({ ok: true, ref: "a1", accounts: [] });
  expect(await removeAccountAction(PROJECT, PLAN_ID, "a1")).toEqual({ ok: true, accounts: [] });
  expect(state.tenants).toEqual(["org-2", "org-2", "org-2", "org-2", "org-2"]);
});

test("who signs in is saved with the plan: anyone with an account, and anyone marked as needing one", async () => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };
  state.replaced = [];
  const plan = {
    personas: [{ ...PLAN.personas[0], signsIn: true }, { id: "kofi", name: "Kofi", brief: "b", accountRef: "a1" }, { id: "lee", name: "Lee", brief: "b", signsIn: false }],
    goals: ["ama", "kofi", "lee"].map((personaId) => ({ id: `g-${personaId}`, instruction: "x", personaId })),
  };
  expect(await savePlanAction(PROJECT, PLAN_ID, plan)).toEqual({ ok: true });
  const [saved, signsIn] = state.replaced[0] as [{ personas: object[] }, string[]];
  expect(saved.personas.every((p) => !("signsIn" in p))).toBe(true);
  expect(signsIn).toEqual(["ama", "kofi"]);
});

const signedIn = () => { state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" }; };

test("a plan is renamed in the workspace of the session, with a trimmed name, and a signed-out session changes nothing", async () => {
  expect(await renamePlanAction(PROJECT, PLAN_ID, "Billing")).toEqual({ ok: false, error: "Sign in again to rename the plan." });
  signedIn();
  expect(await renamePlanAction(PROJECT, PLAN_ID, "  Billing  ")).toEqual({ ok: true, name: "Billing" });
  expect(state.renamed).toEqual([[PROJECT, PLAN_ID, "Billing"]]);
  expect(state.tenants).toEqual(["org-2"]);
  for (const bad of ["", "   ", "x".repeat(101), 7, null]) expect(await renamePlanAction(PROJECT, PLAN_ID, bad)).toEqual({ ok: false, error: "Give the plan a name of up to 100 characters." });
  expect(state.renamed).toHaveLength(1);
});

test("renaming says when another plan has the name, or when the plan is gone", async () => {
  signedIn();
  state.fail = new PlanNameTaken();
  expect(await renamePlanAction(PROJECT, PLAN_ID, "Plan 1")).toEqual({ ok: false, error: "Another plan of this project already has that name." });
  state.fail = new PlanNotFound();
  expect(await renamePlanAction(PROJECT, PLAN_ID, "Plan 1")).toEqual({ ok: false, error: "This plan was removed. Reload the page and choose another." });
});

test("removing a plan says why it cannot be removed: the last plan, or one with a run going", async () => {
  expect(await removePlanAction(PROJECT, PLAN_ID)).toEqual({ ok: false, error: "Sign in again to remove the plan." });
  signedIn();
  expect(await removePlanAction(PROJECT, PLAN_ID)).toEqual({ ok: true });
  expect(state.removed).toEqual([[PROJECT, PLAN_ID]]);
  state.fail = new LastPlan();
  expect(await removePlanAction(PROJECT, PLAN_ID)).toEqual({ ok: false, error: "A project keeps at least one plan." });
  state.fail = new PlanInUse();
  expect(await removePlanAction(PROJECT, PLAN_ID)).toEqual({ ok: false, error: "A run of this plan is going. Stop it or wait for it to finish, then remove the plan." });
  state.fail = new PlanNotFound();
  expect(await removePlanAction(PROJECT, PLAN_ID)).toEqual({ ok: false, error: "This plan was removed. Reload the page and choose another." });
});
