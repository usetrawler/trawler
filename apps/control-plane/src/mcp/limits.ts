import { sql } from "kysely";
import type { Tx } from "../db/tenancy.ts";

export const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 3_600_000;

export const SPEND_LIMIT_BOUNDS = { runsPerDay: { min: 1, max: 50 }, spendUsdPerDay: { min: 1, max: 500 } };
export const DEFAULT_SPEND_LIMIT = { runsPerDay: 5, spendUsdPerDay: 20 };
export const MCP_MAX_CAP_USD = 20;

export interface SpendLimit {
  runsPerDay: number;
  spendUsdPerDay: number;
}

export function spendLimitFrom(body: Record<string, unknown>): SpendLimit | "invalid" | null {
  if (body.max_runs === undefined && body.max_spend_usd === undefined) return null;
  const runs = body.max_runs === undefined ? DEFAULT_SPEND_LIMIT.runsPerDay : Number(body.max_runs);
  const spend = body.max_spend_usd === undefined ? DEFAULT_SPEND_LIMIT.spendUsdPerDay : Number(body.max_spend_usd);
  const { runsPerDay, spendUsdPerDay } = SPEND_LIMIT_BOUNDS;
  if (!Number.isInteger(runs) || runs < runsPerDay.min || runs > runsPerDay.max) return "invalid";
  if (!Number.isFinite(spend) || spend < spendUsdPerDay.min || spend > spendUsdPerDay.max) return "invalid";
  return { runsPerDay: runs, spendUsdPerDay: Math.round(spend * 100) / 100 };
}

export interface WindowRun {
  startedAt: Date;
  live: boolean;
  unpriced?: boolean;
  budgetUsd: number;
  costUsd: number;
}

const held = (run: WindowRun) => (run.live ? Math.max(run.budgetUsd, run.costUsd) : run.unpriced ? Math.max(run.budgetUsd, run.costUsd) : run.costUsd);
const leavesAt = (run: WindowRun) => new Date(run.startedAt.getTime() + WINDOW_MS);
const usd = (amount: number) => `$${amount.toFixed(2)}`;

export interface Usage {
  runs: number;
  spentUsd: number;
  runsFreeAt: Date | null;
  spendFreeAt: (neededUsd: number) => Date | null;
}

export function usageOf(runs: WindowRun[], limit: SpendLimit): Usage {
  const spentUsd = runs.reduce((sum, r) => sum + held(r), 0);
  return {
    runs: runs.length,
    spentUsd,
    runsFreeAt: runs.length >= limit.runsPerDay ? leavesAt(runs[runs.length - limit.runsPerDay]!) : null,
    spendFreeAt: (needed) => {
      let freed = 0;
      for (const run of runs) {
        freed += held(run);
        if (freed >= needed) return leavesAt(run);
      }
      return null;
    },
  };
}

export class SpendLimitReached extends Error {
  constructor(readonly limit: "runs" | "spend" | "cap" | "revoked", message: string) {
    super(message);
  }
}

export function refusalFor(runs: WindowRun[], limit: SpendLimit, capUsd: number): SpendLimitReached | null {
  const usage = usageOf(runs, limit);
  if (usage.runs + 1 > limit.runsPerDay) {
    return new SpendLimitReached("runs", `This connection may start ${limit.runsPerDay} ${limit.runsPerDay === 1 ? "run" : "runs"} in ${WINDOW_HOURS} hours and has started ${usage.runs}. A start frees up at ${usage.runsFreeAt!.toISOString()}. You can raise the limit by connecting again.`);
  }
  if (capUsd > limit.spendUsdPerDay) {
    return new SpendLimitReached("cap", `A run with a cap of ${usd(capUsd)} cannot fit this connection's limit of ${usd(limit.spendUsdPerDay)} in ${WINDOW_HOURS} hours. Start it with a lower cap.`);
  }
  const left = limit.spendUsdPerDay - usage.spentUsd;
  if (capUsd > left + 1e-9) {
    const freeAt = usage.spendFreeAt(capUsd - left);
    return new SpendLimitReached("spend", `This connection's limit is ${usd(limit.spendUsdPerDay)} in ${WINDOW_HOURS} hours and ${usd(Math.max(0, left))} is left, so a run with a cap of ${usd(capUsd)} does not fit.${freeAt ? ` Enough frees up at ${freeAt.toISOString()}.` : ""} Start it with a lower cap or wait.`);
  }
  return null;
}

async function windowRuns(tx: Tx, orgId: string, grantId: string): Promise<WindowRun[]> {
  const rows = await tx.selectFrom("runs").select(["created_at", "status", "budget_usd", "cost_usd", "token_cap", sql<boolean>`EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = runs.id AND (j.status = 'leased' OR (j.status = 'queued' AND j.requested_by IS NOT NULL)))`.as("working")])
    .where("org_id", "=", orgId)
    .where(sql<boolean>`started_via ->> 'grant' = ${grantId}`)
    .where("created_at", ">", sql<Date>`now() - ${sql.lit(`${WINDOW_HOURS} hours`)}::interval`)
    .orderBy("created_at").orderBy("id").execute();
  return rows.map((r) => ({ startedAt: r.created_at, live: r.status === "queued" || r.status === "running" || r.working, unpriced: r.token_cap !== null, budgetUsd: Number(r.budget_usd), costUsd: Number(r.cost_usd) }));
}

async function limitOf(tx: Tx, orgId: string, grantId: string): Promise<(SpendLimit & { revoked: boolean }) | null> {
  const grant = await tx.selectFrom("mcp_grants").select(["max_runs_per_day", "max_spend_usd_per_day", "revoked_at"]).where("id", "=", grantId).where("org_id", "=", orgId).executeTakeFirst();
  return grant ? { runsPerDay: grant.max_runs_per_day, spendUsdPerDay: Number(grant.max_spend_usd_per_day), revoked: grant.revoked_at !== null } : null;
}

export async function reserveSpend(tx: Tx, orgId: string, grantId: string, capUsd: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-limit:${grantId}`}, 0))`.execute(tx);
  const limit = await limitOf(tx, orgId, grantId);
  if (!limit || limit.revoked) throw new SpendLimitReached("revoked", "This connection was disconnected, so it cannot start runs.");
  const refused = refusalFor(await windowRuns(tx, orgId, grantId), limit, capUsd);
  if (refused) throw refused;
}

export interface ConnectionUsage extends SpendLimit {
  runs: number;
  spentUsd: number;
  nextFreeAt: Date | null;
}

export async function connectionUsage(tx: Tx, orgId: string, grantId: string): Promise<ConnectionUsage | null> {
  const limit = await limitOf(tx, orgId, grantId);
  if (!limit) return null;
  const runs = await windowRuns(tx, orgId, grantId);
  const usage = usageOf(runs, limit);
  return { runsPerDay: limit.runsPerDay, spendUsdPerDay: limit.spendUsdPerDay, runs: usage.runs, spentUsd: usage.spentUsd, nextFreeAt: runs[0] ? leavesAt(runs[0]) : null };
}
