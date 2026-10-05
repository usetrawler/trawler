CREATE TABLE api_token_calls (
  token_id uuid NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  minute bigint NOT NULL,
  calls integer NOT NULL CHECK (calls > 0),
  PRIMARY KEY (token_id, minute)
);
CALL make_tenant_table('api_token_calls');
