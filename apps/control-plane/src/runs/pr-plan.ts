import type { LanguageModel } from "ai";
import { sql } from "kysely";
import { Budget, pageText, planForPullRequest, settleTurns, type AccountFlow, type LeadTurn } from "@usetrawler/core/setup";
import { MAX_GOALS, MAX_GOALS_PER_PERSONA, turnsOf, type Goal, type PlanMode, type PullRequest } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem, type Tx } from "../db/tenancy.ts";
import { logError, writeLog } from "../server/log.ts";
import { workspacePlan } from "./plans.ts";
import { currentPrPlan, inputsHash, prKey, runPlanName, storePrPlan } from "./pr-plan-store.ts";
import { endRun, type ConfigSnapshot } from "./runs.ts";
import { NOT_VISIBLE_HERE, NOTHING_TO_TEST } from "./status.ts";

export const PR_PLAN_POSITION = -1000;
export const DEFAULT_PLAN_MODE: PlanMode = "change";
const PR_PLAN_BUDGET_USD = 0.1;
const PR_PLAN_MINUTES = 4;
const PR_PLAN_STALE_MINUTES = 6;
const PAGE_CHARS = 4000;
const ACTIVE = ["queued", "running"];

export interface PrPlanRecord {
  mode: Exclude<PlanMode, "regression">;
  goalIds: string[];
  note?: string;
  prPlanId?: string;
  version?: number;
  reused?: boolean;
  accountFlow?: AccountFlow;
  accountReason?: string;
  brief?: string;
  signUps?: string[];
}

export async function accountsFor(tx: Tx, planId: string | null, provided: string[], flow: AccountFlow): Promise<{ accounts: string[]; signUps: string[] }> {
  if (flow !== "exercise" || !planId || provided.length === 0) return { accounts: provided, signUps: [] };
  const signing = new Set((await tx.selectFrom("personas").select("name").where("plan_id", "=", planId).where("signs_in", "=", true).where("name", "in", provided).execute()).map((p) => p.name));
  return { accounts: provided.filter((n) => signing.has(n)), signUps: provided.filter((n) => !signing.has(n)) };
}

export const hasPullRequestDetails = (pr: PullRequest | undefined) => Boolean(pr && (pr.title?.trim() || pr.description?.trim() || pr.changedFiles?.length));

type Plan = Pick<ConfigSnapshot, "personas" | "goals">;

export function playedGoals(snapshot: Plan): Array<Goal & { personaId: string }> {
  const instruction = new Map(snapshot.goals.map((g) => [g.id, g.instruction]));
  const seen = new Set<string>();
  return turnsOf(snapshot).flatMap((turn) =>
    turn.goalIds.map((goalId) => {
      let id = goalId;
      if (seen.has(id)) id = `${goalId}-${turn.personaId}`.slice(0, 60);
      seen.add(id);
      return { id, instruction: instruction.get(goalId)!, personaId: turn.personaId };
    }),
  );
}

export function withLeadsGoals(snapshot: Plan, turns: LeadTurn[], mode: Exclude<PlanMode, "regression">, maxPeople: number): (Plan & { added: Array<Goal & { personaId: string }> }) | null {
  const known = new Set(snapshot.personas.map((p) => p.id));
  let lead = turns.filter((t) => known.has(t.person));
  if (mode === "change") {
    const keep = new Set([...new Set(lead.map((t) => t.person))].slice(0, maxPeople));
    lead = lead.filter((t) => keep.has(t.person));
  }
  const existing = mode === "both" ? playedGoals(snapshot) : [];
  const ids = new Set(existing.map((g) => g.id));
  const perPerson = new Map<string, number>();
  for (const g of existing) perPerson.set(g.personaId, (perPerson.get(g.personaId) ?? 0) + 1);
  const added: Array<Goal & { personaId: string }> = [];
  for (const turn of lead) {
    for (const g of turn.goals) {
      if (ids.has(g.id) || (perPerson.get(turn.person) ?? 0) >= MAX_GOALS_PER_PERSONA || existing.length + added.length >= MAX_GOALS) continue;
      ids.add(g.id);
      perPerson.set(turn.person, (perPerson.get(turn.person) ?? 0) + 1);
      added.push({ id: g.id, instruction: g.instruction, personaId: turn.person });
    }
  }
  if (added.length === 0) return null;
  const personas = mode === "change" ? snapshot.personas.filter((p) => added.some((g) => g.personaId === p.id)) : snapshot.personas;
  return { personas, goals: [...existing, ...added], added };
}

export async function storedPlanFor(tx: Tx, orgId: string, projectId: string, planId: string, pr: PullRequest, mode: Exclude<PlanMode, "regression">, config: Plan) {
  const key = prKey(pr);
  const stored = key ? await currentPrPlan(tx, projectId, planId, key) : null;
  if (!stored || stored.inputsHash !== inputsHash(pr)) return null;
  const people = config.personas.map((p) => ({ id: p.id, name: p.name, brief: p.brief, account: p.accountRef ?? null }));
  const turns = settleTurns({ turns: stored.turns }, people, pr, config.goals.map((g) => g.id)).turns;
  const limit = await workspacePlan(tx, orgId);
  return { stored, merged: withLeadsGoals(config, turns, mode, limit.limits.people) };
}

export interface PrPlanDeps {
  db: Database;
  model: LanguageModel | null;
  modelId: string;
  fetchText?: (url: string) => Promise<string>;
}

const noteOf = (err: unknown) => `The lead could not plan for this pull request (${(err instanceof Error ? err.message : String(err)).slice(0, 300)}), so the project's plan ran as it is.`;
export const NOTHING = "Nothing in this pull request points at a feature, so the project's plan ran as it is.";

async function claimPrPlan(db: Database) {
  return asSystem(db, async (tx) => {
    const job = await tx
      .selectFrom("jobs as j")
      .innerJoin("runs as r", "r.id", "j.run_id")
      .select(["j.id", "j.org_id", "j.run_id", "r.plan_id", "r.execution", "r.config_snapshot", "r.pull_request", "r.pr_plan"])
      .where("j.kind", "=", "pr_plan")
      .where("j.status", "=", "queued")
      .where("r.status", "in", ACTIVE)
      .orderBy("j.created_at")
      .limit(1)
      .forUpdate(["j"])
      .skipLocked()
      .executeTakeFirst();
    if (!job) return null;
    await tx.updateTable("jobs").set({ status: "leased", started_at: new Date(), lease_until: sql<Date>`now() + make_interval(mins => ${PR_PLAN_MINUTES})` }).where("id", "=", job.id).execute();
    const plan = job.plan_id ? await tx.selectFrom("plans").select("features").where("id", "=", job.plan_id).executeTakeFirst() : undefined;
    return { ...job, features: plan?.features ?? [] };
  });
}

type Claimed = NonNullable<Awaited<ReturnType<typeof claimPrPlan>>>;
type Outcome = { turns: LeadTurn[]; accountFlow: AccountFlow; accountReason?: string; notVisibleHere?: string; brief?: string; usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number; steps: number } } | { failure: unknown };

async function ask(deps: PrPlanDeps, job: Claimed): Promise<Outcome> {
  try {
    if (!deps.model) throw new Error("Trawler's setup model is not configured on this server");
    const snapshot = job.config_snapshot as unknown as ConfigSnapshot;
    const name = new Map(snapshot.personas.map((p) => [p.id, p.name]));
    let page: string | undefined;
    if (job.execution === "hosted" && deps.fetchText) page = pageText(await deps.fetchText(snapshot.targetUrl).catch(() => ""), PAGE_CHARS) || undefined;
    const planned = await planForPullRequest({
      model: deps.model, modelId: deps.modelId, budget: new Budget(PR_PLAN_BUDGET_USD), url: snapshot.targetUrl, pullRequest: job.pull_request as unknown as PullRequest,
      features: job.features, people: snapshot.personas.map((p) => ({ id: p.id, name: p.name, brief: p.brief, account: p.accountRef ?? null })),
      goals: playedGoals(snapshot).map((g) => ({ person: name.get(g.personaId) ?? g.personaId, instruction: g.instruction })), takenGoalIds: snapshot.goals.map((g) => g.id), page,
    });
    return { turns: planned.turns, accountFlow: planned.accountFlow, ...(planned.accountReason ? { accountReason: planned.accountReason } : {}), ...(planned.notVisibleHere ? { notVisibleHere: planned.notVisibleHere } : {}), ...(planned.brief ? { brief: planned.brief } : {}), usage: planned.usage };
  } catch (err) {
    return { failure: err };
  }
}

async function finish(db: Database, job: Claimed, outcome: Outcome): Promise<void> {
  await asSystem(db, async (tx) => {
    const run = await tx.selectFrom("runs").select(["status", "conversation", "paid_by", "project_id", "provided_accounts"]).where("id", "=", job.run_id).forUpdate().executeTakeFirstOrThrow();
    if (!ACTIVE.includes(run.status)) {
      await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date(), lease_until: null }).where("id", "=", job.id).execute();
      return;
    }
    const mode = (job.pr_plan as unknown as PrPlanRecord).mode;
    const snapshot = job.config_snapshot as unknown as ConfigSnapshot;
    const limit = await workspacePlan(tx, job.org_id);
    const lead = "turns" in outcome ? withLeadsGoals(snapshot, outcome.turns, "change", limit.limits.people) : null;
    const merged = mode === "both" && "turns" in outcome ? withLeadsGoals(snapshot, outcome.turns, "both", limit.limits.people) : lead;
    const pr = job.pull_request as unknown as PullRequest;
    const key = prKey(pr);
    const stored = lead && "turns" in outcome && job.plan_id && key
      ? await storePrPlan(tx, { orgId: job.org_id, projectId: run.project_id, sourceId: job.plan_id, key, hash: inputsHash(pr), content: { personas: lead.personas, goals: lead.added }, accountFlow: outcome.accountFlow, accountReason: outcome.accountReason, brief: outcome.brief, runId: job.run_id })
      : null;
    const provided = "turns" in outcome ? await accountsFor(tx, job.plan_id, run.provided_accounts as string[], outcome.accountFlow) : null;
    const nothingToTest = mode === "change" && "turns" in outcome && !merged;
    const notVisibleHere = "turns" in outcome ? outcome.notVisibleHere : undefined;
    const record: PrPlanRecord = {
      mode, goalIds: merged?.added.map((g) => g.id) ?? [], ...("failure" in outcome ? { note: noteOf(outcome.failure) } : merged ? {} : { note: nothingToTest ? (notVisibleHere ? `${NOT_VISIBLE_HERE} ${notVisibleHere}` : NOTHING_TO_TEST) : NOTHING }), ...(stored ? { prPlanId: stored.id, version: stored.version } : {}),
      ...("turns" in outcome ? { accountFlow: outcome.accountFlow, ...(outcome.accountReason ? { accountReason: outcome.accountReason } : {}), signUps: provided!.signUps } : {}),
      ...(merged && "turns" in outcome && outcome.brief ? { brief: outcome.brief } : {}),
    };
    if (provided && provided.signUps.length > 0) await tx.updateTable("runs").set({ provided_accounts: JSON.stringify(provided.accounts) }).where("id", "=", job.run_id).execute();
    if (merged) {
      const next = turnsOf(merged);
      const people = new Set(next.map((t) => t.personaId)).size;
      const together = run.conversation && people > 1;
      const used = new Set(merged.personas.flatMap((p) => (p.accountRef ? [p.accountRef] : [])));
      await tx.deleteFrom("jobs").where("run_id", "=", job.run_id).where("kind", "=", "role_session").where("status", "=", "queued").execute();
      await tx.insertInto("jobs").values(next.map((turn, i) => ({ org_id: job.org_id, run_id: job.run_id, kind: "role_session", position: i, persona_key: turn.personaId, together }))).execute();
      await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", job.run_id).where("kind", "=", "account_check").where("status", "=", "queued").where("account_ref", "not in", [...used, ""]).execute();
      await tx.updateTable("runs").set({
        config_snapshot: JSON.stringify({ ...snapshot, personas: merged.personas, goals: merged.goals, ...("turns" in outcome && outcome.brief ? { brief: outcome.brief } : {}) }), conversation: together,
        ...(mode === "change" && stored ? { plan_id: stored.id, plan_name: runPlanName(stored.name, stored.version) } : {}),
      }).where("id", "=", job.run_id).execute();
    }
    const failed = "failure" in outcome;
    await tx
      .updateTable("jobs")
      .set({ status: failed ? "failed" : "succeeded", finished_at: new Date(), lease_until: null, error: record.note?.slice(0, 2000) ?? null, ...("usage" in outcome ? { usage: JSON.stringify(outcome.usage) } : {}) })
      .where("id", "=", job.id)
      .execute();
    await tx.updateTable("runs").set({ pr_plan: JSON.stringify(record) }).where("id", "=", job.run_id).execute();
    if (nothingToTest) await endRun(tx, job.run_id, { status: "cancelled", reason: "nothing_to_test" });
  });
}

async function planOne(deps: PrPlanDeps): Promise<boolean> {
  const job = await claimPrPlan(deps.db);
  if (!job) return false;
  const started = Date.now();
  const outcome = await ask(deps, job);
  if ("failure" in outcome) await logError("the lead could not plan for a pull request", { orgId: job.org_id, runId: job.run_id, err: outcome.failure });
  else void writeLog("info", "the lead planned for a pull request", { orgId: job.org_id, seconds: (Date.now() - started) / 1000, model: outcome.usage.model, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, costUsd: outcome.usage.costUsd, goals: outcome.turns.reduce((n, t) => n + t.goals.length, 0) }).catch(() => undefined);
  await finish(deps.db, job, outcome);
  return true;
}

export async function failStalePrPlans(db: Database): Promise<void> {
  await asSystem(db, async (tx) => {
    const stale = await tx
      .selectFrom("jobs as j")
      .innerJoin("runs as r", "r.id", "j.run_id")
      .select(["j.id", "j.run_id", "r.pr_plan"])
      .where("j.kind", "=", "pr_plan")
      .where("j.status", "in", ["queued", "leased"])
      .where("j.created_at", "<", sql<Date>`now() - make_interval(mins => ${PR_PLAN_STALE_MINUTES})`)
      .forUpdate(["j"])
      .skipLocked()
      .execute();
    for (const job of stale) {
      const note = "The lead did not answer in time, so the project's plan ran as it is.";
      await tx.updateTable("jobs").set({ status: "failed", error: note, finished_at: new Date(), lease_until: null }).where("id", "=", job.id).execute();
      await tx.updateTable("runs").set({ pr_plan: JSON.stringify({ ...(job.pr_plan as object), goalIds: [], note }) }).where("id", "=", job.run_id).execute();
    }
  });
}

export async function planDueRuns(deps: PrPlanDeps): Promise<number> {
  await failStalePrPlans(deps.db);
  let planned = 0;
  while (await planOne(deps)) planned++;
  return planned;
}
