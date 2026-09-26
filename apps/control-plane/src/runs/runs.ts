import { sql } from "kysely";
import type { ProjectConfig, RunEvent, Verdict } from "@usetrawler/protocol";
import { modelKey } from "../credentials/credentials.ts";
import type { Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import type { Price } from "../llm/prices.ts";
import type { Provider } from "../llm/providers.ts";
import { loadProjectConfig } from "../projects/projects.ts";
import { gaveNoVerdict } from "./report.ts";

export interface StartRunOptions {
  budgetUsd: number;
  agentModel: string;
  judgeModel: string;
  maxSteps: number;
  replaySteps: number;
  createdBy: string;
  provider?: Provider;
  providerBaseUrl?: string | null;
  price?: Price | null;
  tokenCap?: number | null;
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
      provider: options.provider ?? "openrouter", provider_base_url: options.providerBaseUrl ?? null, token_cap: options.tokenCap ? String(options.tokenCap) : null,
      prompt_usd_per_mtok: options.price ? options.price.promptUsdPerMtok.toFixed(6) : null, completion_usd_per_mtok: options.price ? options.price.completionUsdPerMtok.toFixed(6) : null,
    })
    .returning(["id", "number"])
    .executeTakeFirstOrThrow();
  await tx.insertInto("jobs").values(config.personas.map((p, i) => ({ org_id: orgId, run_id: run.id, kind: "role_session", position: i, persona_key: p.id }))).execute();
  return run;
}

export class RunNotFound extends Error {
  constructor() {
    super("run not found");
  }
}

export async function cancelRun(tx: Tx, orgId: string, runId: string): Promise<boolean> {
  const run = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!run) throw new RunNotFound();
  if (run.status !== "queued" && run.status !== "running") return false;
  await tx.updateTable("runs").set({ status: "cancelled", finished_at: new Date() }).where("id", "=", runId).execute();
  await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", runId).where("status", "=", "queued").execute();
  return true;
}

export async function cancelLiveRuns(tx: Tx, orgId: string): Promise<number> {
  const live = await tx.selectFrom("runs").select("id").where("org_id", "=", orgId).where("status", "in", ["queued", "running"]).execute();
  let cancelled = 0;
  for (const run of live) if (await cancelRun(tx, orgId, run.id)) cancelled++;
  return cancelled;
}

export function capSpent(run: { cost_usd: string; budget_usd: string; token_cap: string | null; tokens_used: string }): boolean {
  const overTokens = run.token_cap !== null && Number(run.tokens_used) >= Number(run.token_cap);
  return Number(run.cost_usd) >= Number(run.budget_usd) || overTokens;
}

export class CannotJudgeAgain extends Error {}

export async function judgeAgain(tx: Tx, orgId: string, runId: string, findingKey: string, requestedBy: string, keys: Keyring): Promise<void> {
  const run = await tx
    .selectFrom("runs")
    .select(["status", "cost_usd", "budget_usd", "token_cap", "tokens_used", "provider", "provider_base_url"])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .forUpdate()
    .executeTakeFirst();
  if (!run) throw new CannotJudgeAgain("This run was not found.");
  if (run.status === "queued" || run.status === "running") throw new CannotJudgeAgain("The run is still going. You can judge it again once it has finished.");
  const latest = await tx
    .selectFrom("jobs")
    .select(["status", "stopped_by", sql<boolean>`requested_by is not null`.as("requested")])
    .where("run_id", "=", runId)
    .where("kind", "=", "judge")
    .where("finding_key", "=", findingKey)
    .orderBy("position", "desc")
    .executeTakeFirst();
  if (latest?.status === "queued" || latest?.status === "leased") throw new CannotJudgeAgain("It is already being judged again.");
  const finding = await tx.selectFrom("findings").select("verdict").where("run_id", "=", runId).where("key", "=", findingKey).executeTakeFirst();
  if (!latest || !finding || !gaveNoVerdict(latest, finding.verdict)) throw new CannotJudgeAgain("Only a defect whose judge gave no verdict can be judged again.");
  if (capSpent(run)) throw new CannotJudgeAgain("This run has spent its cap, so it cannot be judged again.");
  const stored = await modelKey(tx, orgId, keys);
  if (!stored || stored.provider !== run.provider || (run.provider === "custom" && stored.baseUrl !== run.provider_base_url)) {
    throw new CannotJudgeAgain("The workspace model key was removed or changed since this run, so this run's model cannot be called. Start a new run instead.");
  }
  const { next } = await tx.selectFrom("jobs").select(sql<number>`coalesce(max(position), -1) + 1`.as("next")).where("run_id", "=", runId).executeTakeFirstOrThrow();
  await tx.insertInto("jobs").values({ org_id: orgId, run_id: runId, kind: "judge", position: next, finding_key: findingKey, requested_by: requestedBy }).execute();
  await tx.updateTable("findings").set({ verdict: null, updated_at: new Date() }).where("run_id", "=", runId).where("key", "=", findingKey).execute();
}

export async function runSummary(tx: Tx, orgId: string, runId: string) {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "number", "status", "cost_usd", "budget_usd", "agent_model", "judge_model", "created_at", "started_at", "finished_at", "project_id", "config_snapshot", "provider", "token_cap", "tokens_used"])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!run) return null;
  const snapshot = run.config_snapshot as unknown as ConfigSnapshot;
  const goalText = new Map(snapshot.goals.map((g) => [g.id, g.instruction]));
  const [jobs, findings, goals, activity] = await Promise.all([
    tx.selectFrom("jobs").select(["id", "kind", "status", "persona_key", "finding_key", "usage", "stopped_by", "error", sql<boolean>`requested_by is not null`.as("requested")]).where("run_id", "=", runId).orderBy("position").execute(),
    tx.selectFrom("findings").select(["key", "persona_key", "kind", "goal", "title", "observed", "reproduction", "severity", "replay", "verdict"]).where("run_id", "=", runId).orderBy("created_at").orderBy("key").execute(),
    tx.selectFrom("goal_outcomes").select(["persona_key", "goal", "status", "note"]).where("run_id", "=", runId).orderBy("persona_key").orderBy("goal").execute(),
    tx
      .selectFrom("run_events as e")
      .innerJoin("jobs as j", "j.id", "e.job_id")
      .select(["e.id", "e.type", "e.at", "e.payload", "j.persona_key", "j.kind"])
      .where("e.run_id", "=", runId)
      .where("e.type", "in", ["note", "finding", "goal_status", "verdict"])
      .orderBy("e.id", "desc")
      .limit(8)
      .execute(),
  ]);
  const findingTitle = new Map(findings.map((f) => [f.key, f.title]));
  return {
    id: run.id, number: run.number, status: run.status, projectId: run.project_id,
    costUsd: Number(run.cost_usd), budgetUsd: Number(run.budget_usd), agentModel: run.agent_model, judgeModel: run.judge_model,
    provider: run.provider, tokenCap: run.token_cap === null ? null : Number(run.token_cap), tokensUsed: Number(run.tokens_used),
    createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    jobs,
    findings: findings.map((f) => ({ key: f.key, personaKey: f.persona_key, kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: f.reproduction, severity: f.severity, replay: f.replay, verdict: f.verdict })),
    goals: goals.map((g) => ({ personaKey: g.persona_key, goal: g.goal, status: g.status, note: g.note })),
    target: snapshot.targetUrl,
    personas: snapshot.personas.map((p) => ({ id: p.id, name: p.name })),
    goalTexts: snapshot.goals.map((g) => ({ id: g.id, instruction: g.instruction })),
    activity: activity.map((a) => ({ id: String(a.id), at: a.at, personaKey: a.persona_key, kind: a.kind, text: activityText(a.payload as unknown as RunEvent, goalText, findingTitle) })),
  };
}

export type RunSummary = NonNullable<Awaited<ReturnType<typeof runSummary>>>;

const VERDICT_LABEL: Record<Verdict, string> = { confirmed: "Confirmed", refuted: "Refuted", inconclusive: "Inconclusive" };

function activityText(e: RunEvent, goalText: Map<string, string>, findingTitle: Map<string, string>): string {
  if (e.type === "note") return e.text;
  if (e.type === "finding") return `${e.finding.kind === "defect" ? "Reported a defect" : "Noted friction"}: ${e.finding.title}`;
  if (e.type === "goal_status") return `Goal ${e.outcome.status === "reached" ? "reached" : "not reached"}: ${goalText.get(e.outcome.goal) ?? e.outcome.goal}`;
  if (e.type === "verdict") return `${VERDICT_LABEL[e.verdict]}: ${findingTitle.get(e.findingId) ?? e.findingId}`;
  return e.type;
}
