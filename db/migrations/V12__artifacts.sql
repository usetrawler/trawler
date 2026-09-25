CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  finding_key text,
  kind text NOT NULL CHECK (kind IN ('screenshot')),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz,
  discarded_at timestamptz,
  CHECK (storage_key = 'orgs/' || org_id || '/runs/' || run_id || '/' || id || '.' || CASE content_type WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' END),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id, org_id) REFERENCES jobs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX artifacts_run_idx ON artifacts (run_id);
CREATE INDEX artifacts_job_idx ON artifacts (job_id);
CREATE INDEX artifacts_created_idx ON artifacts (created_at);
CREATE INDEX artifacts_discarded_idx ON artifacts (discarded_at) WHERE discarded_at IS NOT NULL;
CALL make_tenant_table('artifacts');
