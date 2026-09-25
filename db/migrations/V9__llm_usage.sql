CREATE TABLE llm_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cost_usd numeric(12, 6) NOT NULL CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, org_id) REFERENCES runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id, org_id) REFERENCES jobs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX llm_usage_run_idx ON llm_usage (run_id, id);
CALL make_tenant_table('llm_usage');
