CREATE TABLE finding_dismissals (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  finding_key text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  dismissed_by text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, finding_key),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, finding_key) REFERENCES findings (run_id, key) ON DELETE CASCADE
);
CALL make_tenant_table('finding_dismissals');
