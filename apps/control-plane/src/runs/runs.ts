import { sql } from "kysely";
import type { ProjectConfig } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { loadProjectConfig } from "../projects/projects.ts";

export interface StartRunOptions {
  budgetUsd: number;
  agentModel: string;
  judgeModel: string;
  maxSteps: number;
  replaySteps: number;
  createdBy: string;
}

export function withoutSecrets(config: ProjectConfig) {
  return {
    ...config,
    accounts: config.accounts.map((a) => ({ ref: a.ref, username: a.username })),
    httpCredentials: config.httpCredentials ? { username: config.httpCredentials.username } : undefined,
    secretHeaders: Object.keys(config.secretHeaders),
  };
}

export type ConfigSnapshot = ReturnType<typeof withoutSecrets>;

export async function startRun(tx: Tx, orgId: string, projectId: string, keys: Keyring, options: StartRunOptions): Promise<{ id: string; number: number }> {
  const config = await loadProjectConfig(tx, orgId, projectId, keys);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`runs:${orgId}`}, 0))`.execute(tx);
  const { next } = await tx.selectFrom("runs").select(sql<number>`coalesce(max(number), 0) + 1`.as("next")).where("org_id", "=", orgId).executeTakeFirstOrThrow();
  const run = await tx
    .insertInto("runs")
    .values({
      org_id: orgId, project_id: projectId, number: next, config_snapshot: JSON.stringify(withoutSecrets(config)),
      agent_model: options.agentModel, judge_model: options.judgeModel, budget_usd: options.budgetUsd.toFixed(4),
      max_steps: options.maxSteps, replay_steps: options.replaySteps, created_by: options.createdBy,
    })
    .returning(["id", "number"])
    .executeTakeFirstOrThrow();
  await tx.insertInto("jobs").values(config.personas.map((p, i) => ({ org_id: orgId, run_id: run.id, kind: "role_session", position: i, persona_key: p.id }))).execute();
  return run;
}

export async function cancelRun(tx: Tx, orgId: string, runId: string): Promise<void> {
  const run = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!run) throw new Error("run not found");
  if (run.status !== "queued" && run.status !== "running") return;
  await tx.updateTable("runs").set({ status: "cancelled", finished_at: new Date() }).where("id", "=", runId).execute();
  await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", runId).where("status", "=", "queued").execute();
}

export async function runSummary(tx: Tx, orgId: string, runId: string) {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "number", "status", "cost_usd", "budget_usd", "agent_model", "judge_model", "created_at", "started_at", "finished_at", "project_id"])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!run) return null;
  const [jobs, findings, goals] = await Promise.all([
    tx.selectFrom("jobs").select(["id", "kind", "status", "persona_key", "finding_key", "usage", "stopped_by", "error"]).where("run_id", "=", runId).orderBy("position").execute(),
    tx.selectFrom("findings").select(["key", "persona_key", "kind", "goal", "title", "observed", "reproduction", "severity", "replay", "verdict"]).where("run_id", "=", runId).orderBy("created_at").orderBy("key").execute(),
    tx.selectFrom("goal_outcomes").select(["persona_key", "goal", "status", "note"]).where("run_id", "=", runId).orderBy("persona_key").orderBy("goal").execute(),
  ]);
  return {
    id: run.id, number: run.number, status: run.status, projectId: run.project_id,
    costUsd: Number(run.cost_usd), budgetUsd: Number(run.budget_usd), agentModel: run.agent_model, judgeModel: run.judge_model,
    createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    jobs,
    findings: findings.map((f) => ({ key: f.key, personaKey: f.persona_key, kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: f.reproduction, severity: f.severity, replay: f.replay, verdict: f.verdict })),
    goals: goals.map((g) => ({ personaKey: g.persona_key, goal: g.goal, status: g.status, note: g.note })),
  };
}
