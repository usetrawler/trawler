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

CREATE FUNCTION mcp_grants_only_shrink() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a revoked MCP grant stays revoked';
  END IF;
  IF NOT (NEW.scopes <@ OLD.scopes) THEN
    RAISE EXCEPTION 'an MCP grant never gains scopes';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.org_id <> OLD.org_id OR NEW.client_id <> OLD.client_id OR NEW.code_hash <> OLD.code_hash
     OR NEW.resource <> OLD.resource OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'an MCP grant keeps its person, client, workspace and project';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mcp_grants_only_shrink BEFORE UPDATE ON mcp_grants FOR EACH ROW EXECUTE FUNCTION mcp_grants_only_shrink();
