import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { expect, test } from "vitest";
import { databaseUrl, onServer } from "./test-db.ts";

const root = join(import.meta.dirname, "../../../..");
const migrate = (name: string, target?: string) =>
  execFileSync("docker", ["compose", "run", "--rm", "-e", `FLYWAY_URL=jdbc:postgresql://postgres:5432/${name}`, "flyway", "migrate", "-q", ...(target ? [`-target=${target}`] : [])], { cwd: root, stdio: "pipe" });

test("the run-limits migration keeps the oldest queued or running run of a project, cancels the others with what they still had waiting, and then refuses a second one", async () => {
  const name = `trawler_v19_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await onServer((c) => c.query(`CREATE DATABASE ${name}`));
  const client = new pg.Client({ connectionString: databaseUrl(name) });
  try {
    migrate(name, "18");
    await client.connect();
    await client.query(`
      insert into organization (id, name, slug, "createdAt") values ('o', 'o', 'o', now());
      insert into projects (id, org_id, name, target_url) values ('11111111-1111-4111-8111-111111111111', 'o', 'p', 'https://p.test/'), ('22222222-2222-4222-8222-222222222222', 'o', 'q', 'https://q.test/');
      insert into runs (id, org_id, project_id, number, status, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by, created_at) values
        ('a0000000-0000-4000-8000-000000000001', 'o', '11111111-1111-4111-8111-111111111111', 1, 'running', '{}', 'm', 'm', 1, 10, 10, 'u', now() - interval '3 minutes'),
        ('a0000000-0000-4000-8000-000000000002', 'o', '11111111-1111-4111-8111-111111111111', 2, 'queued', '{}', 'm', 'm', 1, 10, 10, 'u', now() - interval '2 minutes'),
        ('a0000000-0000-4000-8000-000000000003', 'o', '11111111-1111-4111-8111-111111111111', 3, 'succeeded', '{}', 'm', 'm', 1, 10, 10, 'u', now() - interval '1 minute'),
        ('a0000000-0000-4000-8000-000000000004', 'o', '22222222-2222-4222-8222-222222222222', 4, 'queued', '{}', 'm', 'm', 1, 10, 10, 'u', now());
      insert into jobs (org_id, run_id, kind, position, persona_key, status) values
        ('o', 'a0000000-0000-4000-8000-000000000001', 'role_session', 0, 'x', 'leased'),
        ('o', 'a0000000-0000-4000-8000-000000000001', 'role_session', 1, 'y', 'queued'),
        ('o', 'a0000000-0000-4000-8000-000000000002', 'role_session', 0, 'x', 'queued');
    `);
    migrate(name);
    const runs = await client.query("select number, status, cancel_reason from runs order by number");
    expect(runs.rows).toEqual([
      { number: 1, status: "running", cancel_reason: null },
      { number: 2, status: "cancelled", cancel_reason: "stopped" },
      { number: 3, status: "succeeded", cancel_reason: null },
      { number: 4, status: "queued", cancel_reason: null },
    ]);
    const jobs = await client.query("select r.number, j.position, j.status from jobs j join runs r on r.id = j.run_id order by r.number, j.position");
    expect(jobs.rows).toEqual([{ number: 1, position: 0, status: "leased" }, { number: 1, position: 1, status: "queued" }, { number: 2, position: 0, status: "cancelled" }]);
    await expect(client.query("update runs set status = 'queued', cancel_reason = null where number = 2")).rejects.toThrow(/runs_one_active_per_project/);
  } finally {
    await client.end().catch(() => {});
    await onServer((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }
}, 120_000);
