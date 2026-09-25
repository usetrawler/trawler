"use server";
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { WORKSPACE_NAME_RULE } from "../../auth/plugins.ts";
import { removeModelKey, setModelKey } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { freshEndpoint, withinListingLimit } from "../../llm/key-input.ts";
import { listModels, PROVIDER_LABEL } from "../../llm/providers.ts";
import { canManageBilling, getAuth } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";

export interface SettingsState {
  error?: string;
  saved?: boolean;
}

const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can change its settings.";
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

async function manager(): Promise<{ orgId: string; userId: string; requestHeaders: Headers } | { error: string }> {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { error: "Your account has no workspace yet." };
  if (!(await canManageBilling(requestHeaders))) return { error: OWNERS_AND_ADMINS };
  return { orgId, userId: session.user.id, requestHeaders };
}

export async function renameWorkspaceAction(_previous: SettingsState, form: FormData): Promise<SettingsState> {
  const who = await manager();
  if ("error" in who) return who;
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: sentence(WORKSPACE_NAME_RULE) };
  try {
    await getAuth().api.updateOrganization({ headers: who.requestHeaders, body: { organizationId: who.orgId, data: { name } } });
  } catch (err) {
    if (err instanceof APIError) return { error: sentence(String((err.body as { message?: unknown } | undefined)?.message ?? err.message)) };
    throw err;
  }
  revalidatePath("/", "layout");
  return { saved: true };
}

export async function replaceModelKeyAction(_previous: SettingsState, form: FormData): Promise<SettingsState> {
  const who = await manager();
  if ("error" in who) return who;
  const fresh = freshEndpoint({ key: String(form.get("apiKey") ?? ""), provider: String(form.get("provider") ?? ""), baseUrl: String(form.get("baseUrl") ?? "") }, readEnv().openRouterUrl);
  if ("error" in fresh) return fresh;
  const { endpoint } = fresh;
  if (!withinListingLimit(who.userId)) return { error: "Too many key checks. Wait a few minutes and try again." };
  try {
    await listModels(endpoint);
  } catch {
    return { error: `${PROVIDER_LABEL[endpoint.provider]} did not list models for this key. Check the key and the provider.` };
  }
  await withOrg(getDb(), who.orgId, (tx) => setModelKey(tx, who.orgId, { provider: endpoint.provider, key: endpoint.key, baseUrl: endpoint.provider === "custom" ? endpoint.baseUrl : null }, who.userId, getKeyring()));
  revalidatePath("/", "layout");
  return { saved: true };
}

export async function removeModelKeyAction(): Promise<SettingsState> {
  const who = await manager();
  if ("error" in who) return who;
  await withOrg(getDb(), who.orgId, (tx) => removeModelKey(tx, who.orgId));
  revalidatePath("/", "layout");
  return { saved: true };
}
