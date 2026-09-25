CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('openrouter')),
  secret text NOT NULL,
  hint text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind)
);
CALL make_tenant_table('credentials');
