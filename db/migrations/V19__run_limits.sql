LOCK TABLE runs IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMPORARY TABLE extra_active_runs ON COMMIT DROP AS
SELECT id FROM (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n
  FROM runs
  WHERE status IN ('queued', 'running')
) ranked
WHERE n > 1;
UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE status = 'queued' AND run_id IN (SELECT id FROM extra_active_runs);
UPDATE runs SET status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = NULL WHERE id IN (SELECT id FROM extra_active_runs);
CREATE UNIQUE INDEX runs_one_active_per_project ON runs (project_id) WHERE status IN ('queued', 'running');

ALTER TABLE runs DROP CONSTRAINT runs_cancel_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_check CHECK (cancel_reason IN ('stopped', 'key_removed', 'account_refused', 'time_limit', 'workspace_budget', 'paused', 'halted'));

ALTER TABLE projects ADD COLUMN paused_at timestamptz;
ALTER TABLE projects ADD COLUMN paused_by text;
ALTER TABLE projects ADD CONSTRAINT projects_paused_by_whom CHECK ((paused_at IS NULL) = (paused_by IS NULL));

CREATE TABLE workspace_budgets (
  org_id text PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  monthly_usd numeric(10, 2) NOT NULL CHECK (monthly_usd >= 1 AND monthly_usd <= 100000),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);
CALL make_tenant_table('workspace_budgets');

CREATE INDEX llm_usage_org_month_idx ON llm_usage (org_id, created_at) INCLUDE (cost_usd);
