import { APIError } from "better-auth/api";
import { beforeEach, expect, test, vi } from "vitest";

type Person = { id: string; userId: string; role: string; joinedAt: Date; name: string; email: string };
const state = vi.hoisted(() => ({
  member: null as null | { userId: string; name: string; email: string; orgId: string; orgName: string; role: string },
  people: [] as Person[],
  invitations: [] as Array<{ id: string; email: string; role: string; expiresAt: Date }>,
  asked: [] as string[],
  calls: [] as Array<[string, unknown]>,
  fails: null as null | Error,
  revalidated: [] as unknown[][],
  logged: [] as Array<[string, Record<string, unknown>]>,
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
      api: { createInvitation: api("createInvitation"), cancelInvitation: api("cancelInvitation"), removeMember: api("removeMember"), updateMemberRole: api("updateMemberRole") },
    }),
  };
});
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));
vi.mock("../../server/log.ts", () => ({ logError: async (message: string, fields: Record<string, unknown>) => { state.logged.push([message, fields]); } }));

const { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } = await import("./actions.ts");
const owner = { userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const refused = (code: string) => new APIError("BAD_REQUEST", { code, message: code });
const SETTINGS = ["/settings"];
let invitingAs = 0;
const inviter = () => ({ ...owner, userId: `inviter-${++invitingAs}` });

beforeEach(() => {
  Object.assign(state, {
    member: inviter(), asked: [], calls: [], fails: null, revalidated: [], logged: [],
    people: [
      { id: "m-1", userId: "user-1", role: "owner", joinedAt: new Date(), name: "Ana", email: "ana@acme.test" },
      { id: "m-2", userId: "user-2", role: "member", joinedAt: new Date(), name: "Lee", email: "lee@acme.test" },
      { id: "m-3", userId: "user-3", role: "owner", joinedAt: new Date(), name: "", email: "co@acme.test" },
      { id: "m-4", userId: "user-4", role: "admin", joinedAt: new Date(), name: "", email: "bo@acme.test" },
    ],
    invitations: [{ id: "inv-1", email: "max@acme.test", role: "member", expiresAt: new Date() }],
  });
});

test("only an owner or admin changes who is in the workspace; a member is told so, the list is refreshed, and nothing is asked of Better Auth", async () => {
  state.member = { ...owner, role: "member" };
  const refusal = { error: "Only an owner or admin of this workspace can invite people or change who is in it." };
  expect(await inviteMemberAction({}, form({ email: "new@acme.test" }))).toEqual(refusal);
  expect(await revokeInvitationAction({}, form({ invitationId: "inv-1" }))).toEqual(refusal);
  expect(await removeMemberAction({}, form({ memberId: "m-2" }))).toEqual(refusal);
  expect(await changeRoleAction({}, form({ memberId: "m-2", role: "admin" }))).toEqual(refusal);
  expect(state.calls).toEqual([]);
  expect(state.revalidated).toEqual([SETTINGS, SETTINGS, SETTINGS, SETTINGS]);
});

test("an invitation goes to the lowercased address, as member unless admin is asked for, in the inviter's own workspace", async () => {
  state.member = { ...owner, userId: "user-1" };
  expect(await inviteMemberAction({}, form({ email: "  New.Person@Acme.test ", role: "admin" }))).toEqual({ invited: "new.person@acme.test" });
  expect(await inviteMemberAction({}, form({ email: "other@acme.test", role: "owner" }))).toEqual({ invited: "other@acme.test" });
  expect(state.calls).toEqual([
    ["createInvitation", { email: "new.person@acme.test", role: "admin", organizationId: "org-1" }],
    ["createInvitation", { email: "other@acme.test", role: "member", organizationId: "org-1" }],
  ]);
  expect(state.revalidated).toEqual([SETTINGS, SETTINGS]);
});

test("an address that is not one is refused before Better Auth is asked, and so is one Better Auth does not take", async () => {
  expect(await inviteMemberAction({}, form({ email: "not an address" }))).toEqual({ error: "Enter the email address they sign in with." });
  expect(await inviteMemberAction({}, form({ email: `${"a".repeat(250)}@b.cd` }))).toEqual({ error: "Enter the email address they sign in with." });
  expect(state.calls).toEqual([]);
  state.fails = refused("INVALID_EMAIL");
  expect(await inviteMemberAction({}, form({ email: "someone@acme.c" }))).toEqual({ error: "Enter the email address they sign in with." });
});

test("a person invites at most 30 times in 10 minutes, refused attempts included", async () => {
  state.fails = refused("ADDRESS_HAS_A_WORKSPACE");
  for (let i = 0; i < 30; i++) await inviteMemberAction({}, form({ email: `probe-${i}@acme.test` }));
  expect(await inviteMemberAction({}, form({ email: "probe-30@acme.test" }))).toEqual({ error: "Too many invitations. Wait a few minutes and try again." });
  state.member = inviter();
  expect(await inviteMemberAction({}, form({ email: "probe-30@acme.test" }))).toEqual({ error: "That address already has a Trawler workspace, and joining a second one is not possible yet." });
});

test("Better Auth's refusals are said in the page's words; anything it does not name is logged, and anything else it throws is not swallowed", async () => {
  const cases: Array<[string, string]> = [
    ["ADDRESS_HAS_A_WORKSPACE", "That address already has a Trawler workspace, and joining a second one is not possible yet."],
    ["USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION", "That address is already in this workspace."],
    ["USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION", "That address is already invited. Its invitation is listed under Invited."],
    ["INVITATION_LIMIT_REACHED", "This workspace already has 100 invitations waiting. Revoke some before inviting more."],
    ["YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION", "Only an owner or admin of this workspace can invite people or change who is in it."],
    ["SOMETHING_NEW", "The invitation could not be created. Try again."],
  ];
  for (const [code, message] of cases) {
    state.fails = refused(code);
    expect(await inviteMemberAction({}, form({ email: "new@acme.test" }))).toEqual({ error: message });
  }
  expect(state.logged).toEqual([["a members change was refused for a reason the page does not name", { orgId: "org-1", code: "SOMETHING_NEW", err: state.fails }]]);
  expect(state.revalidated).toHaveLength(cases.length);
  state.fails = new Error("database down");
  await expect(inviteMemberAction({}, form({ email: "new@acme.test" }))).rejects.toThrow("database down");
});

test("revoking takes only an invitation of this workspace that can still be used, and says whose it was", async () => {
  expect(await revokeInvitationAction({}, form({ invitationId: "inv-other" }))).toEqual({ done: "That invitation was already revoked, used or expired." });
  expect(await revokeInvitationAction({}, form({ invitationId: "inv-1" }))).toEqual({ done: "The invitation for max@acme.test is revoked." });
  expect(state.asked).toEqual(["invitations:org-1", "invitations:org-1"]);
  expect(state.calls).toEqual([["cancelInvitation", { invitationId: "inv-1" }]]);
  expect(state.revalidated).toEqual([SETTINGS, SETTINGS]);
});

test("removing takes only someone in this workspace who is neither you nor an owner", async () => {
  state.member = { ...owner, userId: "user-1" };
  expect(await removeMemberAction({}, form({ memberId: "m-elsewhere" }))).toEqual({ done: "That person is no longer in this workspace." });
  expect(await removeMemberAction({}, form({ memberId: "m-1" }))).toEqual({ error: "You cannot remove yourself from the workspace here." });
  expect(await removeMemberAction({}, form({ memberId: "m-3" }))).toEqual({ error: "An owner is not removed here." });
  expect(await removeMemberAction({}, form({ memberId: "m-2" }))).toEqual({ done: "Lee is removed from this workspace." });
  expect(await removeMemberAction({}, form({ memberId: "m-4" }))).toEqual({ done: "bo@acme.test is removed from this workspace." });
  expect(state.calls).toEqual([["removeMember", { memberIdOrEmail: "m-2", organizationId: "org-1" }], ["removeMember", { memberIdOrEmail: "m-4", organizationId: "org-1" }]]);
  state.fails = refused("SOMETHING_NEW");
  expect(await removeMemberAction({}, form({ memberId: "m-2" }))).toEqual({ error: "They could not be removed. Try again." });
});

test("a role switches between member and admin for someone else in this workspace who is not an owner", async () => {
  state.member = { ...owner, userId: "user-1" };
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
