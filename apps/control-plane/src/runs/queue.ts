import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { DefectGroupsSchema, FindingSchema, JobUsageSchema, MAX_GROUPED_DEFECTS, settleGroups, JobStopReasonSchema, ReplayObservationSchema, RunEventSchema, SignInCheckSchema, ACCOUNT_CHECK_STEPS, trimStory, turnsOf, type DefectToGroup, type Finding, type JobStopReason, type JobUsage, type ProjectConfig, type ReplayObservation, type RunEvent, type SignInCheck, type StoryEntry, type Turn } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem, type Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { loadProjectConfig } from "../projects/projects.ts";
import { logError } from "../server/log.ts";
import type { Price } from "../llm/prices.ts";
import type { Provider } from "../llm/providers.ts";
import { budgetLeft, monthlyBudget, RUN_TIME_LIMIT_HOURS, runsHalted } from "./limits.ts";
import { turnSteps } from "./models.ts";
import { ACCOUNT_REFUSED, affordableOutputTokens, capSpent, endRun, giveBackUnusedFirstRun, signUpSeedContext, type CancelReason, type ConfigSnapshot, type PaidBy } from "./runs.ts";

const LEASE_MINUTES = 10;
const GROUPED_OBSERVED_CHARS = 600;
const GROUPED_STEPS = 12;
const GROUPED_STEP_CHARS = 200;
const GROUPED_GOAL_CHARS = 300;

const clipped = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max - 1).join("")}…` : text);
const ACTIVE = ["queued", "running"];

export class InvalidJobToken extends Error {
  constructor() {
    super("invalid or expired job token");
  }
}

export interface JobAssignment {
  jobId: string;
  runId: string;
  token: string;
  kind: "account_check" | "role_session" | "group" | "replay" | "judge";
  config: ProjectConfig;
  personaKey?: string;
  goalIds?: string[];
  turn?: number;
  returning?: boolean;
  story?: StoryEntry[];
  signUpSeed?: string;
  accountRef?: string;
  finding?: Finding;
  observation?: ReplayObservation;
  defects?: DefectToGroup[];
  maxSteps: number;
  budgetUsd: number;
  agentModel: string;
  judgeModel: string;
}

export interface JobResult {
  usage: JobUsage;
  stoppedBy: JobStopReason;
  error?: string;
  observation?: ReplayObservation;
  signIn?: SignInCheck;
  groups?: string[][];
}

export class ForeignEvents extends Error {
  constructor() {
    super("events belong to another job");
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function storable<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "").toWellFormed() as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, storable(v)])) as T;
  return value;
}

function configFor(snapshot: ConfigSnapshot, current: ProjectConfig): ProjectConfig {
  const passwords = new Map(current.accounts.map((a) => [`${a.ref}\n${a.username}`, a.password]));
  const key = (a: { ref: string; username: string }) => `${a.ref}\n${a.username}`;
  const usable = new Set(snapshot.accounts.filter((a) => passwords.has(key(a))).map((a) => a.ref));
  return {
    ...snapshot,
    personas: snapshot.personas.map((p) => (p.accountRef && !usable.has(p.accountRef) ? { id: p.id, name: p.name, brief: p.brief } : p)),
    accounts: snapshot.accounts.filter((a) => usable.has(a.ref)).map((a) => ({ ...a, password: passwords.get(key(a))! })),
    httpCredentials: snapshot.httpCredentials && current.httpCredentials?.username === snapshot.httpCredentials.username ? current.httpCredentials : undefined,
    secretHeaders: Object.fromEntries(snapshot.secretHeaders.filter((h) => h in current.secretHeaders).map((h) => [h, current.secretHeaders[h]!])),
  };
}

async function reapExpiredLeases(db: Database): Promise<void> {
  await asSystem(db, async (tx) => {
    const expired = await tx
      .selectFrom("jobs")
      .select(["id", "run_id", "org_id", "kind", "finding_key"])
      .where("status", "=", "leased")
      .where("lease_until", "<", sql<Date>`now()`)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const job of expired) {
      await tx.updateTable("jobs").set({ status: "failed", error: "the runner stopped answering", lease_until: null, finished_at: new Date() }).where("id", "=", job.id).execute();
      if (!(await stopIfOverLimits(tx, job.run_id))) await planNext(tx, job, { usage: { model: "", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "error" });
    }
  });
}

type ClaimOutcome = { assignment: JobAssignment } | { quarantined: true } | null;

function turnAt(snapshot: ConfigSnapshot, position: number, personaKey: string | null): Turn {
  const turn = turnsOf(snapshot)[position];
  if (!turn || turn.personaId !== personaKey) throw new Error(`turn ${position} of the plan does not belong to ${personaKey}`);
  return turn;
}

async function storyBefore(tx: Tx, runId: string, position: number, snapshot: ConfigSnapshot): Promise<StoryEntry[]> {
  const rows = await tx
    .selectFrom("run_events as e")
    .innerJoin("jobs as j", "j.id", "e.job_id")
    .select(["j.persona_key", "e.payload"])
    .where("j.run_id", "=", runId)
    .where("j.kind", "=", "role_session")
    .where("j.position", "<", position)
    .where("e.type", "in", ["note", "goal_status"])
    .orderBy("j.position")
    .orderBy("e.seq")
    .execute();
  const name = new Map(snapshot.personas.map((p) => [p.id, p.name]));
  const goal = new Map(snapshot.goals.map((g) => [g.id, g.instruction]));
  const story = rows.flatMap((row): StoryEntry[] => {
    const e = row.payload as unknown as RunEvent;
    const personaId = row.persona_key ?? "";
    const base = { personaId, name: name.get(personaId) ?? personaId };
    if (e.type === "note") return [{ ...base, text: e.text }];
    if (e.type === "goal_status" && e.outcome.status !== "not_attempted") return [{ ...base, goal: goal.get(e.outcome.goal) ?? e.outcome.goal, status: e.outcome.status, text: e.outcome.note }];
    return [];
  });
  return trimStory(story);
}

async function claimOnce(db: Database, keys: Keyring): Promise<ClaimOutcome> {
  return asSystem(db, async (tx) => {
    const picked = await tx
      .selectFrom("jobs as j")
      .innerJoin("runs as r", "r.id", "j.run_id")
      .innerJoin("projects as p", "p.id", "r.project_id")
      .leftJoin("workspace_plans as wp", "wp.org_id", "j.org_id")
      .select(["j.id", "j.org_id", "j.run_id", "j.kind", "j.position", "j.persona_key", "j.finding_key", "j.account_ref", "r.project_id", "r.status as run_status", "r.config_snapshot", "r.max_steps", "r.replay_steps", "r.budget_usd", "r.cost_usd", "r.agent_model", "r.judge_model", "r.sign_up_seed"])
      .where("j.status", "=", "queued")
      .where("p.paused_at", "is", null)
      .where((eb) => eb.or([eb("r.status", "in", ACTIVE), eb("j.requested_by", "is not", null)]))
      .where((eb) => eb.not(eb.exists(eb.selectFrom("jobs as busy").select("busy.id").whereRef("busy.run_id", "=", "j.run_id").where("busy.status", "=", "leased"))))
      .orderBy(sql`r.started_at is null or j.requested_by is not null`)
      .orderBy(sql`coalesce(wp.plan, 'free') = 'free'`)
      .orderBy("r.created_at")
      .orderBy("j.position")
      .limit(1)
      .forUpdate(["j", "r"])
      .skipLocked()
      .executeTakeFirst();
    if (!picked) return null;
    if (ACTIVE.includes(picked.run_status) && (await stopIfOverLimits(tx, picked.run_id))) return { quarantined: true };
    const token = randomBytes(32).toString("base64url");
    await tx.updateTable("jobs").set({ status: "leased", token_hash: hashToken(token), lease_until: sql<Date>`now() + make_interval(mins => ${LEASE_MINUTES})`, started_at: new Date() }).where("id", "=", picked.id).execute();
    await tx.updateTable("runs").set({ status: "running", started_at: sql<Date>`coalesce(started_at, now())` }).where("id", "=", picked.run_id).where("status", "in", ACTIVE).execute();
    await sql`savepoint prepare_assignment`.execute(tx);
    try {
      const snapshot = picked.config_snapshot as unknown as ConfigSnapshot;
      const current = await loadProjectConfig(tx, picked.org_id, picked.project_id, keys);
      const finding = picked.finding_key ? await findingFor(tx, picked.run_id, picked.finding_key) : undefined;
      const config = configFor(snapshot, current);
      const turn = picked.kind === "role_session" && picked.sign_up_seed ? turnAt(snapshot, picked.position, picked.persona_key) : undefined;
      const story = turn ? await storyBefore(tx, picked.run_id, picked.position, snapshot) : undefined;
      const returning = turn ? turnsOf(snapshot).slice(0, picked.position).some((t) => t.personaId === picked.persona_key) : undefined;
      const defects = picked.kind === "group" ? await defectsToGroup(tx, picked.run_id, config) : undefined;
      return {
        assignment: {
          jobId: picked.id,
          runId: picked.run_id,
          token,
          kind: picked.kind as JobAssignment["kind"],
          config,
          personaKey: picked.persona_key ?? undefined,
          ...(turn ? { goalIds: turn.goalIds, turn: picked.position, returning, story, signUpSeed: keys.decrypt(picked.sign_up_seed!, signUpSeedContext(picked.org_id, picked.run_id)) } : {}),
          accountRef: picked.account_ref ?? (finding ? config.personas.find((p) => p.id === finding.personaKey)?.accountRef : undefined),
          finding: finding?.finding,
          observation: finding?.replay,
          ...(defects ? { defects } : {}),
          maxSteps: picked.kind === "role_session" ? (turn ? turnSteps(turn.goalIds.length, picked.max_steps) : picked.max_steps) : picked.kind === "account_check" ? Math.min(ACCOUNT_CHECK_STEPS, picked.replay_steps) : picked.replay_steps * Math.max(1, new Set(finding?.finding.by ?? []).size),
          budgetUsd: Math.max(0, Number(picked.budget_usd) - Number(picked.cost_usd)),
          agentModel: picked.agent_model,
          judgeModel: picked.judge_model,
        },
      };
    } catch (err) {
      await sql`rollback to savepoint prepare_assignment`.execute(tx);
      await logError("job could not be prepared", { orgId: picked.org_id, runId: picked.run_id, jobId: picked.id, err });
      await tx.updateTable("jobs").set({ status: "failed", error: "the job could not be prepared from the project; it may have changed since the run started", token_hash: null, lease_until: null, finished_at: new Date() }).where("id", "=", picked.id).execute();
      if (!(await stopIfOverLimits(tx, picked.run_id))) await planNext(tx, picked, { usage: { model: "", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "error" });
      return { quarantined: true };
    }
  });
}

export async function claimJob(db: Database, keys: Keyring): Promise<JobAssignment | null> {
  await reapExpiredLeases(db);
  if (runsHalted()) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let outcome: ClaimOutcome;
    try {
      outcome = await claimOnce(db, keys);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue;
      throw err;
    }
    if (!outcome) return null;
    if ("assignment" in outcome) return outcome.assignment;
  }
  return null;
}

export async function releaseJob(db: Database, job: { jobId: string; runId: string; token: string }): Promise<void> {
  await asSystem(db, async (tx) => {
    const current = await tx.selectFrom("jobs").select("requested_by").where("id", "=", job.jobId).forUpdate().executeTakeFirst();
    const run = await tx.selectFrom("runs").select("status").where("id", "=", job.runId).forUpdate().executeTakeFirstOrThrow();
    const release = ACTIVE.includes(run.status) || current?.requested_by ? { status: "queued", started_at: null } : { status: "cancelled", finished_at: new Date() };
    const released = await tx
      .updateTable("jobs")
      .set({ ...release, token_hash: null, lease_until: null })
      .where("id", "=", job.jobId)
      .where("token_hash", "=", hashToken(job.token))
      .where("status", "=", "leased")
      .executeTakeFirst();
    if (!released.numUpdatedRows) return;
    await forgetPartialWork(tx, job.jobId);
    if (run.status !== "running") return;
    const started = await tx.selectFrom("jobs").select("id").where("run_id", "=", job.runId).where("status", "!=", "queued").executeTakeFirst();
    if (!started) await tx.updateTable("runs").set({ status: "queued", started_at: null }).where("id", "=", job.runId).execute();
  });
}

async function forgetPartialWork(tx: Tx, jobId: string) {
  const job = await tx.selectFrom("jobs as j").innerJoin("runs as r", "r.id", "j.run_id").select(["j.run_id", "j.kind", "j.position", "j.persona_key", "j.finding_key", "r.config_snapshot", "r.sign_up_seed"]).where("j.id", "=", jobId).executeTakeFirstOrThrow();
  await tx.deleteFrom("run_events").where("job_id", "=", jobId).execute();
  await tx.updateTable("artifacts").set({ discarded_at: new Date() }).where("job_id", "=", jobId).where("discarded_at", "is", null).execute();
  if (job.kind === "role_session") {
    await tx.deleteFrom("findings").where("job_id", "=", jobId).execute();
    const outcomes = tx.deleteFrom("goal_outcomes").where("run_id", "=", job.run_id).where("persona_key", "=", job.persona_key!);
    if (!job.sign_up_seed) await outcomes.execute();
    else {
      const goalIds = turnsOf(job.config_snapshot as unknown as ConfigSnapshot)[job.position]?.goalIds ?? [];
      if (goalIds.length) await outcomes.where("goal", "in", goalIds).execute();
    }
  } else if (job.kind === "judge") {
    await tx.updateTable("findings").set({ verdict: null, updated_at: new Date() }).where("run_id", "=", job.run_id).where("key", "=", job.finding_key!).execute();
  }
}

export async function releaseJobForShutdown(db: Database, token: string, expectedJobId: string): Promise<void> {
  const job = await asSystem(db, (tx) => jobForToken(tx, token, { expectedJobId }));
  if (job.status !== "leased") return;
  await releaseJob(db, { jobId: job.id, runId: job.run_id, token });
}

async function findingFor(tx: Tx, runId: string, key: string) {
  const row = await tx.selectFrom("findings").selectAll().where("run_id", "=", runId).where("key", "=", key).executeTakeFirstOrThrow();
  return {
    personaKey: row.persona_key,
    finding: { ...FindingSchema.parse({ id: "stored", kind: row.kind, goal: row.goal, title: row.title, observed: row.observed, reproduction: row.reproduction, severity: row.severity, ...(row.step_people ? { by: row.step_people } : {}) }), id: row.key },
    replay: row.replay ? ReplayObservationSchema.parse(row.replay) : undefined,
  };
}

const defectsOf = (tx: Tx, runId: string) => tx.selectFrom("findings").where("run_id", "=", runId).where("kind", "=", "defect").orderBy("created_at").orderBy("key");
const reportedDefectsOf = (tx: Tx, runId: string) => defectsOf(tx, runId).where("filed_as", "is", null);

async function frictionToCheck(tx: Tx, runId: string): Promise<string[]> {
  const rows = await tx
    .updateTable("findings as f")
    .set({ kind: "defect", filed_as: "friction", updated_at: new Date() })
    .where("f.run_id", "=", runId)
    .where("f.kind", "=", "friction")
    .where(sql<boolean>`jsonb_array_length(f.reproduction) >= 2`)
    .where((eb) => eb.exists(eb.selectFrom("goal_outcomes as g").select("g.goal").whereRef("g.run_id", "=", "f.run_id").whereRef("g.persona_key", "=", "f.persona_key").whereRef("g.goal", "=", "f.goal").where("g.status", "=", "failed")))
    .returning(["f.key", "f.created_at"])
    .execute();
  return rows.toSorted((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.key.localeCompare(b.key)).map((r) => r.key);
}

async function defectsToGroup(tx: Tx, runId: string, config: ProjectConfig): Promise<DefectToGroup[]> {
  const rows = await reportedDefectsOf(tx, runId).select(["key", "persona_key", "goal", "title", "observed", "reproduction"]).execute();
  return rows.map((row) => ({
    key: row.key,
    person: config.personas.find((p) => p.id === row.persona_key)?.name ?? row.persona_key,
    goal: clipped(config.goals.find((g) => g.id === row.goal)?.instruction ?? row.goal, GROUPED_GOAL_CHARS),
    title: row.title,
    observed: clipped(row.observed, GROUPED_OBSERVED_CHARS),
    reproduction: (row.reproduction as string[]).slice(0, GROUPED_STEPS).map((step) => clipped(step, GROUPED_STEP_CHARS)),
  }));
}

async function jobForToken(tx: Tx, token: string, options: { allowExpired?: boolean; expectedJobId?: string } = {}) {
  const job = await tx
    .selectFrom("jobs")
    .selectAll()
    .select(sql<boolean>`status = 'leased' and lease_until < now()`.as("expired"))
    .where("token_hash", "=", hashToken(token))
    .forUpdate()
    .executeTakeFirst();
  if (!job || (job.expired && !options.allowExpired) || (options.expectedJobId !== undefined && job.id !== options.expectedJobId)) throw new InvalidJobToken();
  return job;
}

export class JobOver extends Error {}

export async function leasedJobFor(tx: Tx, token: string, jobId: string) {
  const job = await jobForToken(tx, token, { expectedJobId: jobId });
  if (job.status !== "leased") throw new JobOver("the job is over");
  const run = await tx.selectFrom("runs").select("status").where("id", "=", job.run_id).executeTakeFirstOrThrow();
  if (!ACTIVE.includes(run.status)) throw new JobOver("the run is no longer active");
  return job;
}

async function addCost(tx: Tx, runId: string, jobId: string, usd: number) {
  if (usd <= 0) return;
  await tx.updateTable("jobs").set({ counted_cost: sql`counted_cost + ${usd}` }).where("id", "=", jobId).execute();
  await tx.updateTable("runs").set({ cost_usd: sql`cost_usd + ${usd}` }).where("id", "=", runId).execute();
}

const lockedRun = (tx: Tx, runId: string) =>
  tx
    .selectFrom("runs as r")
    .innerJoin("projects as p", "p.id", "r.project_id")
    .select(["r.org_id", "r.paid_by", "r.status", "r.cost_usd", "r.budget_usd", "r.token_cap", "r.tokens_used", "r.completion_usd_per_mtok", sql<boolean>`p.paused_at is not null`.as("paused"), sql<boolean>`coalesce(r.started_at <= now() - make_interval(hours => ${RUN_TIME_LIMIT_HOURS}), false)`.as("over_time")])
    .where("r.id", "=", runId)
    .forUpdate(["r"])
    .executeTakeFirstOrThrow();

type LockedRun = Awaited<ReturnType<typeof lockedRun>>;
type RunEnd = { status: "stopped_budget" } | { status: "cancelled"; reason: CancelReason };

async function spentWorkspaceBudget(tx: Tx, run: { org_id: string; paid_by: string; completion_usd_per_mtok: string | null }): Promise<boolean> {
  if (run.paid_by === "trawler") return false;
  const left = budgetLeft(await monthlyBudget(tx, run.org_id));
  return left <= 0 || affordableOutputTokens(left, run.completion_usd_per_mtok === null ? null : Number(run.completion_usd_per_mtok)) < 1;
}

async function limitReached(tx: Tx, run: LockedRun): Promise<RunEnd | null> {
  if (runsHalted()) return { status: "cancelled", reason: "halted" };
  if (run.paused) return { status: "cancelled", reason: "paused" };
  if (capSpent(run)) return { status: "stopped_budget" };
  if (await spentWorkspaceBudget(tx, run)) return { status: "cancelled", reason: "workspace_budget" };
  if (run.over_time) return { status: "cancelled", reason: "time_limit" };
  return null;
}

async function limitStop(tx: Tx, runId: string): Promise<RunEnd | "inactive" | null> {
  const run = await lockedRun(tx, runId);
  if (!ACTIVE.includes(run.status)) return "inactive";
  const end = await limitReached(tx, run);
  if (end) await endRun(tx, runId, end);
  return end;
}

async function stopIfOverLimits(tx: Tx, runId: string): Promise<boolean> {
  return (await limitStop(tx, runId)) !== null;
}

async function judgeAgainStopped(tx: Tx, runId: string): Promise<boolean> {
  const run = await lockedRun(tx, runId);
  return runsHalted() || run.paused || capSpent(run) || (await spentWorkspaceBudget(tx, run));
}

export async function stopRunsPastLimits(db: Database): Promise<number> {
  const due = await asSystem(db, (tx) => {
    const live = tx.selectFrom("runs").select("id").where("status", "in", ACTIVE);
    return (runsHalted() ? live : live.where(sql<boolean>`started_at <= now() - make_interval(hours => ${RUN_TIME_LIMIT_HOURS})`)).execute();
  });
  let stopped = 0;
  for (const run of due) {
    try {
      const stop = await asSystem(db, (tx) => limitStop(tx, run.id));
      if (stop !== null && stop !== "inactive") stopped++;
    } catch (err) {
      await logError("a run past its limits could not be stopped", { runId: run.id, err });
    }
  }
  return stopped;
}

export async function ingestEvents(db: Database, token: string, events: RunEvent[], expectedJobId?: string): Promise<{ cancel: boolean }> {
  return asSystem(db, async (tx) => {
    const valid = storable(z.array(RunEventSchema).max(500).parse(events));
    const job = await jobForToken(tx, token, { expectedJobId });
    if (job.status !== "leased") return { cancel: true };
    if (valid.some((e) => e.jobId !== job.id)) throw new ForeignEvents();
    const run = await tx.selectFrom("runs").select("status").where("id", "=", job.run_id).forUpdate().executeTakeFirstOrThrow();
    const judgingAgain = Boolean(job.requested_by);
    if (!ACTIVE.includes(run.status) && !judgingAgain) return { cancel: true };
    for (const e of valid) {
      const inserted = await tx
        .insertInto("run_events")
        .values({ org_id: job.org_id, run_id: job.run_id, job_id: job.id, seq: e.seq, type: e.type, at: new Date(e.at), payload: JSON.stringify(e) })
        .onConflict((oc) => oc.columns(["job_id", "seq"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) continue;
      if (e.type === "finding" && job.kind === "role_session") {
        const f = { ...e.finding, id: `${job.persona_key}:${e.finding.id}` };
        await tx
          .insertInto("findings")
          .values({ org_id: job.org_id, run_id: job.run_id, job_id: job.id, key: f.id, persona_key: job.persona_key!, kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: JSON.stringify(f.reproduction), severity: f.severity, url: f.url ?? null, quote: f.quote ?? null, step_people: f.by ? JSON.stringify(f.by) : null })
          .onConflict((oc) => oc.columns(["run_id", "key"]).doUpdateSet({ kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: JSON.stringify(f.reproduction), severity: f.severity, url: f.url ?? null, quote: f.quote ?? null, step_people: f.by ? JSON.stringify(f.by) : null, updated_at: new Date() }).where("findings.job_id", "=", job.id))
          .execute();
      } else if (e.type === "goal_status" && job.kind === "role_session") {
        const o = e.outcome;
        await tx
          .insertInto("goal_outcomes")
          .values({ org_id: job.org_id, run_id: job.run_id, persona_key: job.persona_key!, goal: o.goal, status: o.status, note: o.note })
          .onConflict((oc) => oc.columns(["run_id", "persona_key", "goal"]).doUpdateSet({ status: o.status, note: o.note }))
          .execute();
      } else if (e.type === "verdict" && job.kind === "judge" && e.findingId === job.finding_key) {
        await tx.updateTable("findings").set({ verdict: e.verdict, updated_at: new Date() }).where("run_id", "=", job.run_id).where("key", "=", e.findingId).execute();
      }
    }
    await tx.updateTable("jobs").set({ lease_until: sql<Date>`now() + make_interval(mins => ${LEASE_MINUTES})` }).where("id", "=", job.id).execute();
    return { cancel: judgingAgain ? await judgeAgainStopped(tx, job.run_id) : await stopIfOverLimits(tx, job.run_id) };
  });
}

export interface LlmCall {
  orgId: string;
  paidBy: PaidBy;
  firstOnUs: boolean;
  runId: string;
  jobId: string;
  models: string[];
  provider: Provider;
  providerBaseUrl: string | null;
  price: Price | null;
  remainingUsd: number;
  remainingTokens: number | null;
}

export class LlmRefused extends Error {}

export async function llmCallFor(db: Database, token: string): Promise<LlmCall> {
  const outcome = await asSystem(db, async (tx): Promise<LlmCall | { refused: string }> => {
    const job = await jobForToken(tx, token);
    if (job.status !== "leased") return { refused: "the job is over" };
    if (job.requested_by) {
      const run = await lockedRun(tx, job.run_id);
      if (runsHalted() || run.paused) return { refused: "the run is no longer active" };
    } else {
      const stop = await limitStop(tx, job.run_id);
      if (stop) return { refused: stop !== "inactive" && stop.status === "stopped_budget" ? "the run has spent its budget" : "the run is no longer active" };
    }
    const run = await tx.selectFrom("runs").select(["status", "cost_usd", "budget_usd", "agent_model", "judge_model", "provider", "provider_base_url", "prompt_usd_per_mtok", "completion_usd_per_mtok", "token_cap", "tokens_used", "paid_by"]).where("id", "=", job.run_id).executeTakeFirstOrThrow();
    const workspaceLeft = run.paid_by === "trawler" ? Infinity : budgetLeft(await monthlyBudget(tx, job.org_id));
    const remainingUsd = Math.min(Number(run.budget_usd) - Number(run.cost_usd), workspaceLeft);
    const remainingTokens = run.token_cap === null ? null : Number(run.token_cap) - Number(run.tokens_used);
    if (remainingUsd <= 0 || (remainingTokens !== null && remainingTokens <= 0)) return { refused: "the run has spent its budget" };
    const firstOnUs = run.paid_by === "trawler" && !!(await tx.updateTable("first_runs_on_us").set({ model_called_at: sql<Date>`now()` }).where("run_id", "=", job.run_id).where("model_called_at", "is", null).returning("run_id").executeTakeFirst());
    await tx.updateTable("jobs").set({ lease_until: sql<Date>`now() + make_interval(mins => ${LEASE_MINUTES})` }).where("id", "=", job.id).execute();
    return { orgId: job.org_id, paidBy: run.paid_by as PaidBy, firstOnUs, runId: job.run_id, jobId: job.id, models: [...new Set([run.agent_model, run.judge_model])], provider: run.provider as Provider, providerBaseUrl: run.provider_base_url,
      price: run.prompt_usd_per_mtok === null || run.completion_usd_per_mtok === null ? null : { promptUsdPerMtok: Number(run.prompt_usd_per_mtok), completionUsdPerMtok: Number(run.completion_usd_per_mtok) },
      remainingUsd, remainingTokens };
  });
  if ("refused" in outcome) throw new LlmRefused(outcome.refused);
  return outcome;
}

export async function forgetUnpaidFirstCall(db: Database, runId: string): Promise<void> {
  await asSystem(db, async (tx) => {
    const run = await tx.selectFrom("runs").select("status").where("id", "=", runId).forUpdate().executeTakeFirstOrThrow();
    await tx
      .updateTable("first_runs_on_us")
      .set({ model_called_at: null })
      .where("run_id", "=", runId)
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom("llm_usage").select("id").where("run_id", "=", runId))))
      .execute();
    if (!ACTIVE.includes(run.status)) await giveBackUnusedFirstRun(tx, runId);
  });
}

export async function recordLlmUsage(db: Database, call: LlmCall, usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number }): Promise<void> {
  await asSystem(db, async (tx) => {
    await tx.selectFrom("jobs").select("id").where("id", "=", call.jobId).forUpdate().executeTakeFirstOrThrow();
    await tx.selectFrom("runs").select("id").where("id", "=", call.runId).forUpdate().executeTakeFirstOrThrow();
    await tx.insertInto("llm_usage").values({
      org_id: call.orgId, run_id: call.runId, job_id: call.jobId, model: usage.model.slice(0, 200), paid_by: call.paidBy,
      input_tokens: Math.max(0, Math.round(usage.inputTokens)), output_tokens: Math.max(0, Math.round(usage.outputTokens)), cost_usd: Math.max(0, usage.costUsd).toFixed(6),
    }).execute();
    await addCost(tx, call.runId, call.jobId, usage.costUsd);
    const tokens = Math.max(0, Math.round(usage.inputTokens)) + Math.max(0, Math.round(usage.outputTokens));
    await tx.updateTable("runs").set({ tokens_used: sql`tokens_used + ${tokens}` }).where("id", "=", call.runId).execute();
    await stopIfOverLimits(tx, call.runId);
  });
}

const noReport = (o?: ReplayObservation) => !o || (!o.completed && o.blockedAt === null);

const JobResultSchema = z.object({ usage: JobUsageSchema, stoppedBy: JobStopReasonSchema, error: z.string().max(2000).optional(), observation: ReplayObservationSchema.optional(), signIn: SignInCheckSchema.optional(), groups: DefectGroupsSchema.optional() });

async function refusal(tx: Tx, runId: string, accountRef: string, observed: string): Promise<string> {
  const run = await tx.selectFrom("runs").select("config_snapshot").where("id", "=", runId).executeTakeFirstOrThrow();
  const username = (run.config_snapshot as unknown as ConfigSnapshot).accounts.find((a) => a.ref === accountRef)?.username ?? accountRef;
  return `${ACCOUNT_REFUSED} ${username}: ${observed}`.slice(0, 2000);
}

export async function completeJob(db: Database, token: string, input: JobResult, expectedJobId?: string): Promise<void> {
  const result = storable(JobResultSchema.parse(input));
  await asSystem(db, async (tx) => {
    const job = await jobForToken(tx, token, { allowExpired: true, expectedJobId });
    if (job.status !== "leased") return;
    const refused = job.kind === "account_check" && result.signIn?.outcome === "refused" ? await refusal(tx, job.run_id, job.account_ref!, result.signIn.observed) : null;
    const failed = result.stoppedBy === "error" || refused !== null;
    await tx
      .updateTable("jobs")
      .set({ status: failed ? "failed" : "succeeded", usage: JSON.stringify(result.usage), stopped_by: result.stoppedBy, error: refused ?? result.error ?? null, finished_at: new Date(), lease_until: null })
      .where("id", "=", job.id)
      .execute();
    if (refused) {
      await tx.updateTable("runs").set({ status: "cancelled", cancel_reason: "account_refused", finished_at: new Date(), sign_up_seed: null }).where("id", "=", job.run_id).where("status", "in", ACTIVE).execute();
      await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", job.run_id).where("status", "=", "queued").execute();
      await giveBackUnusedFirstRun(tx, job.run_id);
      return;
    }
    if (job.kind === "replay" && result.observation) {
      await tx.updateTable("findings").set({ replay: JSON.stringify(ReplayObservationSchema.parse(result.observation)), updated_at: new Date() }).where("run_id", "=", job.run_id).where("key", "=", job.finding_key!).execute();
    }
    if (await stopIfOverLimits(tx, job.run_id)) return;
    await planNext(tx, job, result);
  });
}

async function queueReplays(tx: Tx, job: { run_id: string; org_id: string }, next: number, keys: string[]) {
  if (keys.length) await tx.insertInto("jobs").values(keys.map((key, i) => ({ org_id: job.org_id, run_id: job.run_id, kind: "replay", position: next + i, finding_key: key }))).execute();
}

async function handOverToNextReport(tx: Tx, runId: string, key: string): Promise<string | null> {
  const successor = await defectsOf(tx, runId).select("key").where("same_as", "=", key).where("replay", "is", null).limit(1).executeTakeFirst();
  if (!successor) return null;
  const now = new Date();
  await tx.updateTable("findings").set({ same_as: null, updated_at: now }).where("run_id", "=", runId).where("key", "=", successor.key).execute();
  await tx.updateTable("findings").set({ same_as: successor.key, updated_at: now }).where("run_id", "=", runId).where((eb) => eb.or([eb("same_as", "=", key), eb("key", "=", key)])).execute();
  return successor.key;
}

async function planNext(tx: Tx, job: { run_id: string; org_id: string; kind: string; finding_key: string | null }, result: JobResult) {
  const { next } = await tx.selectFrom("jobs").select(sql<number>`coalesce(max(position), -1) + 1`.as("next")).where("run_id", "=", job.run_id).executeTakeFirstOrThrow();
  if (job.kind === "role_session") {
    const rolesLeft = await tx.selectFrom("jobs").select("id").where("run_id", "=", job.run_id).where("kind", "=", "role_session").where("status", "in", ["queued", "leased"]).executeTakeFirst();
    if (!rolesLeft) {
      await tx.updateTable("runs").set({ sign_up_seed: null }).where("id", "=", job.run_id).execute();
      const candidates = await frictionToCheck(tx, job.run_id);
      const defects = await reportedDefectsOf(tx, job.run_id).select("key").execute();
      if (defects.length >= 2 && defects.length <= MAX_GROUPED_DEFECTS) {
        await tx.insertInto("jobs").values({ org_id: job.org_id, run_id: job.run_id, kind: "group", position: next }).execute();
        await queueReplays(tx, job, next + 1, candidates);
      } else await queueReplays(tx, job, next, [...defects.map((d) => d.key), ...candidates]);
    }
  } else if (job.kind === "group") {
    const keys = (await reportedDefectsOf(tx, job.run_id).select("key").execute()).map((d) => d.key);
    const groups = result.groups && result.stoppedBy !== "error" ? settleGroups(keys, result.groups) : keys.map((key) => [key]);
    const firstReported = groups.map((group) => group.toSorted((a, b) => keys.indexOf(a) - keys.indexOf(b)));
    for (const [representative, ...same] of firstReported) {
      if (same.length) await tx.updateTable("findings").set({ same_as: representative, updated_at: new Date() }).where("run_id", "=", job.run_id).where("key", "in", same).execute();
    }
    await queueReplays(tx, job, next, keys.filter((key) => firstReported.some((group) => group[0] === key)));
  } else if (job.kind === "replay" && !noReport(result.observation)) {
    await tx.insertInto("jobs").values({ org_id: job.org_id, run_id: job.run_id, kind: "judge", position: next, finding_key: job.finding_key }).execute();
  } else if (job.kind === "replay" && result.observation && result.stoppedBy !== "error") {
    const successor = await handOverToNextReport(tx, job.run_id, job.finding_key!);
    if (successor) await queueReplays(tx, job, next, [successor]);
  }
  const open = await tx.selectFrom("jobs").select("id").where("run_id", "=", job.run_id).where("status", "in", ["queued", "leased"]).executeTakeFirst();
  if (!open) {
    const roles = await tx.selectFrom("jobs").select("status").where("run_id", "=", job.run_id).where("kind", "=", "role_session").execute();
    const allFailed = roles.length > 0 && roles.every((r) => r.status === "failed");
    await tx.updateTable("runs").set({ status: allFailed ? "failed" : "succeeded", finished_at: new Date() }).where("id", "=", job.run_id).where("status", "in", ACTIVE).execute();
    await giveBackUnusedFirstRun(tx, job.run_id);
  }
}
