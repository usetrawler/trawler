ALTER TABLE mcp_grants ADD COLUMN last_used_at timestamptz;

ALTER TABLE mcp_consent_contexts ADD COLUMN project_id uuid;
ALTER TABLE mcp_consent_contexts ADD FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE;
GRANT UPDATE ON mcp_consent_contexts TO trawler_auth;

CREATE TABLE mcp_code_projects (
  code_hash text PRIMARY KEY,
  project_id uuid NOT NULL,
  org_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, DELETE ON mcp_code_projects TO trawler_auth;
