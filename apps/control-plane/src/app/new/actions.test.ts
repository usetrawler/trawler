import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, calls: [] as string[], inputs: [] as Array<Record<string, unknown>>, planId: null as string | null, failWith: null as Error | null }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.ai/api/v1", setup: { model: "deepseek/deepseek-v4.1-flash", apiKey: "sk-or-v1-unused" } }) }));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/log.ts", () => ({ logError: async () => {}, writeLog: async () => {} }));
vi.mock("@usetrawler/core/setup", async (importOriginal) => ({ ...(await importOriginal<typeof import("@usetrawler/core/setup")>()), createModel: () => ({}) }));
vi.mock("../../setup/propose.ts", async (importOriginal) => {
  const call = (name: string, value: unknown) => async (_deps: unknown, input: { orgId: string }) => {
    if (state.failWith) throw state.failWith;
    state.calls.push(`${name}:${input.orgId}`);
    state.inputs.push({ name, ...input });
    return value;
  };
  return {
    ...(await importOriginal<typeof import("../../setup/propose.ts")>()),
    startDraft: call("start", "0f8fad5b-d9cb-469f-a165-70867728950e"),
    describeDraft: call("describe", { name: "Acme", description: "d", features: [{ title: "Submit", summary: "s" }] }),
    proposeFromDraft: async (deps: unknown, input: { orgId: string }) => {
      await call("propose", null)(deps, input);
      return { projectId: "p1", planId: state.planId };
    },
  };
});

const { describeProductAction, proposePeopleAction, readProductAction } = await import("./actions.ts");
const { SetupModelFailed } = await import("@usetrawler/core/setup");
const DRAFT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ana: Member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };

beforeEach(() => {
  state.member = null;
  state.calls = [];
  state.inputs = [];
  state.planId = null;
  state.failWith = null;
});

test("a session that no longer belongs to any workspace is sent to sign in, and nothing is read or proposed", async () => {
  await expect(readProductAction({ url: "https://app.acme.test" })).rejects.toMatchObject({ to: "/sign-in" });
  await expect(describeProductAction(DRAFT)).rejects.toMatchObject({ to: "/sign-in" });
  await expect(proposePeopleAction({ draftId: DRAFT, description: "d", features: ["Submit"] })).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.calls).toEqual([]);
});

test("each step runs in the workspace the membership check returns, and the last one opens the project", async () => {
  state.member = ana;
  expect(await readProductAction({ url: "app.acme.test" })).toEqual({ ok: true, draftId: DRAFT });
  expect(await describeProductAction(DRAFT)).toMatchObject({ ok: true, summary: { name: "Acme" } });
  await expect(proposePeopleAction({ draftId: DRAFT, description: "d", features: ["Submit"] })).rejects.toMatchObject({ to: "/projects/p1" });
  expect(state.calls).toEqual(["start:org-2", "describe:org-2", "propose:org-2"]);
});

test("people are proposed only for at least one feature, and odd input never reaches setup", async () => {
  state.member = ana;
  expect(await proposePeopleAction({ draftId: DRAFT, description: "d", features: [" ", ""] })).toEqual({ ok: false, error: "Choose at least one feature for the people to try." });
  expect(await proposePeopleAction({ draftId: "not-a-draft", description: "d", features: ["Submit"] })).toMatchObject({ ok: false });
  expect(await proposePeopleAction({ draftId: DRAFT, description: "d".repeat(2001), features: ["Submit"] })).toMatchObject({ ok: false });
  expect(await describeProductAction("../../etc")).toMatchObject({ ok: false });
  expect(await readProductAction({ url: " " })).toEqual({ ok: false, error: "Paste the address of the product to test." });
  expect(state.calls).toEqual([]);
});

test("a setup model that writes nothing usable is named as the cause, and the page is not blamed", async () => {
  state.member = ana;
  state.failWith = new SetupModelFailed("the setup model ran out of room before it finished the plan (2 tries)");
  expect(await describeProductAction(DRAFT)).toEqual({ ok: false, error: "Trawler's setup model could not write a plan this time. Try again in a moment." });
  state.failWith = new Error("connect ECONNREFUSED 203.0.113.9:443");
  expect(await readProductAction({ url: "https://app.acme.test" })).toEqual({ ok: false, error: "We could not build a plan for this page. Try again in a moment." });
});

const PROJECT = "9b2e4f5a-0c1d-4e6f-8a7b-3c4d5e6f7a8b";
const PLAN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

test("a plan to add is read from a project with a trimmed name, a plan to change with its id, and neither reaches a new project's setup", async () => {
  state.member = ana;
  expect(await readProductAction({ projectId: PROJECT, planName: "  Payments  " })).toMatchObject({ ok: true });
  expect(await readProductAction({ projectId: PROJECT, planId: PLAN })).toMatchObject({ ok: true });
  expect(await readProductAction({ url: "app.acme.test", planName: "Sneaky", planId: PLAN })).toMatchObject({ ok: true });
  expect(state.inputs).toEqual([
    { name: "start", orgId: "org-2", projectId: PROJECT, planName: "Payments" },
    { name: "start", orgId: "org-2", projectId: PROJECT, planId: PLAN },
    { name: "start", orgId: "org-2", url: "https://app.acme.test" },
  ]);
});

test("a plan name must be there and at most 100 characters", async () => {
  state.member = ana;
  const error = "Give the plan a name of up to 100 characters.";
  expect(await readProductAction({ projectId: PROJECT, planName: "   " })).toEqual({ ok: false, error });
  expect(await readProductAction({ projectId: PROJECT, planName: "x".repeat(101) })).toEqual({ ok: false, error });
  expect(state.calls).toEqual([]);
});

test("a name another plan has, or a plan that is gone, are told to the person and not logged as failures", async () => {
  state.member = ana;
  const { PlanNameTaken, PlanNotFound } = await import("../../projects/projects.ts");
  state.failWith = new PlanNameTaken();
  expect(await readProductAction({ projectId: PROJECT, planName: "Plan 1" })).toEqual({ ok: false, error: "Another plan of this project already has that name. Choose another name." });
  state.failWith = new PlanNotFound();
  expect(await readProductAction({ projectId: PROJECT, planId: PLAN })).toEqual({ ok: false, error: "This plan was removed. Go back to the project and choose another." });
});

test("proposing people opens the plan that was made, or the project when no plan was named", async () => {
  state.member = ana;
  state.planId = PLAN;
  await expect(proposePeopleAction({ draftId: DRAFT, description: "d", features: ["Submit"] })).rejects.toMatchObject({ to: `/projects/p1?plan=${PLAN}` });
  state.planId = null;
  await expect(proposePeopleAction({ draftId: DRAFT, description: "d", features: ["Submit"] })).rejects.toMatchObject({ to: "/projects/p1" });
});

test("a private address says so, so the wizard can ask for a description, and a description by hand reaches the draft", async () => {
  state.member = ana;
  const { FetchRefused } = await import("../../setup/safe-fetch.ts");
  state.failWith = new FetchRefused("private", "private network");
  expect(await readProductAction({ url: "localhost:8080" })).toEqual({ ok: false, error: "That address is on a private network. Trawler can only read public pages from here.", privateAddress: true });
  state.failWith = null;
  expect(await readProductAction({ url: "http://localhost:8080", byHand: { name: " Recurro ", description: " Tracks renewals. " } })).toEqual({ ok: true, draftId: DRAFT });
  expect(state.inputs.at(-1)).toMatchObject({ name: "start", url: "http://localhost:8080", byHand: { name: "Recurro", description: "Tracks renewals." } });
});

test("a description by hand needs a name and a description of a sane length", async () => {
  state.member = ana;
  expect(await readProductAction({ url: "http://localhost:8080", byHand: { name: " ", description: "d" } })).toMatchObject({ ok: false, error: expect.stringContaining("name") });
  expect(await readProductAction({ url: "http://localhost:8080", byHand: { name: "R", description: "x".repeat(2001) } })).toMatchObject({ ok: false, error: expect.stringContaining("what the product does") });
  expect(state.calls).toEqual([]);
});
