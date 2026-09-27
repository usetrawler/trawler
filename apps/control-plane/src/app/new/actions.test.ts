import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, calls: [] as string[], failWith: null as Error | null }));

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
    return value;
  };
  return {
    ...(await importOriginal<typeof import("../../setup/propose.ts")>()),
    startDraft: call("start", "0f8fad5b-d9cb-469f-a165-70867728950e"),
    describeDraft: call("describe", { name: "Acme", description: "d", features: [{ title: "Submit", summary: "s" }] }),
    proposeFromDraft: call("propose", "p1"),
  };
});

const { describeProductAction, proposePeopleAction, readProductAction } = await import("./actions.ts");
const { SetupModelFailed } = await import("@usetrawler/core/setup");
const DRAFT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ana: Member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme workspace", role: "member" };

beforeEach(() => {
  state.member = null;
  state.calls = [];
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
