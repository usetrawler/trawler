CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (id, project_id, org_id)
);
CREATE UNIQUE INDEX plans_project_name ON plans (project_id, lower(name));
CALL make_tenant_table('plans');

INSERT INTO plans (org_id, project_id, name, created_at)
SELECT org_id, id, coalesce(nullif(left(btrim(focus), 100), ''), 'Main plan'), created_at FROM projects;

ALTER TABLE target_accounts ADD COLUMN plan_id uuid;
ALTER TABLE personas ADD COLUMN plan_id uuid;
ALTER TABLE goals ADD COLUMN plan_id uuid;
ALTER TABLE target_gates ADD COLUMN plan_id uuid;
UPDATE target_accounts t SET plan_id = p.id FROM plans p WHERE p.project_id = t.project_id;
UPDATE personas t SET plan_id = p.id FROM plans p WHERE p.project_id = t.project_id;
UPDATE goals t SET plan_id = p.id FROM plans p WHERE p.project_id = t.project_id;
UPDATE target_gates t SET plan_id = p.id FROM plans p WHERE p.project_id = t.project_id;
ALTER TABLE target_accounts ALTER COLUMN plan_id SET NOT NULL;
ALTER TABLE personas ALTER COLUMN plan_id SET NOT NULL;
ALTER TABLE goals ALTER COLUMN plan_id SET NOT NULL;
ALTER TABLE target_gates ALTER COLUMN plan_id SET NOT NULL;

ALTER TABLE goals DROP CONSTRAINT goals_project_id_persona_key_fkey;
ALTER TABLE personas DROP CONSTRAINT personas_project_id_account_ref_fkey;
ALTER TABLE goals DROP CONSTRAINT goals_project_id_key_key;
ALTER TABLE personas DROP CONSTRAINT personas_project_id_key_key;
ALTER TABLE target_accounts DROP CONSTRAINT target_accounts_project_id_ref_key;
ALTER TABLE target_gates DROP CONSTRAINT target_gates_project_id_kind_name_key;
DROP INDEX target_gates_one_basic_auth;
DROP INDEX target_gates_header_name;

ALTER TABLE target_accounts ADD FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE;
ALTER TABLE personas ADD FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE;
ALTER TABLE goals ADD FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE;
ALTER TABLE target_gates ADD FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE;

ALTER TABLE target_accounts ADD UNIQUE (plan_id, ref);
ALTER TABLE personas ADD UNIQUE (plan_id, key);
ALTER TABLE goals ADD UNIQUE (plan_id, key);
ALTER TABLE target_gates ADD UNIQUE (plan_id, kind, name);
CREATE UNIQUE INDEX target_gates_one_basic_auth ON target_gates (plan_id) WHERE kind = 'basic_auth';
CREATE UNIQUE INDEX target_gates_header_name ON target_gates (plan_id, lower(name)) WHERE kind IN ('header', 'secret_header');

ALTER TABLE personas ADD FOREIGN KEY (plan_id, account_ref) REFERENCES target_accounts (plan_id, ref) ON UPDATE CASCADE;
ALTER TABLE goals ADD FOREIGN KEY (plan_id, persona_key) REFERENCES personas (plan_id, key) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE runs ADD COLUMN plan_id uuid;
ALTER TABLE runs ADD COLUMN plan_name text;
UPDATE runs r SET plan_id = p.id, plan_name = p.name FROM plans p WHERE p.project_id = r.project_id;
ALTER TABLE runs ALTER COLUMN plan_name SET NOT NULL;
ALTER TABLE runs ADD CHECK (length(plan_name) BETWEEN 1 AND 100);
ALTER TABLE runs ADD FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE SET NULL (plan_id);
CREATE INDEX runs_plan_idx ON runs (plan_id, created_at DESC);
