DO $$
DECLARE
  login text := '${appLogin}';
  secret text := '${appLoginPassword}';
BEGIN
  IF login = '' OR secret = '' THEN
    RETURN;
  END IF;
  IF login !~ '^[a-z_][a-z0-9_]{0,62}$' OR login LIKE 'pg\_%' THEN
    RAISE EXCEPTION 'not a plain role name: %', login;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = login) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', login, secret);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', login, secret);
  END IF;
  EXECUTE format('GRANT trawler_app, trawler_bypass, trawler_auth TO %I WITH INHERIT FALSE, SET TRUE', login);
  IF pg_has_role(login, 'trawler_app', 'USAGE') OR pg_has_role(login, 'trawler_bypass', 'USAGE') OR pg_has_role(login, 'trawler_auth', 'USAGE') THEN
    RAISE EXCEPTION 'role % inherits the tenancy roles through another grant', login;
  END IF;
  IF EXISTS (SELECT FROM pg_class WHERE relrowsecurity AND pg_has_role(login, relowner, 'USAGE')) THEN
    RAISE EXCEPTION 'role % owns a table under row-level security', login;
  END IF;
END
$$;
