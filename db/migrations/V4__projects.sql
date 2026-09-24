CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  target_url text NOT NULL,
  docs_url text,
  description text NOT NULL DEFAULT '',
  focus text,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX projects_org_idx ON projects (org_id, created_at DESC);
CALL make_tenant_table('projects');

CREATE TABLE personas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z0-9-]+$'),
  name text NOT NULL,
  brief text NOT NULL,
  account_ref text,
  position int NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, key)
);
CALL make_tenant_table('personas');

CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z0-9-]+$'),
  instruction text NOT NULL,
  position int NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, key)
);
CALL make_tenant_table('goals');

CREATE TABLE target_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  ref text NOT NULL,
  username text NOT NULL,
  password_secret text NOT NULL,
  password_hint text NOT NULL,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, ref)
);
CALL make_tenant_table('target_accounts');

CREATE TABLE target_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('basic_auth', 'header', 'secret_header')),
  name text NOT NULL,
  value text,
  secret text,
  secret_hint text,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (project_id, kind, name),
  CHECK ((kind = 'header') = (secret IS NULL))
);
CALL make_tenant_table('target_gates');
