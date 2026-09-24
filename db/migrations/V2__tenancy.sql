DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trawler_app') THEN
    CREATE ROLE trawler_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trawler_bypass') THEN
    CREATE ROLE trawler_bypass NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO trawler_app, trawler_bypass;

CREATE FUNCTION current_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '') $$;

CREATE PROCEDURE make_tenant_table(target regclass)
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (org_id = current_org()) WITH CHECK (org_id = current_org())', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO trawler_app, trawler_bypass', target);
END
$$;
