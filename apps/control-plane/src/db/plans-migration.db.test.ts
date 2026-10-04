import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { expect, test } from "vitest";
import { databaseUrl, onServer } from "./test-db.ts";

const root = join(import.meta.dirname, "../../../..");
const migrate = (name: string, target?: string) =>
  execFileSync("docker", ["compose", "run", "--rm", "-e", `FLYWAY_URL=jdbc:postgresql://postgres:5432/${name}`, "flyway", "migrate", "-q", ...(target ? [`-target=${target}`] : [])], { cwd: root, stdio: "pipe" });

test("the plans migration gives each project one plan, named from its focus or Main plan, and moves its people, goals, accounts, gates and runs into it", async () => {
  const name = `trawler_v29_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await onServer((c) => c.query(`CREATE DATABASE ${name}`));
  const client = new pg.Client({ connectionString: databaseUrl(name) });
  const [focused, plain] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  try {
    migrate(name, "28");
    await client.connect();
    await client.query(`
      insert into organization (id, name, slug, "createdAt") values ('o', 'o', 'o', now());
      insert into projects (id, org_id, name, target_url, focus) values ('${focused}', 'o', 'p', 'https://p.test/', '  Team invitation flow  '), ('${plain}', 'o', 'q', 'https://q.test/', null);
      insert into target_accounts (org_id, project_id, ref, username, password_secret, password_hint, position) values ('o', '${focused}', 'ana', 'ana@p.test', 'v1:x', '1234', 0), ('o', '${plain}', 'ana', 'ana@q.test', 'v1:y', '5678', 0);
      insert into personas (org_id, project_id, key, name, brief, account_ref, position) values ('o', '${focused}', 'ana', 'Ana', 'b', 'ana', 0), ('o', '${plain}', 'ana', 'Ana', 'b', 'ana', 0);
      insert into goals (org_id, project_id, key, instruction, position, persona_key) values ('o', '${focused}', 'g', 'Do it.', 0, 'ana'), ('o', '${plain}', 'g', 'Do it.', 0, 'ana');
      insert into target_gates (org_id, project_id, kind, name, value, position) values ('o', '${focused}', 'header', 'x-env', 'stg', 0);
      insert into runs (org_id, project_id, number, status, config_snapshot, agent_model, judge_model, budget_usd, max_steps, replay_steps, created_by) values
        ('o', '${focused}', 1, 'succeeded', '{}', 'm', 'm', 1, 10, 10, 'u'), ('o', '${plain}', 2, 'succeeded', '{}', 'm', 'm', 1, 10, 10, 'u');
    `);
    migrate(name);
    const plans = await client.query("select project_id, name, position from plans order by name");
    expect(plans.rows).toEqual([{ project_id: plain, name: "Main plan", position: 0 }, { project_id: focused, name: "Team invitation flow", position: 0 }]);
    for (const table of ["personas", "goals", "target_accounts", "target_gates"]) {
      const orphans = await client.query(`select count(*)::int as n from ${table} t left join plans p on p.id = t.plan_id and p.project_id = t.project_id where p.id is null`);
      expect(orphans.rows[0].n, table).toBe(0);
    }
    const runs = await client.query("select r.number, r.plan_name, p.name as plan from runs r join plans p on p.id = r.plan_id order by r.number");
    expect(runs.rows).toEqual([{ number: 1, plan_name: "Team invitation flow", plan: "Team invitation flow" }, { number: 2, plan_name: "Main plan", plan: "Main plan" }]);
    await expect(client.query(`insert into personas (org_id, project_id, plan_id, key, name, brief, position) select org_id, project_id, plan_id, key, name, brief, 5 from personas where project_id = '${focused}'`)).rejects.toThrow(/duplicate key|unique/);
  } finally {
    await client.end().catch(() => {});
    await onServer((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }
}, 120_000);
