CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  target_url text NOT NULL CHECK (length(target_url) <= 2048),
  docs_url text CHECK (length(docs_url) <= 2048),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  focus text CHECK (length(focus) <= 500),
  allowed_origins text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_origins) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX projects_org_idx ON projects (org_id, created_at DESC, id);
CALL make_tenant_table('projects');

CREATE TABLE target_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  ref text NOT NULL CHECK (length(ref) BETWEEN 1 AND 100),
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 320),
  password_secret text NOT NULL,
  password_hint text NOT NULL,
  position int NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, ref)
);
CALL make_tenant_table('target_accounts');

CREATE TABLE personas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z0-9-]{1,60}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  brief text NOT NULL CHECK (length(brief) BETWEEN 1 AND 2000),
  account_ref text,
  position int NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, account_ref) REFERENCES target_accounts (project_id, ref) ON UPDATE CASCADE,
  UNIQUE (project_id, key)
);
CALL make_tenant_table('personas');

CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z0-9-]{1,60}$'),
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 1000),
  position int NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, key)
);
CALL make_tenant_table('goals');

CREATE TABLE target_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('basic_auth', 'header', 'secret_header')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 320),
  value text CHECK (length(value) <= 4000),
  secret text,
  secret_hint text,
  position int NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, kind, name),
  CHECK ((kind = 'header') = (value IS NOT NULL)),
  CHECK ((kind = 'header') = (secret IS NULL)),
  CHECK ((secret IS NULL) = (secret_hint IS NULL))
);
CREATE UNIQUE INDEX target_gates_one_basic_auth ON target_gates (project_id) WHERE kind = 'basic_auth';
CREATE UNIQUE INDEX target_gates_header_name ON target_gates (project_id, lower(name)) WHERE kind IN ('header', 'secret_header');
CALL make_tenant_table('target_gates');
