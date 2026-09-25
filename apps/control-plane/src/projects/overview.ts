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
  projectId: string;
  projectName: string;
  projectSite: string | null;
}

export type RunFilter = "all" | "completed" | "attention";

const FILTER_STATUSES: Record<Exclude<RunFilter, "all">, string[]> = { completed: ["succeeded"], attention: ["stopped_budget", "failed", "cancelled"] };

export interface ProjectLine {
  id: string;
  name: string;
  targetUrl: string;
  site: string | null;
  lastRun: RunLine | null;
}

export interface NavProject {
  id: string;
  name: string;
  address: string;
}

export const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : url);

function namesUsed(projects: Array<{ name: string }>): Map<string, number> {
  const named = new Map<string, number>();
  for (const p of projects) named.set(p.name, (named.get(p.name) ?? 0) + 1);
  return named;
}

const siteOf = (url: string) => (URL.canParse(url) ? `${new URL(url).host}${new URL(url).pathname.replace(/\/+$/, "")}` : url);

function runLines(tx: Tx, orgId: string) {
  return tx
    .selectFrom("runs as r")
    .innerJoin("projects as p", "p.id", "r.project_id")
    .where("r.org_id", "=", orgId)
    .select((eb) => [
      "r.id", "r.number", "r.status", "r.created_at", "r.cost_usd", "r.token_cap", "r.tokens_used", "r.project_id", "p.name as project_name", "p.target_url as project_url",
      eb.exists(eb.selectFrom("projects as twin").select("twin.id").whereRef("twin.org_id", "=", "p.org_id").whereRef("twin.name", "=", "p.name").whereRef("twin.id", "<>", "p.id")).as("name_shared"),
      eb.selectFrom("findings as f").select((f) => f.fn.countAll<string>().as("n")).whereRef("f.run_id", "=", "r.id").where("f.kind", "=", "defect").where("f.verdict", "=", "confirmed")
        .where((f) => f.not(f.exists(f.selectFrom("jobs as j").select("j.id").whereRef("j.run_id", "=", "f.run_id").whereRef("j.finding_key", "=", "f.key").where("j.kind", "=", "judge").where("j.requested_by", "is not", null).where("j.status", "in", ["queued", "leased"]))))
        .as("confirmed"),
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
    projectId: r.project_id, projectName: r.project_name, projectSite: r.name_shared ? siteOf(r.project_url) : null,
  };
}

export async function workspaceProjects(tx: Tx, orgId: string): Promise<ProjectLine[]> {
  const projects = await tx
    .selectFrom("projects as p")
    .where("p.org_id", "=", orgId)
    .select((eb) => [
      "p.id", "p.name", "p.target_url", "p.created_at",
      eb.selectFrom("runs as r").select((r) => r.fn.max("r.number").as("n")).whereRef("r.project_id", "=", "p.id").as("last_number"),
    ])
    .execute();
  const numbers = projects.flatMap((p) => (p.last_number === null ? [] : [p.last_number]));
  const lastRuns = numbers.length ? (await runLines(tx, orgId).where("r.number", "in", numbers).execute()).map((r) => [r.project_id, toLine(r)] as const) : [];
  const lastRun = new Map(lastRuns);
  const named = namesUsed(projects);
  return projects
    .map((p) => ({ line: { id: p.id, name: p.name, targetUrl: p.target_url, site: named.get(p.name)! > 1 ? siteOf(p.target_url) : null, lastRun: lastRun.get(p.id) ?? null }, active: (lastRun.get(p.id)?.createdAt ?? p.created_at).getTime() }))
    .sort((a, b) => b.active - a.active || a.line.id.localeCompare(b.line.id))
    .map((p) => p.line);
}

export async function projectHead(tx: Tx, orgId: string, projectId: string) {
  const project = await tx.selectFrom("projects").select(["id", "name", "target_url"]).where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  return project ? { id: project.id, name: project.name, targetUrl: project.target_url } : null;
}

export async function workspaceRuns(tx: Tx, orgId: string, options: { projectId?: string; show?: RunFilter; before?: number; size?: number } = {}) {
  const size = options.size ?? RUNS_PER_PAGE;
  const show = options.show ?? "all";
  let query = runLines(tx, orgId).orderBy("r.number", "desc").limit(size + 1);
  if (options.projectId !== undefined) query = query.where("r.project_id", "=", options.projectId);
  if (show !== "all") query = query.where("r.status", "in", FILTER_STATUSES[show]);
  if (options.before !== undefined) query = query.where("r.number", "<", options.before);
  const rows = await query.execute();
  const runs = rows.slice(0, size).map(toLine);
  return { runs, olderThan: rows.length > size ? runs.at(-1)!.number : null };
}

export async function runCounts(tx: Tx, orgId: string, projectId?: string): Promise<Record<RunFilter, number>> {
  let query = tx
    .selectFrom("runs")
    .where("org_id", "=", orgId)
    .select([
      sql<string>`count(*)`.as("all"),
      sql<string>`count(*) filter (where status in (${sql.join(FILTER_STATUSES.completed)}))`.as("completed"),
      sql<string>`count(*) filter (where status in (${sql.join(FILTER_STATUSES.attention)}))`.as("attention"),
    ]);
  if (projectId !== undefined) query = query.where("project_id", "=", projectId);
  const counts = await query.executeTakeFirstOrThrow();
  return { all: Number(counts.all), completed: Number(counts.completed), attention: Number(counts.attention) };
}

export async function workspaceNav(tx: Tx, orgId: string): Promise<{ projects: NavProject[]; runs: number }> {
  const [projects, runs] = await Promise.all([
    tx
      .selectFrom("projects as p")
      .where("p.org_id", "=", orgId)
      .select((eb) => [
        "p.id", "p.name", "p.target_url", "p.created_at",
        eb.selectFrom("runs as r").select((r) => r.fn.max("r.created_at").as("at")).whereRef("r.project_id", "=", "p.id").as("last_run_at"),
      ])
      .execute(),
    tx.selectFrom("runs").select((eb) => eb.fn.countAll<string>().as("n")).where("org_id", "=", orgId).executeTakeFirstOrThrow(),
  ]);
  const active = (p: (typeof projects)[number]) => (p.last_run_at ? new Date(p.last_run_at) : p.created_at).getTime();
  const named = namesUsed(projects);
  return {
    projects: projects
      .sort((a, b) => active(b) - active(a) || a.id.localeCompare(b.id))
      .map((p) => ({ id: p.id, name: p.name, address: named.get(p.name)! > 1 ? siteOf(p.target_url) : hostOf(p.target_url) })),
    runs: Number(runs.n),
  };
}

export async function projectRunCount(tx: Tx, orgId: string, projectId: string): Promise<number> {
  const { n } = await tx.selectFrom("runs").select((eb) => eb.fn.countAll<string>().as("n")).where("org_id", "=", orgId).where("project_id", "=", projectId).executeTakeFirstOrThrow();
  return Number(n);
}
