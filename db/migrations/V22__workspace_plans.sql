CREATE TABLE workspace_plans (
  org_id text PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('free', 'team', 'enterprise')),
  extra_projects integer NOT NULL DEFAULT 0 CHECK (extra_projects >= 0 AND extra_projects <= 1000),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_plans USING (org_id = current_org()) WITH CHECK (org_id = current_org());
GRANT SELECT ON workspace_plans TO trawler_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_plans TO trawler_bypass;

ALTER TABLE projects ADD COLUMN demo boolean NOT NULL DEFAULT false;

CREATE INDEX runs_org_created_idx ON runs (org_id, created_at);
