import { sql } from "kysely";
import type { Tx } from "../db/tenancy.ts";

export const RUNS_PER_PAGE = 50;

export interface RunLine {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  costUsd: number;
  tokenCap: number | null;
  tokensUsed: number;
  confirmed: number;
  goalsReached: number;
  goalsTotal: number;
}

export interface ProjectLine {
  id: string;
  name: string;
  targetUrl: string;
  runs: number;
  lastRun: RunLine | null;
}

function runLines(tx: Tx, orgId: string) {
  return tx
    .selectFrom("runs as r")
    .where("r.org_id", "=", orgId)
    .select((eb) => [
      "r.id", "r.number", "r.status", "r.created_at", "r.cost_usd", "r.token_cap", "r.tokens_used", "r.project_id",
      eb.selectFrom("findings as f").select((f) => f.fn.countAll<string>().as("n")).whereRef("f.run_id", "=", "r.id").where("f.kind", "=", "defect").where("f.verdict", "=", "confirmed").as("confirmed"),
      eb.selectFrom("goal_outcomes as g").select((g) => g.fn.countAll<string>().as("n")).whereRef("g.run_id", "=", "r.id").where("g.status", "=", "reached").as("goals_reached"),
      sql<number>`jsonb_array_length(r.config_snapshot -> 'personas') * jsonb_array_length(r.config_snapshot -> 'goals')`.as("goals_total"),
    ]);
}

type RunRow = Awaited<ReturnType<ReturnType<typeof runLines>["execute"]>>[number];

function toLine(r: RunRow): RunLine {
  return {
    id: r.id, number: r.number, status: r.status, createdAt: r.created_at,
    costUsd: Number(r.cost_usd), tokenCap: r.token_cap === null ? null : Number(r.token_cap), tokensUsed: Number(r.tokens_used),
    confirmed: Number(r.confirmed ?? 0), goalsReached: Number(r.goals_reached ?? 0), goalsTotal: Number(r.goals_total ?? 0),
  };
}

export async function workspaceProjects(tx: Tx, orgId: string): Promise<ProjectLine[]> {
  const projects = await tx
    .selectFrom("projects as p")
    .where("p.org_id", "=", orgId)
    .select((eb) => [
      "p.id", "p.name", "p.target_url", "p.created_at",
      eb.selectFrom("runs as r").select((r) => r.fn.max("r.number").as("n")).whereRef("r.project_id", "=", "p.id").as("last_number"),
      eb.selectFrom("runs as r").select((r) => r.fn.countAll<string>().as("n")).whereRef("r.project_id", "=", "p.id").as("runs"),
    ])
    .execute();
  const numbers = projects.flatMap((p) => (p.last_number === null ? [] : [p.last_number]));
  const lastRuns = numbers.length ? (await runLines(tx, orgId).where("r.number", "in", numbers).execute()).map((r) => [r.project_id, toLine(r)] as const) : [];
  const lastRun = new Map(lastRuns);
  return projects
    .map((p) => ({ line: { id: p.id, name: p.name, targetUrl: p.target_url, runs: Number(p.runs ?? 0), lastRun: lastRun.get(p.id) ?? null }, active: (lastRun.get(p.id)?.createdAt ?? p.created_at).getTime() }))
    .sort((a, b) => b.active - a.active || a.line.id.localeCompare(b.line.id))
    .map((p) => p.line);
}

export async function projectRuns(tx: Tx, orgId: string, projectId: string, page: { before?: number; size?: number } = {}) {
  const project = await tx.selectFrom("projects").select(["id", "name", "target_url"]).where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!project) return null;
  const size = page.size ?? RUNS_PER_PAGE;
  let query = runLines(tx, orgId).where("r.project_id", "=", projectId).orderBy("r.number", "desc").limit(size + 1);
  if (page.before !== undefined) query = query.where("r.number", "<", page.before);
  const rows = await query.execute();
  const runs = rows.slice(0, size).map(toLine);
  return { project: { id: project.id, name: project.name, targetUrl: project.target_url }, runs, olderThan: rows.length > size ? runs.at(-1)!.number : null };
}

export async function projectRunCount(tx: Tx, orgId: string, projectId: string): Promise<number> {
  const { n } = await tx.selectFrom("runs").select((eb) => eb.fn.countAll<string>().as("n")).where("org_id", "=", orgId).where("project_id", "=", projectId).executeTakeFirstOrThrow();
  return Number(n);
}
