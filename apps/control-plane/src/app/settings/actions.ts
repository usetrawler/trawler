"use server";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { WORKSPACE_NAME_RULE } from "../../auth/plugins.ts";
import { modelKeyHint, removeModelKey, setModelKey } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { freshEndpoint, withinListingLimit } from "../../llm/key-input.ts";
import { checkKey, PROVIDER_LABEL } from "../../llm/providers.ts";
import { cancelLiveRuns } from "../../runs/runs.ts";
import { canManageBilling, getAuth, signedInMember, type Member } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";

export interface MembersState {
  error?: string;
  done?: string;
  invited?: string;
}

export interface SettingsState {
  error?: string;
  field?: "key" | "baseUrl";
  saved?: boolean;
  unchecked?: boolean;
  stoppedRuns?: number;
  alreadyRemoved?: boolean;
}

const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its settings.";
const KEY_CHANGED = "The key changed since this page was loaded, so it was not removed. The page now shows the current key.";
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

async function manager(): Promise<Member | { error: string }> {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  return canManageBilling(member) ? member : { error: OWNERS_AND_ADMINS };
}

export async function renameWorkspaceAction(_previous: SettingsState, form: FormData): Promise<SettingsState> {
  const member = await manager();
  if ("error" in member) return member;
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: sentence(WORKSPACE_NAME_RULE) };
  try {
    await getAuth().api.updateOrganization({ headers: await headers(), body: { organizationId: member.orgId, data: { name } } });
  } catch (err) {
    if (err instanceof APIError) return { error: sentence(String((err.body as { message?: unknown } | undefined)?.message ?? err.message)) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { saved: true };
}

export async function replaceModelKeyAction(_previous: SettingsState, form: FormData): Promise<SettingsState> {
  const member = await manager();
  if ("error" in member) return member;
  const fresh = freshEndpoint({ key: String(form.get("apiKey") ?? ""), provider: String(form.get("provider") ?? ""), baseUrl: String(form.get("baseUrl") ?? "") }, readEnv().openRouterUrl);
  if ("error" in fresh) return fresh;
  const { endpoint } = fresh;
  if (!withinListingLimit(`key-check:${member.userId}`)) return { error: "Too many key checks. Wait a few minutes and try again." };
  const check = await checkKey(endpoint);
  if (!check.ok) {
    const provider = endpoint.provider === "custom" ? "The OpenAI-compatible service" : PROVIDER_LABEL[endpoint.provider];
    if (check.reason === "key") return { error: `${provider} refused this key. Copy it again from your provider, and check the provider picked below it.`, field: "key" };
    if (check.reason === "private") return { error: "That base URL is on a private network. Trawler calls models only at public addresses.", field: "baseUrl" };
    return { error: `${provider} could not be reached to check the key. Try again in a minute.` };
  }
  await withOrg(getDb(), member.orgId, (tx) => setModelKey(tx, member.orgId, { provider: endpoint.provider, key: endpoint.key, baseUrl: endpoint.provider === "custom" ? endpoint.baseUrl : null }, member.userId, getKeyring()));
  revalidatePath("/", "layout");
  return { saved: true, unchecked: !check.checked };
}

export async function removeModelKeyAction(_previous: SettingsState, form: FormData): Promise<SettingsState> {
  const member = await manager();
  if ("error" in member) return member;
  const addedAt = new Date(String(form.get("addedAt") ?? ""));
  const outcome = await withOrg(getDb(), member.orgId, async (tx) => {
    if (!Number.isNaN(addedAt.getTime()) && (await removeModelKey(tx, member.orgId, addedAt))) return { stoppedRuns: await cancelLiveRuns(tx, member.orgId, "key_removed") };
    return (await modelKeyHint(tx, member.orgId)) ? { changed: true } : { alreadyRemoved: true };
  });
  revalidatePath("/", "layout");
  if ("stoppedRuns" in outcome) return { saved: true, stoppedRuns: outcome.stoppedRuns };
  return "changed" in outcome ? { error: KEY_CHANGED } : { saved: true, stoppedRuns: 0, alreadyRemoved: true };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roleFrom = (value: FormDataEntryValue | null) => (value === "admin" ? "admin" : "member");
const nameOf = (person: { name: string; email: string }) => person.name.trim() || person.email;
const isOwner = (role: string) => role.split(",").map((r) => r.trim()).includes("owner");

function refusal(err: APIError, fallback: string): string {
  switch ((err.body as { code?: unknown } | undefined)?.code) {
    case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
      return "That address is already invited. Its invitation is listed under Invited.";
    case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
      return "That address is already in this workspace.";
    case "INVITATION_LIMIT_REACHED":
      return "This workspace already has 100 invitations waiting. Revoke some before inviting more.";
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER":
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER":
      return "A workspace keeps at least one owner.";
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION":
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE":
    case "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION":
    case "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER":
    case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER":
      return OWNERS_AND_ADMINS;
    default:
      return fallback;
  }
}

async function throughAuth(call: () => Promise<unknown>, fallback: string): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    if (err instanceof APIError) return refusal(err, fallback);
    throw err;
  }
}

export async function inviteMemberAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await manager();
  if ("error" in member) return member;
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return { error: "Enter the email address they sign in with." };
  const auth = getAuth();
  const home = await auth.workspaceOfEmail(email);
  if (home === member.orgId) return { error: "That address is already in this workspace." };
  if (home) return { error: "That address already has a Trawler workspace, and joining a second one is not possible yet." };
  const refused = await throughAuth(async () => auth.api.createInvitation({ headers: await headers(), body: { email, role: roleFrom(form.get("role")), organizationId: member.orgId } }), "The invitation could not be created. Try again.");
  if (refused) return { error: refused };
  revalidatePath("/settings");
  return { invited: email };
}

export async function revokeInvitationAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await manager();
  if ("error" in member) return member;
  const auth = getAuth();
  const invitation = (await auth.pendingInvitations(member.orgId)).find((i) => i.id === String(form.get("invitationId") ?? ""));
  revalidatePath("/settings");
  if (!invitation) return { done: "That invitation was already revoked, used or expired." };
  const refused = await throughAuth(async () => auth.api.cancelInvitation({ headers: await headers(), body: { invitationId: invitation.id } }), "The invitation could not be revoked. Try again.");
  return refused ? { error: refused } : { done: `The invitation for ${invitation.email} is revoked.` };
}

export async function removeMemberAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await manager();
  if ("error" in member) return member;
  const auth = getAuth();
  const target = (await auth.workspaceMembers(member.orgId)).find((m) => m.id === String(form.get("memberId") ?? ""));
  revalidatePath("/settings");
  if (!target) return { done: "That person is no longer in this workspace." };
  if (target.userId === member.userId) return { error: "You cannot remove yourself from the workspace here." };
  const refused = await throughAuth(async () => auth.api.removeMember({ headers: await headers(), body: { memberIdOrEmail: target.id, organizationId: member.orgId } }), "They could not be removed. Try again.");
  return refused ? { error: refused } : { done: `${nameOf(target)} is removed from this workspace.` };
}

export async function changeRoleAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await manager();
  if ("error" in member) return member;
  const auth = getAuth();
  const target = (await auth.workspaceMembers(member.orgId)).find((m) => m.id === String(form.get("memberId") ?? ""));
  revalidatePath("/settings");
  if (!target) return { error: "That person is no longer in this workspace." };
  if (target.userId === member.userId) return { error: "You cannot change your own role." };
  if (isOwner(target.role)) return { error: "An owner's role is not changed here." };
  const role = roleFrom(form.get("role"));
  const refused = await throughAuth(async () => auth.api.updateMemberRole({ headers: await headers(), body: { memberId: target.id, role, organizationId: member.orgId } }), "Their role could not be changed. Try again.");
  return refused ? { error: refused } : { done: `${nameOf(target)} is now ${role === "admin" ? "an admin" : "a member"}.` };
}
