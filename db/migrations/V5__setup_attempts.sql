CREATE TABLE setup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX setup_attempts_org_idx ON setup_attempts (org_id, created_at DESC);
CALL make_tenant_table('setup_attempts');
