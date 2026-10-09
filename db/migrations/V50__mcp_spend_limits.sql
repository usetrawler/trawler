ALTER TABLE mcp_grants ADD COLUMN max_runs_per_day integer NOT NULL DEFAULT 5 CHECK (max_runs_per_day BETWEEN 1 AND 50);
ALTER TABLE mcp_grants ADD COLUMN max_spend_usd_per_day numeric(10, 2) NOT NULL DEFAULT 20 CHECK (max_spend_usd_per_day > 0 AND max_spend_usd_per_day <= 500);

ALTER TABLE mcp_code_projects ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE mcp_code_projects ADD COLUMN max_runs_per_day integer CHECK (max_runs_per_day BETWEEN 1 AND 50);
ALTER TABLE mcp_code_projects ADD COLUMN max_spend_usd_per_day numeric(10, 2) CHECK (max_spend_usd_per_day > 0 AND max_spend_usd_per_day <= 500);

CREATE OR REPLACE FUNCTION mcp_grants_only_shrink() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a revoked MCP grant stays revoked';
  END IF;
  IF NOT (NEW.scopes <@ OLD.scopes) THEN
    RAISE EXCEPTION 'an MCP grant never gains scopes';
  END IF;
  IF NEW.max_runs_per_day > OLD.max_runs_per_day OR NEW.max_spend_usd_per_day > OLD.max_spend_usd_per_day THEN
    RAISE EXCEPTION 'an MCP grant never gains a higher spend limit';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.org_id <> OLD.org_id OR NEW.client_id <> OLD.client_id OR NEW.code_hash <> OLD.code_hash
     OR NEW.resource <> OLD.resource OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'an MCP grant keeps its person, client, workspace and project';
  END IF;
  RETURN NEW;
END
$$;

CREATE INDEX runs_started_via_grant_idx ON runs ((started_via ->> 'grant'), created_at) WHERE started_via IS NOT NULL;
