import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { turnsOf, type Execution, type PlanMode, type ProjectConfig, type PullRequest, type RunEvent, type Verdict } from "@usetrawler/protocol";
import { modelKey } from "../credentials/credentials.ts";
import type { Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import type { Price } from "../llm/prices.ts";
import type { Provider } from "../llm/providers.ts";
import { loadProjectConfig, planOf, ProjectNotFound } from "../projects/projects.ts";
import { budgetLeft, budgetSpentMessage, HALTED, monthlyBudget, PAUSED, projectPaused, runsHalted, type MonthlyBudget } from "./limits.ts";
import { FIRST_RUN_ON_US } from "./models.ts";
import { accountsFor, DEFAULT_PLAN_MODE, hasPullRequestDetails, NOTHING, PR_PLAN_POSITION, storedPlanFor, type PrPlanRecord } from "./pr-plan.ts";
import { prKey, runPlanName, usePrPlan, type PrKey } from "./pr-plan-store.ts";
import { peopleLimitMessage, runsPerDayMessage, type WorkspacePlan } from "./plan-limits.ts";
import { runsToday, workspacePlan } from "./plans.ts";
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
  paidBy?: PaidBy;
  planId?: string;
  execution?: Execution;
  targetUrl?: string;
  pullRequest?: PullRequest;
  planMode?: PlanMode;
  replan?: boolean;
  conversation?: boolean;
  providedAccounts?: string[];
  usesFirstRunOnUs?: boolean;
}

export type PaidBy = "workspace" | "trawler";

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

const signsInWithoutAccount = (tx: Tx, planId: string) => tx.selectFrom("personas").select("name").where("plan_id", "=", planId).where("signs_in", "=", true).where("account_ref", "is", null);

export async function personWithoutAccount(tx: Tx, planId: string, provided: string[] = []): Promise<string | null> {
  const person = await signsInWithoutAccount(tx, planId).$if(provided.length > 0, (q) => q.where("name", "not in", provided)).orderBy("position").executeTakeFirst();
  return person?.name ?? null;
}

async function providedPeople(tx: Tx, planId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  return (await tx.selectFrom("personas").select("name").where("plan_id", "=", planId).where("account_ref", "is", null).where("name", "in", names).orderBy("position").execute()).map((p) => p.name);
}

export class RunRefused extends Error {}

export class ProvidedAccountsRefused extends RunRefused {
  constructor() {
    super("Accounts provided by the CI job can only reach a runner in your own network. Use execution \"own\", or leave the accounts out.");
  }
}

export class TargetOverrideRefused extends RunRefused {
  constructor() {
    super("A different target URL can only be tested by a runner in your own network. Use execution \"own\", or leave the URL out to test the project's target.");
  }
}

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

export class TooManyPeople extends RunRefused {
  constructor(readonly plan: WorkspacePlan, readonly people: number) {
    super(peopleLimitMessage(plan, people));
  }
}

export class FirstRunOnUsUsed extends RunRefused {
  constructor() {
    super("This workspace has used its first run on Trawler. Add a model key to start more runs.");
  }
}

export class TooManyForFirstRun extends RunRefused {
  constructor(readonly people: number) {
    super(`The first run on Trawler takes up to ${FIRST_RUN_ON_US.maxPeople} people, and this plan has ${people}. Remove people from the plan, or pay with your own model key.`);
  }
}

export async function firstRunOnUsLeft(tx: Tx, orgId: string): Promise<boolean> {
  return !(await tx.selectFrom("first_runs_on_us").select("org_id").where("org_id", "=", orgId).executeTakeFirst());
}

export async function giveBackUnusedFirstRun(tx: Tx, runId: string): Promise<void> {
  await tx
    .deleteFrom("first_runs_on_us")
    .where("run_id", "=", runId)
    .where("model_called_at", "is", null)
    .execute();
}

export const MAX_LIVE_OWN_RUNS = 5;

export class TooManyOwnRuns extends RunRefused {
  constructor() {
    super(`This workspace already has ${MAX_LIVE_OWN_RUNS} runs going in CI jobs, the most it may have at once. Wait for one to finish or stop one, then start again. A newer push to a pull request replaces its earlier run, so that does not add to the count.`);
  }
}

export interface LiveRun {
  id: string;
  number: number;
}

export interface StartScope {
  execution?: Execution;
  targetUrl?: string;
  pullRequest?: PullRequest;
}

const LIVE = ["queued", "running"];

const liveRuns = (tx: Tx, projectId: string) => tx.selectFrom("runs").select(["id", "number"]).where("project_id", "=", projectId).where("status", "in", LIVE).orderBy("number");

const ofPullRequest = (tx: Tx, projectId: string, key: PrKey) =>
  liveRuns(tx, projectId)
    .where(sql<boolean>`lower(btrim(coalesce(pull_request->>'repository', ''))) = ${key.repo}`)
    .where(sql<boolean>`pull_request->>'number' = ${String(key.number)}`);

const isolated = (scope: StartScope) => scope.execution === "own" && scope.targetUrl !== undefined;

export async function liveRunsOf(tx: Tx, projectId: string): Promise<LiveRun[]> {
  return liveRuns(tx, projectId).execute();
}

async function sharedRunOf(tx: Tx, projectId: string, except: string[]): Promise<LiveRun | null> {
  return (await liveRuns(tx, projectId).where("target_override", "=", false).$if(except.length > 0, (q) => q.where("id", "not in", except)).executeTakeFirst()) ?? null;
}

async function liveOwnRuns(tx: Tx, orgId: string, except: string[]): Promise<number> {
  const row = await tx
    .selectFrom("runs")
    .select(sql<string>`count(*)`.as("n"))
    .where("org_id", "=", orgId)
    .where("execution", "=", "own")
    .where("status", "in", LIVE)
    .$if(except.length > 0, (q) => q.where("id", "not in", except))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function replacedBy(tx: Tx, projectId: string, pullRequest: PullRequest | undefined): Promise<string[]> {
  const key = prKey(pullRequest);
  return key ? (await ofPullRequest(tx, projectId, key).execute()).map((r) => r.id) : [];
}

async function supersedeEarlierRuns(tx: Tx, orgId: string, projectId: string, pullRequest: PullRequest | undefined): Promise<void> {
  for (const id of await replacedBy(tx, projectId, pullRequest)) await cancelRun(tx, orgId, id, "superseded");
}

export interface ProjectRunState {
  paused: boolean;
  liveRun: (LiveRun & { more?: number }) | null;
}

const withMore = (live: LiveRun[]) => (live[0] ? { ...live[0], ...(live.length > 1 ? { more: live.length - 1 } : {}) } : null);

export async function projectRunState(tx: Tx, orgId: string, projectId: string): Promise<ProjectRunState | null> {
  const project = await tx.selectFrom("projects").select("paused_at").where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!project) return null;
  return { paused: project.paused_at !== null, liveRun: withMore(await liveRunsOf(tx, projectId)) };
}

export async function refusalToStart(tx: Tx, orgId: string, projectId: string, paidBy: PaidBy = "workspace", planId?: string, scope: StartScope = {}): Promise<RunRefused | null> {
  const replaced = await replacedBy(tx, projectId, scope.pullRequest);
  if (!isolated(scope)) {
    const shared = await sharedRunOf(tx, projectId, replaced);
    if (shared) return new RunInProgress(shared);
  }
  if (scope.execution === "own" && (await liveOwnRuns(tx, orgId, replaced)) >= MAX_LIVE_OWN_RUNS) return new TooManyOwnRuns();
  return refusalToRun(tx, orgId, projectId, paidBy, planId);
}

async function peopleOn(tx: Tx, planId: string): Promise<number> {
  const row = await tx.selectFrom("personas").select(sql<string>`count(*)`.as("n")).where("plan_id", "=", planId).executeTakeFirstOrThrow();
  return Number(row.n);
}

async function refusalToRun(tx: Tx, orgId: string, projectId: string, paidBy: PaidBy, planId?: string): Promise<RunRefused | null> {
  if (runsHalted()) return new RunRefused(HALTED);
  if (await projectPaused(tx, projectId)) return new RunRefused(PAUSED);
  const plan = await workspacePlan(tx, orgId);
  if ((await runsToday(tx, orgId)) >= plan.limits.runsPerDay) return new RunRefused(runsPerDayMessage(plan));
  if (paidBy === "workspace") {
    const budget = await monthlyBudget(tx, orgId);
    if (budget && budgetLeft(budget) < 0.01) return new WorkspaceBudgetSpent(budget);
  }
  const people = await peopleOn(tx, (await planOf(tx, orgId, projectId, planId)).id);
  return people > plan.limits.people ? new TooManyPeople(plan, people) : null;
}

export async function startRun(tx: Tx, orgId: string, projectId: string, keys: Keyring, options: StartRunOptions): Promise<{ id: string; number: number; people: number }> {
  await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forShare().execute();
  const plan = await planOf(tx, orgId, projectId, options.planId);
  const execution = options.execution ?? "hosted";
  if (options.targetUrl !== undefined && execution !== "own") throw new TargetOverrideRefused();
  const withTarget = (loaded: ProjectConfig) => (options.targetUrl === undefined ? loaded : { ...loaded, targetUrl: options.targetUrl, allowedOrigins: [...new Set([new URL(options.targetUrl).origin, ...loaded.allowedOrigins])] });
  const config = withTarget(await loadProjectConfig(tx, orgId, projectId, keys, plan.id));
  if (options.providedAccounts?.length && execution !== "own") throw new ProvidedAccountsRefused();
  const without = await personWithoutAccount(tx, plan.id, options.providedAccounts);
  if (without) throw new NeedsAccount(without);
  let providedAccounts = await providedPeople(tx, plan.id, options.providedAccounts ?? []);
  const paidBy = options.paidBy ?? "workspace";
  const planMode = options.planMode ?? DEFAULT_PLAN_MODE;
  let prPlan: PrPlanRecord | null = planMode !== "regression" && hasPullRequestDetails(options.pullRequest) ? { mode: planMode, goalIds: [] } : null;
  const usesFirstRunOnUs = paidBy === "trawler" && options.usesFirstRunOnUs !== false;
  if (usesFirstRunOnUs && config.personas.length > FIRST_RUN_ON_US.maxPeople) throw new TooManyForFirstRun(config.personas.length);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`runs:${orgId}`}, 0))`.execute(tx);
  await supersedeEarlierRuns(tx, orgId, projectId, options.pullRequest);
  const refused = await refusalToStart(tx, orgId, projectId, paidBy, plan.id, { execution, targetUrl: options.targetUrl, pullRequest: options.pullRequest });
  if (refused) throw refused;
  let planned = config;
  let ranOn = { id: plan.id, name: plan.name };
  const found = prPlan && !options.replan ? await storedPlanFor(tx, orgId, projectId, plan.id, options.pullRequest!, prPlan.mode, config) : null;
  const reuse = found && (found.merged || prPlan!.mode === "both") ? found : null;
  if (reuse) {
    const { merged, stored } = reuse;
    if (prPlan!.mode === "change") {
      await usePrPlan(tx, { orgId, projectId, id: stored.id, sourceId: plan.id, content: { personas: merged!.personas, goals: merged!.added } });
      planned = { ...withTarget(await loadProjectConfig(tx, orgId, projectId, keys, stored.id)), ...(stored.brief ? { brief: stored.brief } : {}) };
      ranOn = { id: stored.id, name: runPlanName(stored.name, stored.version) };
    } else {
      if (merged) planned = { ...config, personas: merged.personas, goals: merged.goals, ...(stored.brief ? { brief: stored.brief } : {}) };
      await tx.updateTable("plans").set({ last_used_at: new Date() }).where("id", "=", stored.id).execute();
    }
    const flow = await accountsFor(tx, plan.id, providedAccounts, stored.accountFlow);
    providedAccounts = flow.accounts;
    prPlan = {
      mode: prPlan!.mode, goalIds: merged?.added.map((g) => g.id) ?? [], ...(merged ? {} : { note: NOTHING }), prPlanId: stored.id, version: stored.version, reused: true, ...(stored.createdByRun ? { createdByRun: stored.createdByRun } : {}),
      accountFlow: stored.accountFlow, ...(stored.accountReason ? { accountReason: stored.accountReason } : {}), ...(merged && stored.brief ? { brief: stored.brief } : {}), signUps: flow.signUps,
    };
  }
  const turns = turnsOf(planned);
  const people = new Set(turns.map((t) => t.personaId)).size;
  const conversation = options.conversation === true && people > 1;
  const { next } = await tx.selectFrom("runs").select(sql<number>`coalesce(max(number), 0) + 1`.as("next")).where("org_id", "=", orgId).executeTakeFirstOrThrow();
  const run = await tx
    .insertInto("runs")
    .values({
      org_id: orgId, project_id: projectId, plan_id: ranOn.id, plan_name: ranOn.name, number: next, config_snapshot: JSON.stringify(withoutSecrets(options.pullRequest?.environment ? { ...planned, setup: options.pullRequest.environment } : planned)),
      agent_model: options.agentModel, judge_model: options.judgeModel, budget_usd: options.budgetUsd.toFixed(4),
      max_steps: options.maxSteps, replay_steps: options.replaySteps, created_by: options.createdBy,
      provider: options.provider ?? "openrouter", provider_base_url: options.providerBaseUrl ?? null, token_cap: options.tokenCap ? String(options.tokenCap) : null,
      prompt_usd_per_mtok: options.price ? options.price.promptUsdPerMtok.toFixed(6) : null, completion_usd_per_mtok: options.price ? options.price.completionUsdPerMtok.toFixed(6) : null,
      paid_by: paidBy, execution, target_override: options.targetUrl !== undefined, conversation, provided_accounts: JSON.stringify(providedAccounts), pull_request: options.pullRequest ? JSON.stringify(options.pullRequest) : null, pr_plan: prPlan ? JSON.stringify(prPlan) : null,
    })
    .returning(["id", "number"])
    .executeTakeFirstOrThrow();
  if (usesFirstRunOnUs) {
    const claimed = await tx.insertInto("first_runs_on_us").values({ org_id: orgId, run_id: run.id }).onConflict((oc) => oc.column("org_id").doNothing()).returning("org_id").executeTakeFirst();
    if (!claimed) throw new FirstRunOnUsUsed();
  }
  await tx.updateTable("runs").set({ sign_up_seed: keys.encrypt(randomBytes(24).toString("base64url"), signUpSeedContext(orgId, run.id)) }).where("id", "=", run.id).execute();
  if (!reuse && prPlan) await tx.insertInto("jobs").values({ org_id: orgId, run_id: run.id, kind: "pr_plan", position: PR_PLAN_POSITION }).execute();
  const accounts = [...new Set(planned.personas.flatMap((p) => (p.accountRef ? [p.accountRef] : [])))];
  if (accounts.length) {
    await tx.insertInto("jobs").values(accounts.map((ref, i) => ({ org_id: orgId, run_id: run.id, kind: "account_check", position: i - accounts.length, account_ref: ref }))).execute();
  }
  await tx.insertInto("jobs").values(turns.map((turn, i) => ({ org_id: orgId, run_id: run.id, kind: "role_session", position: i, persona_key: turn.personaId, together: conversation }))).execute();
  return { ...run, people };
}

export class RunNotFound extends Error {
  constructor() {
    super("run not found");
  }
}

export type CancelReason = "stopped" | "key_removed" | "account_refused" | "time_limit" | "workspace_budget" | "paused" | "halted" | "stopped_from_ci" | "unclaimed" | "ci_gone" | "superseded" | "nothing_to_test";

export const ACCOUNT_REFUSED = "The product refused the username and password of";

export async function endRun(tx: Tx, runId: string, end: { status: "stopped_budget" } | { status: "cancelled"; reason: CancelReason }): Promise<void> {
  await tx.updateTable("runs").set({ status: end.status, cancel_reason: end.status === "cancelled" ? end.reason : null, finished_at: new Date(), sign_up_seed: null }).where("id", "=", runId).execute();
  await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", runId).where("status", "=", "queued").execute();
  await giveBackUnusedFirstRun(tx, runId);
}

export async function cancelRun(tx: Tx, orgId: string, runId: string, reason: CancelReason): Promise<boolean> {
  const run = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!run) throw new RunNotFound();
  if (run.status !== "queued" && run.status !== "running") return false;
  await endRun(tx, runId, { status: "cancelled", reason });
  return true;
}

export async function cancelLiveRuns(tx: Tx, orgId: string, reason: CancelReason): Promise<number> {
  const live = await tx
    .selectFrom("runs")
    .select("id")
    .where("org_id", "=", orgId)
    .where("status", "in", ["queued", "running"])
    .$if(reason === "key_removed", (q) => q.where("paid_by", "=", "workspace"))
    .forUpdate()
    .execute();
  let cancelled = 0;
  for (const run of live) if (await cancelRun(tx, orgId, run.id, reason)) cancelled++;
  return cancelled;
}

export type PauseOutcome = { stopped: LiveRun | null; alsoStopped?: number } | { unconfirmed: LiveRun & { more?: number } };

export async function pauseProject(tx: Tx, orgId: string, projectId: string, userId: string, confirmedRunId: string | null = null): Promise<PauseOutcome> {
  const project = await tx.selectFrom("projects").select("paused_at").where("id", "=", projectId).where("org_id", "=", orgId).forNoKeyUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const live = await liveRunsOf(tx, projectId);
  const [first] = live;
  if (first && first.id !== confirmedRunId) return { unconfirmed: withMore(live)! };
  if (project.paused_at === null) await tx.updateTable("projects").set({ paused_at: new Date(), paused_by: userId }).where("id", "=", projectId).execute();
  const stoppedIds = new Set<string>();
  for (const run of live) if (await cancelRun(tx, orgId, run.id, "paused")) stoppedIds.add(run.id);
  const alsoStopped = stoppedIds.size - (first && stoppedIds.has(first.id) ? 1 : 0);
  return { stopped: first && stoppedIds.has(first.id) ? first : null, ...(alsoStopped > 0 ? { alsoStopped } : {}) };
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
    .select(["status", "project_id", "cost_usd", "budget_usd", "token_cap", "tokens_used", "completion_usd_per_mtok", "provider", "provider_base_url", "paid_by"])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .forUpdate()
    .executeTakeFirst();
  if (!run) throw new CannotJudgeAgain("This run was not found.");
  if (run.status === "queued" || run.status === "running") throw new CannotJudgeAgain("The run is still going. You can judge it again once it has finished.");
  if (runsHalted()) throw new CannotJudgeAgain("Trawler has paused hosted runs for now, so nothing can be judged again. Try again later.");
  if (await projectPaused(tx, run.project_id)) throw new CannotJudgeAgain("Runs on this project are paused. Resume them on the project's page, then judge it again.");
  const budget = run.paid_by === "trawler" ? null : await monthlyBudget(tx, orgId);
  const left = budgetLeft(budget);
  if (budget && (left <= 0 || affordableOutputTokens(left, run.completion_usd_per_mtok === null ? null : Number(run.completion_usd_per_mtok)) < 1)) throw new CannotJudgeAgain(budgetSpentMessage(budget));
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
  if (await tx.selectFrom("finding_dismissals").select("run_id").where("run_id", "=", runId).where("finding_key", "=", findingKey).executeTakeFirst()) throw new CannotJudgeAgain("It is marked not a bug. Undo that to judge it again.");
  if (capSpent(run)) throw new CannotJudgeAgain("This run has spent its cap, so it cannot be judged again.");
  const stored = run.paid_by === "trawler" ? null : await modelKey(tx, orgId, keys);
  if (run.paid_by !== "trawler" && (!stored || stored.provider !== run.provider || (run.provider === "custom" && stored.baseUrl !== run.provider_base_url))) {
    throw new CannotJudgeAgain("The workspace model key was removed or changed since this run, so this run's model cannot be called. Start a new run instead.");
  }
  const { next } = await tx.selectFrom("jobs").select(sql<number>`coalesce(max(position), -1) + 1`.as("next")).where("run_id", "=", runId).executeTakeFirstOrThrow();
  await tx.insertInto("jobs").values({ org_id: orgId, run_id: runId, kind: "judge", position: next, finding_key: findingKey, requested_by: requestedBy }).execute();
  await tx.updateTable("findings").set({ verdict: null, updated_at: new Date() }).where("run_id", "=", runId).where("key", "=", findingKey).execute();
}

export async function runIdByNumber(tx: Tx, orgId: string, number: number): Promise<string | null> {
  const run = await tx.selectFrom("runs").select("id").where("org_id", "=", orgId).where("number", "=", number).executeTakeFirst();
  return run?.id ?? null;
}

export async function runSummary(tx: Tx, orgId: string, runId: string) {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "number", "status", "cost_usd", "budget_usd", "agent_model", "judge_model", "created_at", "started_at", "finished_at", "project_id", "config_snapshot", "provider", "token_cap", "tokens_used", "completion_usd_per_mtok", "cancel_reason", "paid_by", "conversation", "provided_accounts", "plan_id", "plan_name", "pull_request", "pr_plan", "execution", sql<string>`(select count(*) from plans p where p.project_id = runs.project_id and p.org_id = runs.org_id and p.kind = 'standard')`.as("plan_count"), sql<boolean>`exists (select 1 from plans p where p.id = runs.plan_id and p.kind = 'pull_request')`.as("on_pull_request_plan")])
    .where("id", "=", runId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!run) return null;
  const snapshot = run.config_snapshot as unknown as ConfigSnapshot;
  const goalText = new Map(snapshot.goals.map((g) => [g.id, g.instruction]));
  const record = run.pr_plan as unknown as PrPlanRecord | null;
  const origin = record?.prPlanId ? await tx.selectFrom("plans as p").leftJoin("runs as r", "r.id", "p.created_by_run_id").select("r.number").where("p.id", "=", record.prPlanId).executeTakeFirst() : undefined;
  const [jobs, findings, goals, activity, screenshots, botProtection, dismissals, said] = await Promise.all([
    tx.selectFrom("jobs").select(["id", "kind", "status", "persona_key", "finding_key", "usage", "stopped_by", "error", sql<boolean>`requested_by is not null`.as("requested"), sql<boolean>`status = 'leased' and exists (select 1 from run_events e where e.job_id = jobs.id and e.type = 'standby')`.as("on_standby")]).where("run_id", "=", runId).orderBy("position").execute(),
    tx.selectFrom("findings").select(["key", "persona_key", "kind", "filed_as", "goal", "title", "observed", "reproduction", "severity", "replay", "verdict", "same_as", "url", "quote", "step_people"]).where("run_id", "=", runId).orderBy("created_at").orderBy("key").execute(),
    tx.selectFrom("goal_outcomes").select(["persona_key", "goal", "status", "note"]).where("run_id", "=", runId).orderBy("persona_key").orderBy("goal").execute(),
    tx
      .selectFrom("run_events as e")
      .innerJoin("jobs as j", "j.id", "e.job_id")
      .select(["e.id", "e.type", "e.at", "e.payload", "j.persona_key", "j.kind"])
      .where("e.run_id", "=", runId)
      .where("e.type", "in", ["note", "finding", "goal_status", "verdict", "standby"])
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
    tx
      .selectFrom("run_events as e")
      .select(["e.payload"])
      .where("e.run_id", "=", runId)
      .where("e.type", "=", "bot_protection")
      .orderBy("e.id")
      .limit(1)
      .executeTakeFirst(),
    tx
      .selectFrom("finding_dismissals as d")
      .leftJoin("runs as m", "m.id", "d.matched_run_id")
      .select(["d.finding_key", "d.reason", "d.dismissed_by", "d.dismissed_at", "d.matched_finding_key", "m.number as matched_run_number"])
      .where("d.run_id", "=", runId)
      .execute(),
    run.conversation
      ? tx
          .selectFrom("run_events as e")
          .innerJoin("jobs as j", "j.id", "e.job_id")
          .select(["e.id", "e.at", "e.payload", "j.persona_key"])
          .where("e.run_id", "=", runId)
          .where("e.type", "=", "message")
          .orderBy("e.id", "desc")
          .limit(CONVERSATION_SHOWN)
          .execute()
      : Promise.resolve([]),
  ]);
  const dismissal = new Map(dismissals.map((d) => [d.finding_key, {
    reason: d.reason, userId: d.dismissed_by, at: d.dismissed_at, by: null as string | null,
    matched: d.matched_finding_key !== null && d.matched_run_number !== null ? { runNumber: d.matched_run_number, findingKey: d.matched_finding_key } : null,
  }]));
  const findingTitle = new Map(findings.map((f) => [f.key, f.title]));
  const latestScreenshot = (key: string, kind: string) => screenshots.filter((a) => a.finding_key === key && a.kind === kind).at(-1)?.id ?? null;
  return {
    id: run.id, number: run.number, status: run.status, cancelReason: run.cancel_reason as CancelReason | null, projectId: run.project_id, planName: run.plan_id === null || run.on_pull_request_plan || Number(run.plan_count) > 1 ? run.plan_name : null,
    costUsd: Number(run.cost_usd), budgetUsd: Number(run.budget_usd), completionUsdPerMtok: run.completion_usd_per_mtok === null ? null : Number(run.completion_usd_per_mtok), agentModel: run.agent_model, judgeModel: run.judge_model,
    provider: run.provider, paidBy: run.paid_by as PaidBy, tokenCap: run.token_cap === null ? null : Number(run.token_cap), tokensUsed: Number(run.tokens_used),
    conversation: run.conversation,
    execution: run.execution as Execution,
    providedAccounts: run.provided_accounts as string[],
    pullRequest: pullRequestOf(run.pull_request as unknown as PullRequest | null),
    prPlan: run.pr_plan ? plannedFor(record!, (run.pull_request as unknown as PullRequest | null)?.number ?? null, snapshot, record?.createdByRun ?? origin?.number ?? null) : null,
    createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    jobs,
    findings: findings.map((f) => ({
      key: f.key, personaKey: f.persona_key, kind: f.filed_as === "friction" && f.verdict !== "confirmed" ? "friction" : f.kind, filedAs: f.filed_as as "friction" | null, goal: f.goal, title: f.title, observed: f.observed, reproduction: f.reproduction, severity: f.severity, replay: f.replay, verdict: f.verdict, sameAs: f.same_as, url: f.url, quote: f.quote, stepPeople: f.step_people as string[] | null,
      screenshots: { reported: latestScreenshot(f.key, "role_session"), replayed: latestScreenshot(f.key, "replay") },
      dismissal: dismissal.get(f.key) ?? null,
    })),
    goals: goals.map((g) => ({ personaKey: g.persona_key, goal: g.goal, status: g.status, note: g.note })),
    botProtection: botProtection ? (({ vendor, url }) => ({ vendor, url }))(botProtection.payload as unknown as Extract<RunEvent, { type: "bot_protection" }>) : null,
    target: snapshot.targetUrl,
    personas: snapshot.personas.map((p) => ({ id: p.id, name: p.name })),
    goalTexts: snapshot.goals.map((g) => ({ id: g.id, instruction: g.instruction, ...(g.personaId ? { personaId: g.personaId } : {}) })),
    conversationMessages: said.toReversed().map((m) => ({ id: String(m.id), at: m.at, personaKey: m.persona_key, text: (m.payload as unknown as Extract<RunEvent, { type: "message" }>).text })),
    activity: activity.map((a) => ({ id: String(a.id), at: a.at, personaKey: a.persona_key, kind: a.kind, text: activityText(a.payload as unknown as RunEvent, goalText, findingTitle) })),
  };
}

const CONVERSATION_SHOWN = 60;

function pullRequestOf(pr: PullRequest | null) {
  if (!pr || (!pr.number && !pr.title)) return null;
  return { number: pr.number ?? null, title: pr.title ?? null, url: pr.url ?? null, repository: pr.repository ?? null, branch: pr.headRef ?? null, commit: pr.commit ?? null };
}

function plannedFor(record: PrPlanRecord, number: number | null, snapshot: ConfigSnapshot, createdByRun: number | null) {
  const chosen = new Set(record.goalIds);
  return { number, mode: record.mode, note: record.note ?? null, version: record.version ?? null, reused: record.reused === true, createdByRun, ...(record.signUps?.length ? { signUps: record.signUps } : {}), ...(record.accountReason ? { accountReason: record.accountReason } : {}), ...(record.brief ? { brief: record.brief } : {}), goals: snapshot.goals.filter((g) => chosen.has(g.id)).map((g) => ({ id: g.id, instruction: g.instruction, personaId: g.personaId ?? null })) };
}

export type RunSummary = NonNullable<Awaited<ReturnType<typeof runSummary>>>;

const VERDICT_LABEL: Record<Verdict, string> = { confirmed: "Confirmed", refuted: "Refuted", inconclusive: "Inconclusive" };

function activityText(e: RunEvent, goalText: Map<string, string>, findingTitle: Map<string, string>): string {
  if (e.type === "note" || e.type === "message") return e.text;
  if (e.type === "finding") return `${e.finding.kind === "defect" ? "Reported a defect" : "Noted friction"}: ${e.finding.title}`;
  if (e.type === "goal_status") return `Goal ${e.outcome.status === "reached" ? "reached" : "not reached"}: ${goalText.get(e.outcome.goal) ?? e.outcome.goal}`;
  if (e.type === "standby") return "Is on standby for the others";
  if (e.type === "verdict") return `${VERDICT_LABEL[e.verdict]}: ${findingTitle.get(e.findingId) ?? e.findingId}`;
  return e.type;
}
