"use server";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { WORKSPACE_NAME_RULE } from "../../auth/plugins.ts";
import { removeModelKey, setModelKey } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { freshEndpoint, withinListingLimit } from "../../llm/key-input.ts";
import { checkKey, PROVIDER_LABEL } from "../../llm/providers.ts";
import { cancelLiveRuns } from "../../runs/runs.ts";
import { canManageBilling, getAuth, signedInMember, type Member } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";

export interface SettingsState {
  error?: string;
  saved?: boolean;
  unchecked?: boolean;
  stoppedRuns?: number;
}

const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its settings.";
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
  if (!withinListingLimit(member.userId)) return { error: "Too many key checks. Wait a few minutes and try again." };
  const check = await checkKey(endpoint);
  if (!check.ok) {
    const provider = PROVIDER_LABEL[endpoint.provider];
    if (check.reason === "key") return { error: `${provider} refused this key. Copy it again from your provider, and check the provider picked below it.` };
    if (check.reason === "private") return { error: "That base URL is on a private network. Hosted runs reach only public addresses; the local runner reaches private ones." };
    return { error: `${provider} could not be reached to check the key. Try again in a minute.` };
  }
  await withOrg(getDb(), member.orgId, (tx) => setModelKey(tx, member.orgId, { provider: endpoint.provider, key: endpoint.key, baseUrl: endpoint.provider === "custom" ? endpoint.baseUrl : null }, member.userId, getKeyring()));
  revalidatePath("/", "layout");
  return { saved: true, unchecked: !check.checked };
}

export async function removeModelKeyAction(): Promise<SettingsState> {
  const member = await manager();
  if ("error" in member) return member;
  const stoppedRuns = await withOrg(getDb(), member.orgId, async (tx) => {
    await removeModelKey(tx, member.orgId);
    return cancelLiveRuns(tx, member.orgId);
  });
  revalidatePath("/", "layout");
  return { saved: true, stoppedRuns };
}
