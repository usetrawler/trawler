import { createHash } from "node:crypto";
import type { LeadTurn } from "@usetrawler/core/setup";
import type { PullRequest } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";

export const RECENT_PR_PLANS = 20;

export interface PrKey {
  repo: string;
  number: number;
}

export interface StoredPrPlan {
  id: string;
  version: number;
  inputsHash: string;
  turns: LeadTurn[];
  createdByRun: number | null;
}

export const prKey = (pr: PullRequest | undefined): PrKey | null => (pr?.number ? { repo: (pr.repository ?? "").trim().toLowerCase(), number: pr.number } : null);

const squash = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

export const inputsHash = (pr: PullRequest) =>
  createHash("sha256")
    .update(JSON.stringify([squash(pr.title), squash(pr.description), [...new Set((pr.changedFiles ?? []).map((f) => f.trim()))].sort()]))
    .digest("hex");

const current = (tx: Tx, projectId: string, planId: string, key: PrKey) =>
  tx.selectFrom("pr_plans as p").where("p.project_id", "=", projectId).where("p.plan_id", "=", planId).where("p.repo", "=", key.repo).where("p.number", "=", key.number).where("p.superseded_at", "is", null);

export async function currentPrPlan(tx: Tx, projectId: string, planId: string, key: PrKey): Promise<StoredPrPlan | null> {
  const row = await current(tx, projectId, planId, key)
    .leftJoin("runs as r", "r.id", "p.created_by_run_id")
    .select(["p.id", "p.version", "p.inputs_hash", "p.lead_output", "r.number as created_by_number"])
    .executeTakeFirst();
  return row ? { id: row.id, version: row.version, inputsHash: row.inputs_hash, turns: (row.lead_output as unknown as { turns: LeadTurn[] }).turns, createdByRun: row.created_by_number } : null;
}

export async function storePrPlan(tx: Tx, plan: { orgId: string; projectId: string; planId: string; key: PrKey; hash: string; turns: LeadTurn[]; runId: string }): Promise<{ id: string; version: number }> {
  const { orgId, projectId, planId, key } = plan;
  const previous = await current(tx, projectId, planId, key).select("p.id").forUpdate().executeTakeFirst();
  if (previous) await tx.updateTable("pr_plans").set({ superseded_at: new Date() }).where("id", "=", previous.id).execute();
  const latest = await tx.selectFrom("pr_plans").select((eb) => eb.fn.max("version").as("version")).where("project_id", "=", projectId).where("plan_id", "=", planId).where("repo", "=", key.repo).where("number", "=", key.number).executeTakeFirst();
  return tx
    .insertInto("pr_plans")
    .values({
      org_id: orgId, project_id: projectId, plan_id: planId, repo: key.repo, number: key.number, version: (latest?.version ?? 0) + 1, inputs_hash: plan.hash,
      lead_output: JSON.stringify({ turns: plan.turns }), created_by_run_id: plan.runId, last_used_run_id: plan.runId,
    })
    .returning(["id", "version"])
    .executeTakeFirstOrThrow();
}

export async function markPrPlanUsed(tx: Tx, id: string, runId: string): Promise<void> {
  await tx.updateTable("pr_plans").set({ last_used_run_id: runId, last_used_at: new Date() }).where("id", "=", id).execute();
}

export async function recentPrPlans(tx: Tx, orgId: string, projectId: string, planId: string) {
  const rows = await tx
    .selectFrom("pr_plans as p")
    .leftJoin("runs as r", "r.id", "p.last_used_run_id")
    .select(["p.id", "p.repo", "p.number", "p.version", "p.lead_output", "r.number as last_run"])
    .where("p.org_id", "=", orgId)
    .where("p.project_id", "=", projectId)
    .where("p.plan_id", "=", planId)
    .where("p.superseded_at", "is", null)
    .orderBy("p.last_used_at", "desc")
    .limit(RECENT_PR_PLANS)
    .execute();
  return rows.map((r) => ({ id: r.id, repo: r.repo, number: r.number, version: r.version, turns: (r.lead_output as unknown as { turns: LeadTurn[] }).turns, lastRun: r.last_run }));
}
