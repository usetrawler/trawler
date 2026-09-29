import { sql } from "kysely";
import type { Tx } from "../db/tenancy.ts";

export const RUN_TIME_LIMIT_HOURS = 3;
export const MONTHLY_BUDGET_RANGE = { min: 1, max: 100_000 };

export const runsHalted = (env: Record<string, string | undefined> = process.env) => /^(1|true|yes|on)$/i.test(env.TRAWLER_HALT_RUNS?.trim() ?? "");

export const HALTED = "Trawler has paused hosted runs for now. Try again later, or run it on your own machine with the local runner.";
export const PAUSED = "Runs on this project are paused. Resume them on the project's page, then start again.";

export const usd = (n: number) => `$${n.toFixed(2)}`;

export interface MonthlyBudget {
  limitUsd: number;
  spentUsd: number;
}

export async function monthSpent(tx: Tx, orgId: string): Promise<number> {
  const row = await tx
    .selectFrom("llm_usage")
    .select(sql<string>`coalesce(sum(cost_usd), 0)`.as("spent"))
    .where("org_id", "=", orgId)
    .where("paid_by", "=", "workspace")
    .where("created_at", ">=", sql<Date>`date_trunc('month', now(), 'UTC')`)
    .executeTakeFirstOrThrow();
  return Number(row.spent);
}

export async function monthlyBudget(tx: Tx, orgId: string): Promise<MonthlyBudget | null> {
  const budget = await tx.selectFrom("workspace_budgets").select("monthly_usd").where("org_id", "=", orgId).executeTakeFirst();
  if (!budget) return null;
  return { limitUsd: Number(budget.monthly_usd), spentUsd: await monthSpent(tx, orgId) };
}

export const budgetLeft = (budget: MonthlyBudget | null) => (budget ? budget.limitUsd - budget.spentUsd : Infinity);

export function budgetSpentMessage(budget: MonthlyBudget, now: Date = new Date()): string {
  const month = now.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `This workspace has spent its ${usd(budget.limitUsd)} monthly budget: ${usd(budget.spentUsd)} since ${month} 1 (UTC). An owner or admin can raise it in Settings.`;
}

export async function setMonthlyBudget(tx: Tx, orgId: string, monthlyUsd: number, setBy: string): Promise<void> {
  await tx
    .insertInto("workspace_budgets")
    .values({ org_id: orgId, monthly_usd: monthlyUsd.toFixed(2), set_by: setBy })
    .onConflict((oc) => oc.column("org_id").doUpdateSet({ monthly_usd: monthlyUsd.toFixed(2), set_by: setBy, set_at: new Date() }))
    .execute();
}

export async function removeMonthlyBudget(tx: Tx, orgId: string): Promise<void> {
  await tx.deleteFrom("workspace_budgets").where("org_id", "=", orgId).execute();
}

export async function projectPaused(tx: Tx, projectId: string): Promise<boolean> {
  const project = await tx.selectFrom("projects").select("paused_at").where("id", "=", projectId).executeTakeFirst();
  return project?.paused_at != null;
}
