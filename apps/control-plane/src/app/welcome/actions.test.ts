import { beforeEach, expect, test, vi } from "vitest";

const newcomer = { userId: "u1", sessionId: "s1", name: "Ana", email: "ana@acme.test", emailVerified: true };
const state = vi.hoisted(() => ({ person: null as unknown, chosen: null as string | null, choices: [] as unknown[][], revalidated: [] as unknown[][] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => { state.revalidated.push(args); } }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  signedInPerson: async () => state.person,
  getAuth: () => ({ chooseWorkspace: async (...args: unknown[]) => { state.choices.push(args); return state.chosen; } }),
}));

const { joinWorkspaceAction, startOwnWorkspaceAction } = await import("./actions.ts");
const { NO_LONGER_OPEN } = await import("./choice-state.ts");
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  Object.assign(state, { person: { newcomer }, chosen: "org-x", choices: [], revalidated: [] });
});

test("joining asks for the chosen invitation in this person's own session, then goes home", async () => {
  await expect(joinWorkspaceAction({}, form({ invitationId: "inv-1" }))).rejects.toMatchObject({ to: "/" });
  expect(state.choices).toEqual([[{ id: "s1", userId: "u1" }, { join: "inv-1" }]]);
  expect(state.revalidated).toEqual([["/", "layout"]]);
});

test("an invitation that is no longer open is said so, and nobody is sent anywhere", async () => {
  state.chosen = null;
  expect(await joinWorkspaceAction({}, form({ invitationId: "inv-1" }))).toEqual({ error: NO_LONGER_OPEN });
  expect(state.choices).toHaveLength(1);
});

test("a join with no invitation named asks for nothing", async () => {
  expect(await joinWorkspaceAction({}, form({}))).toEqual({ error: NO_LONGER_OPEN });
  expect(state.choices).toEqual([]);
});

test("starting one's own workspace asks for exactly that, then goes home", async () => {
  await expect(startOwnWorkspaceAction()).rejects.toMatchObject({ to: "/" });
  expect(state.choices).toEqual([[{ id: "s1", userId: "u1" }, "own"]]);
});

test("a member who already has a workspace, or a visitor, chooses nothing", async () => {
  state.person = { member: { orgId: "org-1" } };
  await expect(joinWorkspaceAction({}, form({ invitationId: "inv-1" }))).rejects.toMatchObject({ to: "/" });
  await expect(startOwnWorkspaceAction()).rejects.toMatchObject({ to: "/" });
  state.person = null;
  await expect(joinWorkspaceAction({}, form({ invitationId: "inv-1" }))).rejects.toMatchObject({ to: "/sign-in" });
  await expect(startOwnWorkspaceAction()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.choices).toEqual([]);
});
