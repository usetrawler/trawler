import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { turnsOf, type ProjectConfig, type RunEvent, type Verdict } from "@usetrawler/protocol";
import { modelKey } from "../credentials/credentials.ts";
import type { Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import type { Price } from "../llm/prices.ts";
import type { Provider } from "../llm/providers.ts";
import { loadProjectConfig, ProjectNotFound } from "../projects/projects.ts";
import { budgetLeft, budgetSpentMessage, HALTED, monthlyBudget, PAUSED, projectPaused, runsHalted, type MonthlyBudget } from "./limits.ts";
import { gaveNoVerdict } from "./report.ts";
import { runTitle } from "./status.ts";

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

export const signUpSeedContext = (orgId: string, runId: string) => [orgId, "run", runId, "sign_up_seed"];

export class NeedsAccount extends Error {
  constructor(readonly person: string) {
    super(`${person} needs a test account to sign in.`);
  }
}

export async function personWithoutAccount(tx: Tx, projectId: string): Promise<string | null> {
  const person = await tx.selectFrom("personas").select("name").where("project_id", "=", projectId).where("signs_in", "=", true).where("account_ref", "is", null).orderBy("position").executeTakeFirst();
  return person?.name ?? null;
}

export class RunRefused extends Error {}

export class RunInProgress extends RunRefused {
  constructor(readonly run: { id: string; number: number }) {
    super(`${runTitle(run.number)} is still going on this project. Wait for it to finish or stop it, then start again.`);
  }
}

export class WorkspaceBudgetSpent extends RunRefused {
  constructor(readonly budget: MonthlyBudget) {
    super(budgetSpentMessage(budget));
  }
}

export async function activeRunOf(tx: Tx, projectId: string): Promise<{ id: string; number: number } | null> {
  return (await tx.selectFrom("runs").select(["id", "number"]).where("project_id", "=", projectId).where("status", "in", ["queued", "running"]).executeTakeFirst()) ?? null;
}

export async function refusalToStart(tx: Tx, orgId: string, projectId: string): Promise<RunRefused | null> {
  const active = await activeRunOf(tx, projectId);
  return active ? new RunInProgress(active) : refusalToRun(tx, orgId, projectId);
}

async function refusalToRun(tx: Tx, orgId: string, projectId: string): Promise<RunRefused | null> {
  if (runsHalted()) return new RunRefused(HALTED);
  if (await projectPaused(tx, projectId)) return new RunRefused(PAUSED);
  const budget = await monthlyBudget(tx, orgId);
  if (budget && budgetLeft(budget) <= 0) return new WorkspaceBudgetSpent(budget);
  return null;
}

export async function startRun(tx: Tx, orgId: string, projectId: string, keys: Keyring, options: StartRunOptions): Promise<{ id: string; number: number }> {
  await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forShare().execute();
  const config = await loadProjectConfig(tx, orgId, projectId, keys);
  const without = await personWithoutAccount(tx, projectId);
  if (without) throw new NeedsAccount(without);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`runs:${orgId}`}, 0))`.execute(tx);
  const refused = await refusalToStart(tx, orgId, projectId);
  if (refused) throw refused;
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
  await tx.updateTable("runs").set({ sign_up_seed: keys.encrypt(randomBytes(24).toString("base64url"), signUpSeedContext(orgId, run.id)) }).where("id", "=", run.id).execute();
  const accounts = [...new Set(config.personas.flatMap((p) => (p.accountRef ? [p.accountRef] : [])))];
  if (accounts.length) {
    await tx.insertInto("jobs").values(accounts.map((ref, i) => ({ org_id: orgId, run_id: run.id, kind: "account_check", position: i - accounts.length, account_ref: ref }))).execute();
  }
  await tx.insertInto("jobs").values(turnsOf(config).map((turn, i) => ({ org_id: orgId, run_id: run.id, kind: "role_session", position: i, persona_key: turn.personaId }))).execute();
  return run;
}

export class RunNotFound extends Error {
  constructor() {
    super("run not found");
  }
}

export type CancelReason = "stopped" | "key_removed" | "account_refused" | "time_limit" | "workspace_budget" | "paused" | "halted";

export const ACCOUNT_REFUSED = "The product refused the username and password of";

export async function endRun(tx: Tx, runId: string, end: { status: "stopped_budget" } | { status: "cancelled"; reason: CancelReason }): Promise<void> {
  await tx.updateTable("runs").set({ status: end.status, cancel_reason: end.status === "cancelled" ? end.reason : null, finished_at: new Date(), sign_up_seed: null }).where("id", "=", runId).execute();
  await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", runId).where("status", "=", "queued").execute();
}

export async function cancelRun(tx: Tx, orgId: string, runId: string, reason: CancelReason): Promise<boolean> {
  const run = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!run) throw new RunNotFound();
  if (run.status !== "queued" && run.status !== "running") return false;
  await endRun(tx, runId, { status: "cancelled", reason });
  return true;
}

export async function cancelLiveRuns(tx: Tx, orgId: string, reason: CancelReason): Promise<number> {
  const live = await tx.selectFrom("runs").select("id").where("org_id", "=", orgId).where("status", "in", ["queued", "running"]).forUpdate().execute();
  let cancelled = 0;
  for (const run of live) if (await cancelRun(tx, orgId, run.id, reason)) cancelled++;
  return cancelled;
}

export async function pauseProject(tx: Tx, orgId: string, projectId: string, userId: string): Promise<number> {
  const project = await tx.selectFrom("projects").select("paused_at").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  if (project.paused_at === null) await tx.updateTable("projects").set({ paused_at: new Date(), paused_by: userId }).where("id", "=", projectId).execute();
  const live = await tx.selectFrom("runs").select("id").where("project_id", "=", projectId).where("org_id", "=", orgId).where("status", "in", ["queued", "running"]).execute();
  let stopped = 0;
  for (const run of live) if (await cancelRun(tx, orgId, run.id, "paused")) stopped++;
  return stopped;
}

export async function resumeProject(tx: Tx, orgId: string, projectId: string): Promise<void> {
  const resumed = await tx.updateTable("projects").set({ paused_at: null, paused_by: null }).where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!resumed.numUpdatedRows) throw new ProjectNotFound();
}

export const affordableOutputTokens = (leftUsd: number, completionUsdPerMtok: number | null) =>
  completionUsdPerMtok !== null && completionUsdPerMtok > 0 ? Math.floor((leftUsd * 1_000_000) / completionUsdPerMtok) : Infinity;

export function outOfBudget(run: { costUsd: number; budgetUsd: number; tokenCap: number | null; tokensUsed: number; completionUsdPerMtok: number | null }): boolean {
  const left = run.budgetUsd - run.costUsd;
  if (left <= 0 || (run.tokenCap !== null && run.tokensUsed >= run.tokenCap)) return true;
  return affordableOutputTokens(left, run.completionUsdPerMtok) < 1;
}

export const capSpent = (run: { cost_usd: string; budget_usd: string; token_cap: string | null; tokens_used: string; completion_usd_per_mtok: string | null }) =>
  outOfBudget({
    costUsd: Number(run.cost_usd), budgetUsd: Number(run.budget_usd), tokenCap: run.token_cap === null ? null : Number(run.token_cap), tokensUsed: Number(run.tokens_used),
    completionUsdPerMtok: run.completion_usd_per_mtok === null ? null : Number(run.completion_usd_per_mtok),
  });

export class CannotJudgeAgain extends Error {}

export async function judgeAgain(tx: Tx, orgId: string, runId: string, findingKey: string, requestedBy: string, keys: Keyring): Promise<void> {
  const run = await tx
    .selectFrom("runs")
    .select(["status", "project_id", "cost_usd", "budget_usd", "token_cap", "tokens_used", "completion_usd_per_mtok", "provider", "provider_base_url"])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .forUpdate()
    .executeTakeFirst();
  if (!run) throw new CannotJudgeAgain("This run was not found.");
  if (run.status === "queued" || run.status === "running") throw new CannotJudgeAgain("The run is still going. You can judge it again once it has finished.");
  const refused = await refusalToRun(tx, orgId, run.project_id);
  if (refused) throw new CannotJudgeAgain(refused.message);
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
    .select(["id", "number", "status", "cost_usd", "budget_usd", "agent_model", "judge_model", "created_at", "started_at", "finished_at", "project_id", "config_snapshot", "provider", "token_cap", "tokens_used", "completion_usd_per_mtok", "cancel_reason"])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!run) return null;
  const snapshot = run.config_snapshot as unknown as ConfigSnapshot;
  const goalText = new Map(snapshot.goals.map((g) => [g.id, g.instruction]));
  const [jobs, findings, goals, activity, screenshots] = await Promise.all([
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
    tx
      .selectFrom("artifacts as a")
      .innerJoin("jobs as j", "j.id", "a.job_id")
      .select(["a.id", "a.finding_key", "j.kind"])
      .where("a.run_id", "=", runId)
      .where("a.kind", "=", "screenshot")
      .where("a.stored_at", "is not", null)
      .where("a.discarded_at", "is", null)
      .orderBy("a.created_at")
      .orderBy("a.id")
      .execute(),
  ]);
  const findingTitle = new Map(findings.map((f) => [f.key, f.title]));
  const latestScreenshot = (key: string, kind: string) => screenshots.filter((a) => a.finding_key === key && a.kind === kind).at(-1)?.id ?? null;
  return {
    id: run.id, number: run.number, status: run.status, cancelReason: run.cancel_reason as CancelReason | null, projectId: run.project_id,
    costUsd: Number(run.cost_usd), budgetUsd: Number(run.budget_usd), completionUsdPerMtok: run.completion_usd_per_mtok === null ? null : Number(run.completion_usd_per_mtok), agentModel: run.agent_model, judgeModel: run.judge_model,
    provider: run.provider, tokenCap: run.token_cap === null ? null : Number(run.token_cap), tokensUsed: Number(run.tokens_used),
    createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    jobs,
    findings: findings.map((f) => ({
      key: f.key, personaKey: f.persona_key, kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: f.reproduction, severity: f.severity, replay: f.replay, verdict: f.verdict,
      screenshots: { reported: latestScreenshot(f.key, "role_session"), replayed: latestScreenshot(f.key, "replay") },
    })),
    goals: goals.map((g) => ({ personaKey: g.persona_key, goal: g.goal, status: g.status, note: g.note })),
    target: snapshot.targetUrl,
    personas: snapshot.personas.map((p) => ({ id: p.id, name: p.name })),
    goalTexts: snapshot.goals.map((g) => ({ id: g.id, instruction: g.instruction, ...(g.personaId ? { personaId: g.personaId } : {}) })),
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
