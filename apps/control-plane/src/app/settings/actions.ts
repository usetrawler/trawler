"use server";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADDRESS_HAS_A_WORKSPACE, WORKSPACE_NAME_RULE } from "../../auth/plugins.ts";
import { createApiToken, revokeApiToken, TokenLimit, TokenNameSchema, TokenProjectNotFound } from "../../api-tokens/tokens.ts";
import { modelKeyHint, removeModelKey, setModelKey } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { freshEndpoint, withinListingLimit } from "../../llm/key-input.ts";
import { checkKey, PROVIDER_LABEL } from "../../llm/providers.ts";
import { revokeGrant } from "../../mcp/oauth.ts";
import { setMcpSettings } from "../../mcp/settings.ts";
import { MONTHLY_BUDGET_RANGE, removeMonthlyBudget, setMonthlyBudget } from "../../runs/limits.ts";
import { cancelLiveRuns } from "../../runs/runs.ts";
import { canManageBilling, getAuth, signedInMember, type Member } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";
import { logError } from "../../server/log.ts";

export interface MembersState {
  error?: string;
  field?: "email";
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

export interface BudgetState {
  error?: string;
  saved?: boolean;
  removed?: boolean;
}

const BUDGET_RULE = `Set a monthly budget between $${MONTHLY_BUDGET_RANGE.min} and $${MONTHLY_BUDGET_RANGE.max.toLocaleString("en-US")}.`;

export async function setMonthlyBudgetAction(_previous: BudgetState, form: FormData): Promise<BudgetState> {
  const member = await manager();
  if ("error" in member) return member;
  const typed = String(form.get("monthly") ?? "").trim();
  const monthly = Math.round(Number(typed) * 100) / 100;
  if (!/^\d+(\.\d{1,2})?$/.test(typed) || monthly < MONTHLY_BUDGET_RANGE.min || monthly > MONTHLY_BUDGET_RANGE.max) return { error: BUDGET_RULE };
  await withOrg(getDb(), member.orgId, (tx) => setMonthlyBudget(tx, member.orgId, monthly, member.userId));
  revalidatePath("/", "layout");
  return { saved: true };
}

export async function removeMonthlyBudgetAction(_previous: BudgetState): Promise<BudgetState> {
  const member = await manager();
  if ("error" in member) return member;
  await withOrg(getDb(), member.orgId, (tx) => removeMonthlyBudget(tx, member.orgId));
  revalidatePath("/", "layout");
  return { removed: true };
}

export interface McpAccessState {
  error?: string;
  saved?: boolean;
  revokedGrants?: number;
  strippedGrants?: number;
}

export async function setMcpAccessAction(_previous: McpAccessState, form: FormData): Promise<McpAccessState> {
  const member = await manager();
  if ("error" in member) return member;
  if (form.get("org") !== member.orgId) return { error: "The workspace changed since this page was loaded. Reload the page, then change its MCP access." };
  const connectionsAllowed = form.get("connections") === "on";
  const runControlAllowed = connectionsAllowed && form.get("runControl") === "on";
  const changed = await withOrg(getDb(), member.orgId, (tx) => setMcpSettings(tx, member.orgId, { connectionsAllowed, runControlAllowed }, member.userId));
  revalidatePath("/", "layout");
  return { saved: true, ...changed };
}

export interface McpConnectionState {
  error?: string;
  revoked?: boolean;
}

export async function revokeMcpConnectionAction(_previous: McpConnectionState, form: FormData): Promise<McpConnectionState> {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const config = getAuth().mcp;
  const id = String(form.get("id") ?? "");
  if (!config || !/^[0-9a-f-]{36}$/i.test(id)) return { error: "That connection is not there any more." };
  const revoked = await revokeGrant(config.pool, id, member.userId);
  revalidatePath("/settings");
  return revoked ? { revoked: true } : { error: "That connection is not there any more." };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOT_AN_ADDRESS = "Enter the email address they sign in with.";
const MEMBERS_OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can invite people or change who is in it.";
const roleFrom = (value: FormDataEntryValue | null) => (value === "admin" ? "admin" : "member");
const nameOf = (person: { name: string; email: string }) => person.name.trim() || person.email;
const isOwner = (role: string) => role.split(",").map((r) => r.trim()).includes("owner");

async function membersManager(): Promise<Member | { error: string }> {
  const member = await manager();
  revalidatePath("/settings");
  return "error" in member ? { error: MEMBERS_OWNERS_AND_ADMINS } : member;
}

function refusal(code: unknown): MembersState | null {
  switch (code) {
    case "INVALID_EMAIL":
      return { error: NOT_AN_ADDRESS, field: "email" };
    case ADDRESS_HAS_A_WORKSPACE:
      return { error: "That address already has a Trawler workspace, and joining a second one is not possible yet.", field: "email" };
    case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
      return { error: "That address is already in this workspace.", field: "email" };
    case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
      return { error: "That address is already invited. Its invitation is listed under Invited.", field: "email" };
    case "INVITATION_LIMIT_REACHED":
      return { error: "This workspace already has 100 invitations waiting. Revoke some before inviting more." };
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION":
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE":
    case "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION":
    case "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER":
    case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER":
      return { error: MEMBERS_OWNERS_AND_ADMINS };
    default:
      return null;
  }
}

async function throughAuth(orgId: string, call: () => Promise<unknown>, fallback: string): Promise<MembersState | null> {
  try {
    await call();
    return null;
  } catch (err) {
    if (!(err instanceof APIError)) throw err;
    const code = (err.body as { code?: unknown } | undefined)?.code;
    const said = refusal(code);
    if (said) return said;
    await logError("a members change was refused for a reason the page does not name", { orgId, code: String(code), err });
    return { error: fallback };
  }
}

export async function inviteMemberAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await membersManager();
  if ("error" in member) return member;
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return { error: NOT_AN_ADDRESS, field: "email" };
  if (!withinListingLimit(`invite:${member.userId}`)) return { error: "Too many invitations. Wait a few minutes and try again." };
  const auth = getAuth();
  const refused = await throughAuth(member.orgId, async () => auth.api.createInvitation({ headers: await headers(), body: { email, role: roleFrom(form.get("role")), organizationId: member.orgId } }), "The invitation could not be created. Try again.");
  return refused ?? { invited: email };
}

export async function revokeInvitationAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await membersManager();
  if ("error" in member) return member;
  const auth = getAuth();
  const invitation = (await auth.pendingInvitations(member.orgId)).find((i) => i.id === String(form.get("invitationId") ?? ""));
  if (!invitation) return { done: "That invitation was already revoked, used or expired." };
  const refused = await throughAuth(member.orgId, async () => auth.api.cancelInvitation({ headers: await headers(), body: { invitationId: invitation.id } }), "The invitation could not be revoked. Try again.");
  return refused ?? { done: `The invitation for ${invitation.email} is revoked.` };
}

export async function removeMemberAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await membersManager();
  if ("error" in member) return member;
  const auth = getAuth();
  const target = (await auth.workspaceMembers(member.orgId)).find((m) => m.id === String(form.get("memberId") ?? ""));
  if (!target) return { done: "That person is no longer in this workspace." };
  if (target.userId === member.userId) return { error: "You cannot remove yourself from the workspace here." };
  if (isOwner(target.role)) return { error: "An owner is not removed here." };
  const refused = await throughAuth(member.orgId, async () => auth.api.removeMember({ headers: await headers(), body: { memberIdOrEmail: target.id, organizationId: member.orgId } }), "They could not be removed. Try again.");
  return refused ?? { done: `${nameOf(target)} is removed from this workspace.` };
}

export async function changeRoleAction(_previous: MembersState, form: FormData): Promise<MembersState> {
  const member = await membersManager();
  if ("error" in member) return member;
  const auth = getAuth();
  const target = (await auth.workspaceMembers(member.orgId)).find((m) => m.id === String(form.get("memberId") ?? ""));
  if (!target) return { error: "That person is no longer in this workspace." };
  if (target.userId === member.userId) return { error: "You cannot change your own role." };
  if (isOwner(target.role)) return { error: "An owner's role is not changed here." };
  const role = roleFrom(form.get("role"));
  const refused = await throughAuth(member.orgId, async () => auth.api.updateMemberRole({ headers: await headers(), body: { memberId: target.id, role, organizationId: member.orgId } }), "Their role could not be changed. Try again.");
  return refused ?? { done: `${nameOf(target)} is now ${role === "admin" ? "an admin" : "a member"}.` };
}

export interface ApiTokenState {
  error?: string;
  created?: { name: string; token: string };
  revoked?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can create or revoke API tokens.";

export async function createApiTokenAction(_previous: ApiTokenState, form: FormData): Promise<ApiTokenState> {
  const member = await manager();
  if ("error" in member) return { error: TOKEN_OWNERS_AND_ADMINS };
  const name = TokenNameSchema.safeParse(String(form.get("name") ?? ""));
  if (!name.success) return { error: "Give the token a name of up to 100 characters." };
  const project = String(form.get("project") ?? "");
  if (project && !UUID.test(project)) return { error: "That project is not in this workspace." };
  try {
    const made = await withOrg(getDb(), member.orgId, (tx) => createApiToken(tx, member.orgId, member.userId, { name: name.data, ...(project ? { projectId: project } : {}) }));
    revalidatePath("/settings");
    return { created: { name: name.data, token: made.token } };
  } catch (err) {
    if (err instanceof TokenLimit) return { error: "A workspace can hold at most 20 API tokens. Revoke one first." };
    if (err instanceof TokenProjectNotFound) return { error: "That project is not in this workspace." };
    await logError("an API token could not be created", { orgId: member.orgId, err });
    return { error: "The token could not be created. Try again." };
  }
}

export async function revokeApiTokenAction(_previous: ApiTokenState, form: FormData): Promise<ApiTokenState> {
  const member = await manager();
  if ("error" in member) return { error: TOKEN_OWNERS_AND_ADMINS };
  const id = String(form.get("id") ?? "");
  if (!UUID.test(id)) return { error: "That token is already gone." };
  const done = await withOrg(getDb(), member.orgId, (tx) => revokeApiToken(tx, member.orgId, id));
  revalidatePath("/settings");
  return done ? { revoked: true } : { error: "That token is already gone." };
}
