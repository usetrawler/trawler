import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { AccountFlow, LeadTurn } from "@usetrawler/core/setup";
import type { PullRequest } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";

export const RECENT_PR_PLANS = 30;

export interface PrKey {
  repo: string;
  number: number;
}

export interface StoredPrPlan {
  id: string;
  name: string;
  version: number;
  inputsHash: string;
  turns: LeadTurn[];
  accountFlow: AccountFlow;
  accountReason?: string;
  createdByRun: number | null;
}

export interface PlanContent {
  personas: Array<{ id: string }>;
  goals: Array<{ id: string; instruction: string; personaId: string }>;
}

export const prKey = (pr: PullRequest | undefined): PrKey | null => (pr?.number ? { repo: (pr.repository ?? "").trim().toLowerCase(), number: pr.number } : null);

const squash = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

export const inputsHash = (pr: PullRequest) =>
  createHash("sha256")
    .update(JSON.stringify([squash(pr.title), squash(pr.description), [...new Set((pr.changedFiles ?? []).map((f) => f.trim()))].sort()]))
    .digest("hex");

export const prPlanName = (number: number) => `PR #${number}`;
export const runPlanName = (name: string, version: number) => `${name} v${version}`;

const current = (tx: Tx, projectId: string, sourceId: string, key: PrKey) =>
  tx.selectFrom("plans as p").where("p.kind", "=", "pull_request").where("p.project_id", "=", projectId).where("p.source_plan_id", "=", sourceId).where("p.repo", "=", key.repo).where("p.pr_number", "=", key.number);

export async function turnsOfPlan(tx: Tx, planId: string): Promise<LeadTurn[]> {
  const goals = await tx.selectFrom("goals").select(["key", "instruction", "persona_key"]).where("plan_id", "=", planId).orderBy("position").execute();
  const turns: LeadTurn[] = [];
  for (const g of goals) {
    const goal = { id: g.key, instruction: g.instruction };
    const last = turns.at(-1);
    if (last?.person === g.persona_key) last.goals.push(goal);
    else turns.push({ person: g.persona_key, goals: [goal] });
  }
  return turns;
}

export async function currentPrPlan(tx: Tx, projectId: string, sourceId: string, key: PrKey): Promise<StoredPrPlan | null> {
  const row = await current(tx, projectId, sourceId, key)
    .leftJoin("runs as r", "r.id", "p.created_by_run_id")
    .select(["p.id", "p.name", "p.version", "p.inputs_hash", "p.account_flow", "p.account_reason", "r.number as created_by_number"])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id, name: row.name, version: row.version!, inputsHash: row.inputs_hash!, turns: await turnsOfPlan(tx, row.id),
    accountFlow: row.account_flow === "exercise" ? "exercise" : "provided", ...(row.account_reason ? { accountReason: row.account_reason } : {}), createdByRun: row.created_by_number,
  };
}

async function fillPlan(tx: Tx, orgId: string, projectId: string, planId: string, sourceId: string, content: PlanContent): Promise<void> {
  await tx.deleteFrom("goals").where("plan_id", "=", planId).execute();
  await tx.deleteFrom("personas").where("plan_id", "=", planId).execute();
  await tx.deleteFrom("target_accounts").where("plan_id", "=", planId).execute();
  await tx.deleteFrom("target_gates").where("plan_id", "=", planId).execute();
  const wanted = content.personas.map((p) => p.id);
  const people = wanted.length ? await tx.selectFrom("personas").selectAll().where("plan_id", "=", sourceId).where("key", "in", wanted).orderBy("position").execute() : [];
  const kept = new Set(people.map((p) => p.key));
  const refs = [...new Set(people.flatMap((p) => (p.account_ref ? [p.account_ref] : [])))];
  const accounts = refs.length ? await tx.selectFrom("target_accounts").selectAll().where("plan_id", "=", sourceId).where("ref", "in", refs).orderBy("position").execute() : [];
  const gates = await tx.selectFrom("target_gates").selectAll().where("plan_id", "=", sourceId).orderBy("position").execute();
  const scope = { org_id: orgId, project_id: projectId, plan_id: planId };
  if (accounts.length) await tx.insertInto("target_accounts").values(accounts.map((a) => ({ ...scope, ref: a.ref, username: a.username, position: a.position, password_secret: a.password_secret, password_hint: a.password_hint }))).execute();
  if (gates.length) await tx.insertInto("target_gates").values(gates.map((g) => ({ ...scope, kind: g.kind, name: g.name, value: g.value, position: g.position, secret: g.secret, secret_hint: g.secret_hint }))).execute();
  if (people.length) await tx.insertInto("personas").values(people.map((p, i) => ({ ...scope, key: p.key, name: p.name, brief: p.brief, account_ref: p.account_ref, signs_in: p.signs_in, position: i }))).execute();
  const goals = content.goals.filter((g) => kept.has(g.personaId));
  if (goals.length) await tx.insertInto("goals").values(goals.map((g, i) => ({ ...scope, key: g.id, instruction: g.instruction, persona_key: g.personaId, position: i }))).execute();
}

export async function prunePrPlans(tx: Tx, projectId: string): Promise<void> {
  const old = await tx.selectFrom("plans").select("id").where("project_id", "=", projectId).where("kind", "=", "pull_request").orderBy("last_used_at", "desc").orderBy("id").limit(1000).offset(RECENT_PR_PLANS).execute();
  if (old.length === 0) return;
  await tx
    .deleteFrom("plans")
    .where("id", "in", old.map((p) => p.id))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("runs").select("runs.id").whereRef("runs.plan_id", "=", "plans.id").where("runs.status", "in", ["queued", "running"]))))
    .execute();
}

export async function storePrPlan(tx: Tx, plan: { orgId: string; projectId: string; sourceId: string; key: PrKey; hash: string; content: PlanContent; accountFlow: AccountFlow; accountReason?: string; runId: string }): Promise<{ id: string; name: string; version: number }> {
  const { orgId, projectId, sourceId, key } = plan;
  await sql`select pg_advisory_xact_lock(hashtextextended(${`pr-plan:${projectId}:${sourceId}:${key.repo}:${key.number}`}, 0))`.execute(tx);
  const previous = await current(tx, projectId, sourceId, key).select(["p.id", "p.version"]).forUpdate().executeTakeFirst();
  const version = (previous?.version ?? 0) + 1;
  const now = new Date();
  const fields = { inputs_hash: plan.hash, version, account_flow: plan.accountFlow, account_reason: plan.accountReason ?? null, created_by_run_id: plan.runId, last_used_at: now, updated_at: now };
  const name = prPlanName(key.number);
  const id = previous
    ? (await tx.updateTable("plans").set(fields).where("id", "=", previous.id).returning("id").executeTakeFirstOrThrow()).id
    : (await tx.insertInto("plans").values({ org_id: orgId, project_id: projectId, name, kind: "pull_request", source_plan_id: sourceId, repo: key.repo, pr_number: key.number, ...fields }).returning("id").executeTakeFirstOrThrow()).id;
  await fillPlan(tx, orgId, projectId, id, sourceId, plan.content);
  await prunePrPlans(tx, projectId);
  return { id, name, version };
}

export async function usePrPlan(tx: Tx, plan: { orgId: string; projectId: string; id: string; sourceId: string; content: PlanContent }): Promise<void> {
  await fillPlan(tx, plan.orgId, plan.projectId, plan.id, plan.sourceId, plan.content);
  await tx.updateTable("plans").set({ last_used_at: new Date() }).where("id", "=", plan.id).execute();
}
