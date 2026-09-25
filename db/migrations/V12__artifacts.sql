CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  finding_key text,
  kind text NOT NULL CHECK (kind IN ('screenshot')),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id, org_id) REFERENCES jobs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX artifacts_run_idx ON artifacts (run_id);
CREATE INDEX artifacts_job_idx ON artifacts (job_id);
CREATE INDEX artifacts_created_idx ON artifacts (created_at);
CALL make_tenant_table('artifacts');
