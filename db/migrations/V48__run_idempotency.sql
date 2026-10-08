CREATE TABLE run_idempotency (
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, key_hash),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CHECK ((run_id IS NULL) = (response IS NULL))
);
CREATE INDEX run_idempotency_expires_idx ON run_idempotency (org_id, expires_at);
CALL make_tenant_table('run_idempotency');
