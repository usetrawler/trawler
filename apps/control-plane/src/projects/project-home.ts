import { sql } from "kysely";
import type { Tx } from "../db/tenancy.ts";
import { runLinesByIds, type RunLine } from "./overview.ts";

export interface OpenFinding {
  key: string;
  title: string;
  severity: string;
  person: string | null;
  source: string;
  runNumber: number;
  reportedAt: Date;
}

export interface PullRequestLine {
  number: number;
  title: string | null;
  url: string | null;
  plan: { id: string | null; label: string; ofPullRequest: boolean };
  run: RunLine;
}

const prSource = sql<string | null>`CASE WHEN r.pull_request->>'number' IS NOT NULL THEN concat(lower(coalesce(r.pull_request->>'repository', '')), '#', r.pull_request->>'number') END`;
const SEVERITY_RANK = sql<number>`CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

export async function openFindings(tx: Tx, orgId: string, projectId: string): Promise<OpenFinding[]> {
  const { rows } = await sql<{ key: string; title: string; severity: string; person: string | null; pr: string | null; plan_name: string; number: number; created_at: Date }>`
    WITH latest AS (
      SELECT DISTINCT ON (source) id, number, pull_request, plan_name, config_snapshot
      FROM (
        SELECT r.*, coalesce(${prSource}, concat('plan:', coalesce(r.plan_id::text, r.plan_name))) AS source
        FROM runs r
        WHERE r.org_id = ${orgId} AND r.project_id = ${projectId} AND r.status IN ('succeeded', 'stopped_budget')
      ) r
      ORDER BY source, number DESC
    )
    SELECT f.key, f.title, f.severity, f.created_at, l.number, l.plan_name, l.pull_request->>'number' AS pr,
      (SELECT p->>'name' FROM jsonb_array_elements(l.config_snapshot->'personas') p WHERE p->>'id' = f.persona_key LIMIT 1) AS person
    FROM latest l
    JOIN findings f ON f.run_id = l.id
    WHERE f.org_id = ${orgId} AND f.kind = 'defect' AND f.verdict = 'confirmed' AND f.same_as IS NULL
      AND NOT EXISTS (SELECT 1 FROM finding_dismissals d WHERE d.run_id = f.run_id AND d.finding_key = f.key)
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = f.run_id AND j.finding_key = f.key AND j.kind = 'judge' AND j.requested_by IS NOT NULL AND j.status IN ('queued', 'leased'))
    ORDER BY ${SEVERITY_RANK}, f.created_at DESC, f.key
  `.execute(tx);
  return rows.map((r) => ({ key: r.key, title: r.title, severity: r.severity, person: r.person, source: r.pr ? `PR #${r.pr}` : r.plan_name, runNumber: r.number, reportedAt: r.created_at }));
}

export async function projectPullRequests(tx: Tx, orgId: string, projectId: string, limit?: number): Promise<PullRequestLine[]> {
  const { rows } = await sql<{ id: string; number: string; title: string | null; url: string | null; pr_plan_id: string | null; pr_plan_version: string | null; plan_id: string | null; plan_name: string; plan_live: boolean }>`
    SELECT * FROM (
      SELECT DISTINCT ON (${prSource}) r.id, r.number AS run_number, r.pull_request->>'number' AS number, r.pull_request->>'title' AS title, r.pull_request->>'url' AS url,
        r.pr_plan->>'prPlanId' AS pr_plan_id, r.pr_plan->>'version' AS pr_plan_version, r.plan_id, r.plan_name,
        EXISTS (SELECT 1 FROM plans pl WHERE pl.id::text = r.pr_plan->>'prPlanId') AS plan_live
      FROM runs r
      WHERE r.org_id = ${orgId} AND r.project_id = ${projectId} AND r.pull_request->>'number' IS NOT NULL
      ORDER BY ${prSource}, r.number DESC
    ) latest
    ORDER BY run_number DESC
    ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
  `.execute(tx);
  const runs = await runLinesByIds(tx, orgId, rows.map((r) => r.id));
  return rows.map((r) => ({
    number: Number(r.number),
    title: r.title,
    url: r.url,
    plan: r.pr_plan_version ? { id: r.plan_live ? r.pr_plan_id : null, label: `v${r.pr_plan_version}`, ofPullRequest: true } : { id: r.plan_id, label: r.plan_name, ofPullRequest: false },
    run: runs.get(r.id)!,
  }));
}

export function runResult(run: RunLine): string {
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "Running";
  if (run.status === "skipped") return "Skipped: nothing to test in the UI";
  if (run.status === "failed") return "Failed";
  if (run.status === "cancelled") return "Cancelled";
  const confirmed = run.unchecked ? "Not checked: every replay failed" : run.confirmed ? `${run.confirmed} confirmed` : "No defect confirmed";
  return run.status === "stopped_budget" ? `Stopped at cap · ${confirmed}` : confirmed;
}

export async function projectCounts(tx: Tx, orgId: string, projectId: string): Promise<{ runs: number; pullRequests: number }> {
  const { rows } = await sql<{ runs: string; prs: string }>`SELECT count(*) AS runs, count(DISTINCT ${prSource}) AS prs FROM runs r WHERE r.org_id = ${orgId} AND r.project_id = ${projectId}`.execute(tx);
  return { runs: Number(rows[0]?.runs ?? 0), pullRequests: Number(rows[0]?.prs ?? 0) };
}
