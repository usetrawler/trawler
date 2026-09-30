import { sql } from "kysely";
import type { Tx } from "../db/tenancy.ts";
import { PLAN_LIMITS, projectLimitMessage, type WorkspacePlan, type WorkspacePlanName } from "./plan-limits.ts";

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
