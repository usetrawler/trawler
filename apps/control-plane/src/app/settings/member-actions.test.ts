import { APIError } from "better-auth/api";
import { beforeEach, expect, test, vi } from "vitest";

type Person = { id: string; userId: string; role: string; joinedAt: Date; name: string; email: string };
const state = vi.hoisted(() => ({
  member: null as null | { userId: string; name: string; email: string; orgId: string; orgName: string; role: string },
  people: [] as Person[],
  invitations: [] as Array<{ id: string; email: string; role: string; expiresAt: Date }>,
  homes: {} as Record<string, string>,
  asked: [] as string[],
  calls: [] as Array<[string, unknown]>,
  fails: null as null | Error,
  revalidated: [] as unknown[][],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => { state.revalidated.push(args); } }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => {
  const api = (name: string) => async (options: { body: unknown }) => {
    if (state.fails) throw state.fails;
    state.calls.push([name, options.body]);
    return {};
  };
  return {
    signedInMember: async () => state.member,
    canManageBilling: (member: { role: string }) => member.role === "owner" || member.role === "admin",
    getAuth: () => ({
      workspaceMembers: async (orgId: string) => { state.asked.push(`members:${orgId}`); return state.people; },
      pendingInvitations: async (orgId: string) => { state.asked.push(`invitations:${orgId}`); return state.invitations; },
      workspaceOfEmail: async (email: string) => { state.asked.push(`home:${email}`); return state.homes[email] ?? null; },
      api: { createInvitation: api("createInvitation"), cancelInvitation: api("cancelInvitation"), removeMember: api("removeMember"), updateMemberRole: api("updateMemberRole") },
    }),
  };
});
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));

const { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } = await import("./actions.ts");
const owner = { userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const refused = (code: string) => new APIError("BAD_REQUEST", { code, message: code });
const SETTINGS = [["/settings"]];

beforeEach(() => {
  Object.assign(state, {
    member: owner, homes: {}, asked: [], calls: [], fails: null, revalidated: [],
    people: [
      { id: "m-1", userId: "user-1", role: "owner", joinedAt: new Date(), name: "Ana", email: "ana@acme.test" },
      { id: "m-2", userId: "user-2", role: "member", joinedAt: new Date(), name: "Lee", email: "lee@acme.test" },
      { id: "m-3", userId: "user-3", role: "owner", joinedAt: new Date(), name: "", email: "co@acme.test" },
    ],
    invitations: [{ id: "inv-1", email: "max@acme.test", role: "member", expiresAt: new Date() }],
  });
});

test("only an owner or admin changes who is in the workspace; a member is told so and nothing is asked of Better Auth", async () => {
  state.member = { ...owner, role: "member" };
  const refusal = { error: "Only an owner or admin of this workspace can change its settings." };
  expect(await inviteMemberAction({}, form({ email: "new@acme.test" }))).toEqual(refusal);
  expect(await revokeInvitationAction({}, form({ invitationId: "inv-1" }))).toEqual(refusal);
  expect(await removeMemberAction({}, form({ memberId: "m-2" }))).toEqual(refusal);
  expect(await changeRoleAction({}, form({ memberId: "m-2", role: "admin" }))).toEqual(refusal);
  expect(state.calls).toEqual([]);
});

test("an invitation goes to the lowercased address, as member unless admin is asked for, in the inviter's own workspace", async () => {
  expect(await inviteMemberAction({}, form({ email: "  New.Person@Acme.test ", role: "admin" }))).toEqual({ invited: "new.person@acme.test" });
  expect(await inviteMemberAction({}, form({ email: "other@acme.test", role: "owner" }))).toEqual({ invited: "other@acme.test" });
  expect(state.calls).toEqual([
    ["createInvitation", { email: "new.person@acme.test", role: "admin", organizationId: "org-1" }],
    ["createInvitation", { email: "other@acme.test", role: "member", organizationId: "org-1" }],
  ]);
  expect(state.revalidated).toEqual([...SETTINGS, ...SETTINGS]);
});

test("an address that is not one, is already here, or already has a workspace of its own is refused before any invitation", async () => {
  expect(await inviteMemberAction({}, form({ email: "not an address" }))).toEqual({ error: "Enter the email address they sign in with." });
  expect(await inviteMemberAction({}, form({ email: `${"a".repeat(250)}@b.cd` }))).toEqual({ error: "Enter the email address they sign in with." });
  state.homes = { "lee@acme.test": "org-1", "bo@globex.test": "org-9" };
  expect(await inviteMemberAction({}, form({ email: "lee@acme.test" }))).toEqual({ error: "That address is already in this workspace." });
  expect(await inviteMemberAction({}, form({ email: "bo@globex.test" }))).toEqual({ error: "That address already has a Trawler workspace, and joining a second one is not possible yet." });
  expect(state.calls).toEqual([]);
});

test("Better Auth's refusals are said in the page's words, and anything else it throws is not swallowed", async () => {
  const cases: Array<[string, string]> = [
    ["USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION", "That address is already invited. Its invitation is listed under Invited."],
    ["INVITATION_LIMIT_REACHED", "This workspace already has 100 invitations waiting. Revoke some before inviting more."],
    ["YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION", "Only an owner or admin of this workspace can change its settings."],
    ["SOMETHING_NEW", "The invitation could not be created. Try again."],
  ];
  for (const [code, message] of cases) {
    state.fails = refused(code);
    expect(await inviteMemberAction({}, form({ email: "new@acme.test" }))).toEqual({ error: message });
  }
  state.fails = new Error("database down");
  await expect(inviteMemberAction({}, form({ email: "new@acme.test" }))).rejects.toThrow("database down");
});

test("revoking takes only an invitation of this workspace that can still be used, and says whose it was", async () => {
  expect(await revokeInvitationAction({}, form({ invitationId: "inv-other" }))).toEqual({ done: "That invitation was already revoked, used or expired." });
  expect(await revokeInvitationAction({}, form({ invitationId: "inv-1" }))).toEqual({ done: "The invitation for max@acme.test is revoked." });
  expect(state.asked).toEqual(["invitations:org-1", "invitations:org-1"]);
  expect(state.calls).toEqual([["cancelInvitation", { invitationId: "inv-1" }]]);
});

test("removing takes only someone in this workspace, never yourself, and a workspace keeps an owner", async () => {
  expect(await removeMemberAction({}, form({ memberId: "m-elsewhere" }))).toEqual({ done: "That person is no longer in this workspace." });
  expect(await removeMemberAction({}, form({ memberId: "m-1" }))).toEqual({ error: "You cannot remove yourself from the workspace here." });
  expect(await removeMemberAction({}, form({ memberId: "m-2" }))).toEqual({ done: "Lee is removed from this workspace." });
  expect(await removeMemberAction({}, form({ memberId: "m-3" }))).toEqual({ done: "co@acme.test is removed from this workspace." });
  expect(state.calls).toEqual([["removeMember", { memberIdOrEmail: "m-2", organizationId: "org-1" }], ["removeMember", { memberIdOrEmail: "m-3", organizationId: "org-1" }]]);
  state.fails = refused("YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER");
  expect(await removeMemberAction({}, form({ memberId: "m-3" }))).toEqual({ error: "A workspace keeps at least one owner." });
});

test("a role switches between member and admin for someone else in this workspace who is not an owner", async () => {
  expect(await changeRoleAction({}, form({ memberId: "m-2", role: "admin" }))).toEqual({ done: "Lee is now an admin." });
  expect(await changeRoleAction({}, form({ memberId: "m-2", role: "member" }))).toEqual({ done: "Lee is now a member." });
  expect(await changeRoleAction({}, form({ memberId: "m-2", role: "owner" }))).toEqual({ done: "Lee is now a member." });
  expect(await changeRoleAction({}, form({ memberId: "m-1", role: "member" }))).toEqual({ error: "You cannot change your own role." });
  expect(await changeRoleAction({}, form({ memberId: "m-3", role: "member" }))).toEqual({ error: "An owner's role is not changed here." });
  expect(await changeRoleAction({}, form({ memberId: "m-elsewhere", role: "admin" }))).toEqual({ error: "That person is no longer in this workspace." });
  expect(state.calls).toEqual([
    ["updateMemberRole", { memberId: "m-2", role: "admin", organizationId: "org-1" }],
    ["updateMemberRole", { memberId: "m-2", role: "member", organizationId: "org-1" }],
    ["updateMemberRole", { memberId: "m-2", role: "member", organizationId: "org-1" }],
  ]);
  expect(state.asked.every((a) => a === "members:org-1")).toBe(true);
});
