ALTER TABLE runs ADD COLUMN paid_by text NOT NULL DEFAULT 'workspace' CHECK (paid_by IN ('workspace', 'trawler'));
ALTER TABLE llm_usage ADD COLUMN paid_by text NOT NULL DEFAULT 'workspace' CHECK (paid_by IN ('workspace', 'trawler'));

DROP INDEX llm_usage_org_month_idx;
CREATE INDEX llm_usage_workspace_month_idx ON llm_usage (org_id, created_at) INCLUDE (cost_usd) WHERE paid_by = 'workspace';

CREATE TABLE first_runs_on_us (
  org_id text PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  model_called_at timestamptz,
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id)
);
CALL make_tenant_table('first_runs_on_us');
