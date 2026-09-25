"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { GoalSchema, PersonaSchema } from "@usetrawler/protocol";
import { withOrg } from "../../../db/tenancy.ts";
import { addAccount, projectForEditing, removeAccount, replacePlan } from "../../../projects/projects.ts";
import { getAuth } from "../../../server/auth.ts";
import { getDb, getKeyring } from "../../../server/db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PlanInput = z.object({ personas: z.array(PersonaSchema).max(20), goals: z.array(GoalSchema).max(20) });

export interface AccountView {
  ref: string;
  username: string;
  hint: string;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function member(projectId: string): Promise<string | null> {
  if (!UUID.test(projectId)) return null;
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.session.activeOrganizationId ?? null;
}

async function accountsOf(orgId: string, projectId: string): Promise<AccountView[]> {
  const project = await withOrg(getDb(), orgId, (tx) => projectForEditing(tx, orgId, projectId));
  return (project?.accounts ?? []).map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }));
}

export async function savePlanAction(projectId: string, plan: unknown): Promise<Result> {
  const orgId = await member(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to save." };
  const parsed = PlanInput.safeParse(plan);
  if (!parsed.success) return { ok: false, error: "Every person needs a name and a description, and every goal needs some text." };
  if (parsed.data.personas.length === 0) return { ok: false, error: "Keep at least one person." };
  if (parsed.data.goals.length === 0) return { ok: false, error: "Keep at least one goal." };
  try {
    await withOrg(getDb(), orgId, (tx) => replacePlan(tx, orgId, projectId, parsed.data));
    return { ok: true };
  } catch (err) {
    console.error("plan could not be saved", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "The plan could not be saved. Check for duplicate names and try again." };
  }
}

export async function addAccountAction(projectId: string, input: { username: string; password: string }): Promise<Result<{ accounts: AccountView[]; ref: string }>> {
  const orgId = await member(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to add an account." };
  const username = String(input?.username ?? "").trim();
  const password = String(input?.password ?? "");
  if (!username) return { ok: false, error: "Enter the username or email the account signs in with." };
  if (password.length < 8) return { ok: false, error: "The password must be at least 8 characters." };
  try {
    const ref = await withOrg(getDb(), orgId, (tx) => addAccount(tx, orgId, projectId, { username, password }, getKeyring()));
    return { ok: true, ref, accounts: await accountsOf(orgId, projectId) };
  } catch (err) {
    console.error("account could not be added", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "The account could not be added." };
  }
}

export async function removeAccountAction(projectId: string, ref: string): Promise<Result<{ accounts: AccountView[] }>> {
  const orgId = await member(projectId);
  if (!orgId || typeof ref !== "string") return { ok: false, error: "Sign in again to remove an account." };
  try {
    await withOrg(getDb(), orgId, (tx) => removeAccount(tx, orgId, projectId, ref));
    return { ok: true, accounts: await accountsOf(orgId, projectId) };
  } catch {
    return { ok: false, error: "The account could not be removed." };
  }
}
