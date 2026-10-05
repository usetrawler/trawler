CREATE TABLE pr_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  repo text NOT NULL DEFAULT '',
  number int NOT NULL CHECK (number > 0),
  version int NOT NULL CHECK (version > 0),
  inputs_hash text NOT NULL,
  lead_output jsonb NOT NULL,
  created_by_run_id uuid,
  last_used_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_run_id, org_id) REFERENCES runs (id, org_id) ON DELETE SET NULL (created_by_run_id),
  FOREIGN KEY (last_used_run_id, org_id) REFERENCES runs (id, org_id) ON DELETE SET NULL (last_used_run_id),
  UNIQUE (project_id, plan_id, repo, number, version)
);
CREATE UNIQUE INDEX pr_plans_current ON pr_plans (project_id, plan_id, repo, number) WHERE superseded_at IS NULL;
CREATE INDEX pr_plans_recent ON pr_plans (plan_id, last_used_at DESC) WHERE superseded_at IS NULL;
CALL make_tenant_table('pr_plans');
