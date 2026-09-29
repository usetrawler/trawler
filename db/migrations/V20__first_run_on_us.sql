ALTER TABLE runs ADD COLUMN paid_by text NOT NULL DEFAULT 'workspace' CHECK (paid_by IN ('workspace', 'trawler'));
ALTER TABLE llm_usage ADD COLUMN paid_by text NOT NULL DEFAULT 'workspace' CHECK (paid_by IN ('workspace', 'trawler'));

CREATE TABLE first_runs_on_us (
  org_id text PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE
);
CALL make_tenant_table('first_runs_on_us');
