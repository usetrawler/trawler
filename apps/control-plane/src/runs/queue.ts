import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { FindingSchema, JobUsageSchema, JobStopReasonSchema, ReplayObservationSchema, RunEventSchema, type Finding, type JobStopReason, type JobUsage, type ProjectConfig, type ReplayObservation, type RunEvent } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem, type Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { loadProjectConfig } from "../projects/projects.ts";
import type { ConfigSnapshot } from "./runs.ts";

const LEASE_MINUTES = 10;
const LATE_REPORT_MS = 60 * 60 * 1000;
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
  kind: "role_session" | "replay" | "judge";
  config: ProjectConfig;
  personaKey?: string;
  accountRef?: string;
  finding?: Finding;
  observation?: ReplayObservation;
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
}

export class ForeignEvents extends Error {
  constructor() {
    super("events belong to another job");
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function configFor(snapshot: ConfigSnapshot, current: ProjectConfig): ProjectConfig {
  const passwords = new Map(current.accounts.map((a) => [a.ref, a.password]));
  return {
    ...snapshot,
    personas: snapshot.personas.map((p) => (p.accountRef && !passwords.has(p.accountRef) ? { id: p.id, name: p.name, brief: p.brief } : p)),
    accounts: snapshot.accounts.filter((a) => passwords.has(a.ref)).map((a) => ({ ...a, password: passwords.get(a.ref)! })),
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
      if (!(await stopIfOverBudget(tx, job.run_id))) await planNext(tx, job, { usage: { model: "", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "error" });
    }
  });
}

type ClaimOutcome = { assignment: JobAssignment } | { quarantined: true } | null;

async function claimOnce(db: Database, keys: Keyring): Promise<ClaimOutcome> {
  return asSystem(db, async (tx) => {
    const picked = await tx
      .selectFrom("jobs as j")
      .innerJoin("runs as r", "r.id", "j.run_id")
      .select(["j.id", "j.org_id", "j.run_id", "j.kind", "j.persona_key", "j.finding_key", "r.project_id", "r.config_snapshot", "r.max_steps", "r.replay_steps", "r.budget_usd", "r.cost_usd", "r.agent_model", "r.judge_model"])
      .where("j.status", "=", "queued")
      .where("r.status", "in", ACTIVE)
      .where((eb) => eb.not(eb.exists(eb.selectFrom("jobs as busy").select("busy.id").whereRef("busy.run_id", "=", "j.run_id").where("busy.status", "=", "leased"))))
      .orderBy("r.created_at")
      .orderBy("j.position")
      .limit(1)
      .forUpdate(["j", "r"])
      .skipLocked()
      .executeTakeFirst();
    if (!picked) return null;
    const token = randomBytes(32).toString("base64url");
    await tx.updateTable("jobs").set({ status: "leased", token_hash: hashToken(token), lease_until: sql<Date>`now() + make_interval(mins => ${LEASE_MINUTES})`, started_at: new Date() }).where("id", "=", picked.id).execute();
    await tx.updateTable("runs").set({ status: "running", started_at: sql<Date>`coalesce(started_at, now())` }).where("id", "=", picked.run_id).execute();
    await sql`savepoint prepare_assignment`.execute(tx);
    try {
      const snapshot = picked.config_snapshot as unknown as ConfigSnapshot;
      const current = await loadProjectConfig(tx, picked.org_id, picked.project_id, keys);
      const finding = picked.finding_key ? await findingFor(tx, picked.run_id, picked.finding_key) : undefined;
      return {
        assignment: {
          jobId: picked.id,
          runId: picked.run_id,
          token,
          kind: picked.kind as JobAssignment["kind"],
          config: configFor(snapshot, current),
          personaKey: picked.persona_key ?? undefined,
          accountRef: finding ? snapshot.personas.find((p) => p.id === finding.personaKey)?.accountRef : undefined,
          finding: finding?.finding,
          observation: finding?.replay,
          maxSteps: picked.kind === "role_session" ? picked.max_steps : picked.replay_steps,
          budgetUsd: Math.max(0, Number(picked.budget_usd) - Number(picked.cost_usd)),
          agentModel: picked.agent_model,
          judgeModel: picked.judge_model,
        },
      };
    } catch (err) {
      await sql`rollback to savepoint prepare_assignment`.execute(tx);
      console.error("job could not be prepared", { jobId: picked.id, message: err instanceof Error ? err.message : String(err) });
      await tx.updateTable("jobs").set({ status: "failed", error: "the job could not be prepared from the project; it may have changed since the run started", token_hash: null, lease_until: null, finished_at: new Date() }).where("id", "=", picked.id).execute();
      if (!(await stopIfOverBudget(tx, picked.run_id))) await planNext(tx, picked, { usage: { model: "", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "error" });
      return { quarantined: true };
    }
  });
}

export async function claimJob(db: Database, keys: Keyring): Promise<JobAssignment | null> {
  await reapExpiredLeases(db);
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

async function findingFor(tx: Tx, runId: string, key: string) {
  const row = await tx.selectFrom("findings").selectAll().where("run_id", "=", runId).where("key", "=", key).executeTakeFirstOrThrow();
  return {
    personaKey: row.persona_key,
    finding: { ...FindingSchema.parse({ id: "stored", kind: row.kind, goal: row.goal, title: row.title, observed: row.observed, reproduction: row.reproduction, severity: row.severity }), id: row.key },
    replay: row.replay ? ReplayObservationSchema.parse(row.replay) : undefined,
  };
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

async function addCost(tx: Tx, runId: string, jobId: string, usd: number) {
  if (usd <= 0) return;
  await tx.updateTable("jobs").set({ counted_cost: sql`counted_cost + ${usd}` }).where("id", "=", jobId).execute();
  await tx.updateTable("runs").set({ cost_usd: sql`cost_usd + ${usd}` }).where("id", "=", runId).execute();
}

async function stopIfOverBudget(tx: Tx, runId: string): Promise<boolean> {
  const run = await tx.selectFrom("runs").select(["status", "cost_usd", "budget_usd"]).where("id", "=", runId).forUpdate().executeTakeFirstOrThrow();
  if (!ACTIVE.includes(run.status)) return true;
  if (Number(run.cost_usd) < Number(run.budget_usd)) return false;
  await tx.updateTable("runs").set({ status: "stopped_budget", finished_at: new Date() }).where("id", "=", runId).execute();
  await tx.updateTable("jobs").set({ status: "cancelled", finished_at: new Date() }).where("run_id", "=", runId).where("status", "=", "queued").execute();
  return true;
}

export async function ingestEvents(db: Database, token: string, events: RunEvent[], expectedJobId?: string): Promise<{ cancel: boolean }> {
  return asSystem(db, async (tx) => {
    const valid = z.array(RunEventSchema).max(500).parse(events);
    const job = await jobForToken(tx, token, { expectedJobId });
    if (job.status !== "leased") return { cancel: true };
    if (valid.some((e) => e.jobId !== job.id)) throw new ForeignEvents();
    const run = await tx.selectFrom("runs").select("status").where("id", "=", job.run_id).forUpdate().executeTakeFirstOrThrow();
    if (!ACTIVE.includes(run.status)) return { cancel: true };
    for (const e of valid) {
      const inserted = await tx
        .insertInto("run_events")
        .values({ org_id: job.org_id, run_id: job.run_id, job_id: job.id, seq: e.seq, type: e.type, at: new Date(e.at), payload: JSON.stringify(e) })
        .onConflict((oc) => oc.columns(["job_id", "seq"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) continue;
      if (e.type === "step") await addCost(tx, job.run_id, job.id, e.costUsd);
      else if (e.type === "finding" && job.kind === "role_session") {
        const f = { ...e.finding, id: `${job.persona_key}:${e.finding.id}` };
        await tx
          .insertInto("findings")
          .values({ org_id: job.org_id, run_id: job.run_id, job_id: job.id, key: f.id, persona_key: job.persona_key!, kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: JSON.stringify(f.reproduction), severity: f.severity })
          .onConflict((oc) => oc.columns(["run_id", "key"]).doUpdateSet({ kind: f.kind, goal: f.goal, title: f.title, observed: f.observed, reproduction: JSON.stringify(f.reproduction), severity: f.severity, updated_at: new Date() }).where("findings.job_id", "=", job.id))
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
    return { cancel: await stopIfOverBudget(tx, job.run_id) };
  });
}

const noReport = (o?: ReplayObservation) => !o || (!o.completed && o.blockedAt === null);

const JobResultSchema = z.object({ usage: JobUsageSchema, stoppedBy: JobStopReasonSchema, error: z.string().max(2000).optional(), observation: ReplayObservationSchema.optional() });

export async function completeJob(db: Database, token: string, input: JobResult, expectedJobId?: string): Promise<void> {
  const result = JobResultSchema.parse(input);
  await asSystem(db, async (tx) => {
    const job = await jobForToken(tx, token, { allowExpired: true, expectedJobId });
    if (job.status !== "leased") {
      const reapedRecently = job.status === "failed" && job.finished_at !== null && Date.now() - job.finished_at.getTime() < LATE_REPORT_MS;
      if (reapedRecently) await addCost(tx, job.run_id, job.id, result.usage.costUsd - Number(job.counted_cost));
      return;
    }
    await addCost(tx, job.run_id, job.id, result.usage.costUsd - Number(job.counted_cost));
    const failed = result.stoppedBy === "error";
    await tx
      .updateTable("jobs")
      .set({ status: failed ? "failed" : "succeeded", usage: JSON.stringify(result.usage), stopped_by: result.stoppedBy, error: result.error?.slice(0, 2000) ?? null, finished_at: new Date(), lease_until: null })
      .where("id", "=", job.id)
      .execute();
    if (job.kind === "replay" && result.observation) {
      await tx.updateTable("findings").set({ replay: JSON.stringify(ReplayObservationSchema.parse(result.observation)), updated_at: new Date() }).where("run_id", "=", job.run_id).where("key", "=", job.finding_key!).execute();
    }
    if (await stopIfOverBudget(tx, job.run_id)) return;
    await planNext(tx, job, result);
  });
}

async function planNext(tx: Tx, job: { run_id: string; org_id: string; kind: string; finding_key: string | null }, result: JobResult) {
  const { next } = await tx.selectFrom("jobs").select(sql<number>`coalesce(max(position), -1) + 1`.as("next")).where("run_id", "=", job.run_id).executeTakeFirstOrThrow();
  if (job.kind === "role_session") {
    const rolesLeft = await tx.selectFrom("jobs").select("id").where("run_id", "=", job.run_id).where("kind", "=", "role_session").where("status", "in", ["queued", "leased"]).executeTakeFirst();
    if (!rolesLeft) {
      const defects = await tx.selectFrom("findings").select("key").where("run_id", "=", job.run_id).where("kind", "=", "defect").orderBy("created_at").orderBy("key").execute();
      if (defects.length) {
        await tx.insertInto("jobs").values(defects.map((d, i) => ({ org_id: job.org_id, run_id: job.run_id, kind: "replay", position: next + i, finding_key: d.key }))).execute();
      }
    }
  } else if (job.kind === "replay" && !noReport(result.observation)) {
    await tx.insertInto("jobs").values({ org_id: job.org_id, run_id: job.run_id, kind: "judge", position: next, finding_key: job.finding_key }).execute();
  }
  const open = await tx.selectFrom("jobs").select("id").where("run_id", "=", job.run_id).where("status", "in", ["queued", "leased"]).executeTakeFirst();
  if (!open) {
    const roles = await tx.selectFrom("jobs").select("status").where("run_id", "=", job.run_id).where("kind", "=", "role_session").execute();
    const allFailed = roles.length > 0 && roles.every((r) => r.status === "failed");
    await tx.updateTable("runs").set({ status: allFailed ? "failed" : "succeeded", finished_at: new Date() }).where("id", "=", job.run_id).where("status", "in", ACTIVE).execute();
  }
}
