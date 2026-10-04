"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { GoalSchema, MAX_GOALS, MAX_PERSONAS, PersonaSchema, TargetAccountSchema } from "@usetrawler/protocol";
import { withOrg } from "../../../db/tenancy.ts";
import { AccountLimit, addAccount, LastPlan, PlanInUse, PlanNameTaken, PlanNotFound, projectForEditing, ProjectNotFound, removeAccount, removePlan, renamePlan, replacePlan, UnknownAccount } from "../../../projects/projects.ts";
import { signedInMember } from "../../../server/auth.ts";
import { getDb, getKeyring } from "../../../server/db.ts";
import { logError, scrubberWith } from "../../../server/log.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (schema: z.ZodString) => z.string().trim().pipe(schema);
const PlanInput = z.object({
  personas: z.array(PersonaSchema.extend({ name: text(PersonaSchema.shape.name), brief: text(PersonaSchema.shape.brief), signsIn: z.boolean().optional() })).max(MAX_PERSONAS),
  goals: z.array(GoalSchema.extend({ instruction: text(GoalSchema.shape.instruction), personaId: GoalSchema.shape.personaId.unwrap() })).max(MAX_GOALS),
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
  return (await signedInMember(await headers()))?.orgId ?? null;
}

const PLAN_GONE = "This plan was removed. Reload the page and choose another.";

async function accountsOf(orgId: string, projectId: string, planId: string): Promise<AccountView[]> {
  const project = await withOrg(getDb(), orgId, (tx) => projectForEditing(tx, orgId, projectId, planId));
  return (project?.accounts ?? []).map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }));
}

export async function savePlanAction(projectId: string, planId: string, plan: unknown): Promise<Result | { ok: false; error: string; accounts: AccountView[] }> {
  const orgId = await activeOrg(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to save." };
  const parsed = PlanInput.safeParse(plan);
  if (!parsed.success) return { ok: false, error: "Every person needs a name and a description, and every goal needs some text." };
  if (parsed.data.personas.length === 0) return { ok: false, error: "Keep at least one person." };
  const idle = parsed.data.personas.find((p) => !parsed.data.goals.some((g) => g.personaId === p.id));
  if (idle) return { ok: false, error: `Give ${idle.name} at least one goal.` };
  try {
    const personas = parsed.data.personas.map(({ signsIn: _, ...persona }) => persona);
    const signsIn = parsed.data.personas.filter((p) => p.signsIn || p.accountRef).map((p) => p.id);
    await withOrg(getDb(), orgId, (tx) => replacePlan(tx, orgId, projectId, { personas, goals: parsed.data.goals }, signsIn, { planId }));
    return { ok: true };
  } catch (err) {
    if (err instanceof UnknownAccount) return { ok: false, error: "An account you picked was removed. Choose another one and save again.", accounts: await accountsOf(orgId, projectId, planId) };
    if (err instanceof PlanNotFound) return { ok: false, error: PLAN_GONE };
    if (!(err instanceof ProjectNotFound)) await logError("plan could not be saved", { orgId, projectId, planId, err });
    return { ok: false, error: "The plan could not be saved. Try again." };
  }
}

export async function addAccountAction(projectId: string, planId: string, input: { username: string; password: string }): Promise<Result<{ accounts: AccountView[]; ref: string }>> {
  const orgId = await activeOrg(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to add an account." };
  const parsed = AccountInput.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { ok: false, error: field === "password" ? "Enter the password the account signs in with (up to 1000 characters)." : "Enter the username or email the account signs in with (up to 320 characters)." };
  }
  try {
    const ref = await withOrg(getDb(), orgId, (tx) => addAccount(tx, orgId, projectId, parsed.data, getKeyring(), planId));
    return { ok: true, ref, accounts: await accountsOf(orgId, projectId, planId) };
  } catch (err) {
    if (err instanceof AccountLimit) return { ok: false, error: err.message.replace(/^a/, "A") + "." };
    if (err instanceof PlanNotFound) return { ok: false, error: PLAN_GONE };
    if (!(err instanceof ProjectNotFound)) await logError("account could not be added", { orgId, projectId, planId, err }, scrubberWith([parsed.data.password]));
    return { ok: false, error: "The account could not be added." };
  }
}

export async function removeAccountAction(projectId: string, planId: string, ref: string): Promise<Result<{ accounts: AccountView[] }>> {
  const orgId = await activeOrg(projectId);
  if (!orgId || typeof ref !== "string" || ref.length > 100) return { ok: false, error: "Sign in again to remove an account." };
  try {
    await withOrg(getDb(), orgId, (tx) => removeAccount(tx, orgId, projectId, ref, planId));
    return { ok: true, accounts: await accountsOf(orgId, projectId, planId) };
  } catch (err) {
    if (err instanceof PlanNotFound) return { ok: false, error: PLAN_GONE };
    if (!(err instanceof ProjectNotFound)) await logError("account could not be removed", { orgId, projectId, planId, err });
    return { ok: false, error: "The account could not be removed." };
  }
}

const PlanName = z.string().trim().min(1).max(100);

export async function renamePlanAction(projectId: string, planId: string, name: unknown): Promise<Result<{ name: string }>> {
  const orgId = await activeOrg(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to rename the plan." };
  const parsed = PlanName.safeParse(name);
  if (!parsed.success) return { ok: false, error: "Give the plan a name of up to 100 characters." };
  try {
    return { ok: true, name: await withOrg(getDb(), orgId, (tx) => renamePlan(tx, orgId, projectId, planId, parsed.data)) };
  } catch (err) {
    if (err instanceof PlanNameTaken) return { ok: false, error: "Another plan of this project already has that name." };
    if (err instanceof PlanNotFound) return { ok: false, error: PLAN_GONE };
    if (!(err instanceof ProjectNotFound)) await logError("plan could not be renamed", { orgId, projectId, planId, err });
    return { ok: false, error: "The plan could not be renamed. Try again." };
  }
}

export async function removePlanAction(projectId: string, planId: string): Promise<Result> {
  const orgId = await activeOrg(projectId);
  if (!orgId) return { ok: false, error: "Sign in again to remove the plan." };
  try {
    await withOrg(getDb(), orgId, (tx) => removePlan(tx, orgId, projectId, planId));
    return { ok: true };
  } catch (err) {
    if (err instanceof LastPlan) return { ok: false, error: "A project keeps at least one plan." };
    if (err instanceof PlanInUse) return { ok: false, error: "A run of this plan is going. Stop it or wait for it to finish, then remove the plan." };
    if (err instanceof PlanNotFound) return { ok: false, error: PLAN_GONE };
    if (!(err instanceof ProjectNotFound)) await logError("plan could not be removed", { orgId, projectId, planId, err });
    return { ok: false, error: "The plan could not be removed. Try again." };
  }
}
