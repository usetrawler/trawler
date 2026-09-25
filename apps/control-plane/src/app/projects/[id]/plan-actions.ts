"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { GoalSchema, MAX_GOALS, MAX_PERSONAS, PersonaSchema, TargetAccountSchema } from "@usetrawler/protocol";
import { withOrg } from "../../../db/tenancy.ts";
import { AccountLimit, addAccount, projectForEditing, removeAccount, replacePlan, UnknownAccount } from "../../../projects/projects.ts";
import { getAuth } from "../../../server/auth.ts";
import { getDb, getKeyring } from "../../../server/db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (schema: z.ZodString) => z.string().trim().pipe(schema);
const PlanInput = z.object({
  personas: z.array(PersonaSchema.extend({ name: text(PersonaSchema.shape.name), brief: text(PersonaSchema.shape.brief) })).max(MAX_PERSONAS),
  goals: z.array(GoalSchema.extend({ instruction: text(GoalSchema.shape.instruction) })).max(MAX_GOALS),
});
const AccountInput = TargetAccountSchema.omit({ ref: true }).extend({ username: text(TargetAccountSchema.shape.username) });

export interface AccountView {
  ref: string;
  username: string;
  hint: string;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function activeOrg(projectId: string): Promise<string | null> {
  if (!UUID.test(projectId)) return null;
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.session.activeOrganizationId ?? null;
}

async function accountsOf(orgId: string, projectId: string): Promise<AccountView[]> {
  const project = await withOrg(getDb(), orgId, (tx) => projectForEditing(tx, orgId, projectId));
  return (project?.accounts ?? []).map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }));
}

export async function savePlanAction(projectId: string, plan: unknown): Promise<Result | { ok: false; error: string; accounts: AccountView[] }> {
  const orgId = await activeOrg(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to save." };
  const parsed = PlanInput.safeParse(plan);
  if (!parsed.success) return { ok: false, error: "Every person needs a name and a description, and every goal needs some text." };
  if (parsed.data.personas.length === 0) return { ok: false, error: "Keep at least one person." };
  if (parsed.data.goals.length === 0) return { ok: false, error: "Keep at least one goal." };
  try {
    await withOrg(getDb(), orgId, (tx) => replacePlan(tx, orgId, projectId, parsed.data));
    return { ok: true };
  } catch (err) {
    if (err instanceof UnknownAccount) return { ok: false, error: "An account you picked was removed. Choose another one and save again.", accounts: await accountsOf(orgId, projectId) };
    console.error("plan could not be saved", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "The plan could not be saved. Try again." };
  }
}

export async function addAccountAction(projectId: string, input: { username: string; password: string }): Promise<Result<{ accounts: AccountView[]; ref: string }>> {
  const orgId = await activeOrg(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to add an account." };
  const parsed = AccountInput.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { ok: false, error: field === "password" ? "The password must be 8 to 1000 characters." : "Enter the username or email the account signs in with (up to 320 characters)." };
  }
  try {
    const ref = await withOrg(getDb(), orgId, (tx) => addAccount(tx, orgId, projectId, parsed.data, getKeyring()));
    return { ok: true, ref, accounts: await accountsOf(orgId, projectId) };
  } catch (err) {
    if (err instanceof AccountLimit) return { ok: false, error: err.message.replace(/^a/, "A") + "." };
    console.error("account could not be added", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "The account could not be added." };
  }
}

export async function removeAccountAction(projectId: string, ref: string): Promise<Result<{ accounts: AccountView[] }>> {
  const orgId = await activeOrg(projectId);
  if (!orgId || typeof ref !== "string" || ref.length > 100) return { ok: false, error: "Sign in again to remove an account." };
  try {
    await withOrg(getDb(), orgId, (tx) => removeAccount(tx, orgId, projectId, ref));
    return { ok: true, accounts: await accountsOf(orgId, projectId) };
  } catch {
    return { ok: false, error: "The account could not be removed." };
  }
}
