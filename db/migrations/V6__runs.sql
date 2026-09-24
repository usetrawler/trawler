CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  project_id uuid NOT NULL,
  number int NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'stopped_budget')),
  config_snapshot jsonb NOT NULL,
  agent_model text NOT NULL CHECK (length(agent_model) BETWEEN 1 AND 200),
  judge_model text NOT NULL CHECK (length(judge_model) BETWEEN 1 AND 200),
  budget_usd numeric(10, 4) NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 1000),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  max_steps int NOT NULL CHECK (max_steps BETWEEN 1 AND 500),
  replay_steps int NOT NULL CHECK (replay_steps BETWEEN 1 AND 200),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id),
  UNIQUE (org_id, number)
);
CREATE INDEX runs_project_idx ON runs (project_id, created_at DESC);
CALL make_tenant_table('runs');

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('role_session', 'replay', 'judge')),
  position int NOT NULL,
  persona_key text,
  finding_key text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  token_hash text,
  lease_until timestamptz,
  counted_cost numeric(12, 6) NOT NULL DEFAULT 0,
  usage jsonb,
  stopped_by text,
  error text CHECK (length(error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  UNIQUE (id, org_id),
  UNIQUE (run_id, position),
  CHECK ((kind = 'role_session') = (persona_key IS NOT NULL)),
  CHECK ((kind = 'role_session') = (finding_key IS NULL))
);
CREATE INDEX jobs_queue_idx ON jobs (created_at) WHERE status = 'queued';
CREATE UNIQUE INDEX jobs_token_idx ON jobs (token_hash) WHERE token_hash IS NOT NULL;
CALL make_tenant_table('jobs');

CREATE TABLE run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  seq int NOT NULL CHECK (seq > 0),
  type text NOT NULL,
  at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (job_id, org_id) REFERENCES jobs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  UNIQUE (job_id, seq)
);
CREATE INDEX run_events_run_idx ON run_events (run_id, id);
CALL make_tenant_table('run_events');

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
  persona_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('defect', 'friction')),
  goal text NOT NULL,
  title text NOT NULL,
  observed text NOT NULL,
  reproduction jsonb NOT NULL,
  severity text NOT NULL,
  replay jsonb,
  verdict text CHECK (verdict IN ('confirmed', 'refuted', 'inconclusive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  UNIQUE (run_id, key)
);
CALL make_tenant_table('findings');

CREATE TABLE goal_outcomes (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  persona_key text NOT NULL,
  goal text NOT NULL,
  status text NOT NULL,
  note text NOT NULL DEFAULT '',
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, persona_key, goal)
);
CALL make_tenant_table('goal_outcomes');
