CREATE TABLE workspace_mcp_settings (
  org_id text PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  connections_allowed boolean NOT NULL DEFAULT true,
  run_control_allowed boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CALL make_tenant_table('workspace_mcp_settings');
CREATE POLICY workspace_mcp_settings_auth ON workspace_mcp_settings FOR SELECT TO trawler_auth USING (true);
GRANT SELECT ON workspace_mcp_settings TO trawler_auth;

GRANT UPDATE (revoked_at, scopes) ON mcp_grants TO trawler_app;
