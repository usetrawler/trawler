import { sql } from "kysely";
import { MAX_PERSONAS } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";

export type WorkspacePlanName = "free" | "team" | "enterprise";

export interface PlanLimits {
  projects: number;
  runsPerDay: number;
  people: number;
}

export interface WorkspacePlan {
  plan: WorkspacePlanName;
  limits: PlanLimits;
}

export const PLAN_LABEL: Record<WorkspacePlanName, string> = { free: "Free", team: "Team", enterprise: "Enterprise" };

export const PLAN_LIMITS: Record<WorkspacePlanName, PlanLimits> = {
  free: { projects: 1, runsPerDay: 3, people: 4 },
  team: { projects: 3, runsPerDay: 30, people: MAX_PERSONAS },
  enterprise: { projects: Infinity, runsPerDay: Infinity, people: MAX_PERSONAS },
};

const CONTACT = "contact@usetrawler.com";

export async function workspacePlan(tx: Tx, orgId: string): Promise<WorkspacePlan> {
  const row = await tx.selectFrom("workspace_plans").select(["plan", "extra_projects"]).where("org_id", "=", orgId).executeTakeFirst();
  const plan = (row?.plan ?? "free") as WorkspacePlanName;
  const limits = PLAN_LIMITS[plan];
  return { plan, limits: { ...limits, projects: limits.projects + (row?.extra_projects ?? 0) } };
}

export async function projectsCounted(tx: Tx, orgId: string): Promise<number> {
  const row = await tx.selectFrom("projects").select(sql<string>`count(*)`.as("n")).where("org_id", "=", orgId).where("demo", "=", false).executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function runsToday(tx: Tx, orgId: string): Promise<number> {
  const row = await tx
    .selectFrom("runs")
    .select(sql<string>`count(*)`.as("n"))
    .where("org_id", "=", orgId)
    .where("created_at", ">=", sql<Date>`date_trunc('day', now(), 'UTC')`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

const moreOn = (plan: WorkspacePlanName) => (plan === "free" ? `write to ${CONTACT} about the Team plan` : `write to ${CONTACT} to raise it`);
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function projectLimitMessage({ plan, limits }: WorkspacePlan): string {
  return `The ${PLAN_LABEL[plan]} plan includes ${counted(limits.projects, "project", "projects")}, and this workspace has ${counted(limits.projects, "project", "projects")} already. Plan new runs on the one you have, test other products on your own machine with the local runner, or ${moreOn(plan)}.`;
}

export function runsPerDayMessage({ plan, limits }: WorkspacePlan): string {
  return `The ${PLAN_LABEL[plan]} plan includes ${counted(limits.runsPerDay, "hosted run", "hosted runs")} a day, and this workspace has started them all today. Try again after midnight UTC, run it on your own machine with the local runner, or ${moreOn(plan)}.`;
}

export function peopleLimitMessage({ plan, limits }: WorkspacePlan, people: number): string {
  return `The ${PLAN_LABEL[plan]} plan takes up to ${limits.people} people in a run, and this plan has ${people}. Remove people from the plan, run it on your own machine with the local runner, or ${moreOn(plan)}.`;
}

export async function projectLimitReached(tx: Tx, orgId: string): Promise<WorkspacePlan | null> {
  const plan = await workspacePlan(tx, orgId);
  return (await projectsCounted(tx, orgId)) >= plan.limits.projects ? plan : null;
}

export class ProjectLimitReached extends Error {
  constructor(readonly plan: WorkspacePlan) {
    super(projectLimitMessage(plan));
  }
}

export async function claimProjectSlot(tx: Tx, orgId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`projects:${orgId}`}, 0))`.execute(tx);
  const reached = await projectLimitReached(tx, orgId);
  if (reached) throw new ProjectLimitReached(reached);
}
