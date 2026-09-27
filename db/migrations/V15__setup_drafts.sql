CREATE TABLE setup_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  project_id uuid,
  url text NOT NULL CHECK (length(url) <= 2048),
  docs_url text CHECK (length(docs_url) <= 2048),
  page text NOT NULL,
  docs text,
  origins text[] NOT NULL DEFAULT '{}',
  name text CHECK (length(name) <= 100),
  description text CHECK (length(description) <= 2000),
  features jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX setup_drafts_org_idx ON setup_drafts (org_id, created_at);
CALL make_tenant_table('setup_drafts');

ALTER TABLE projects ADD COLUMN features text[] NOT NULL DEFAULT '{}' CHECK (cardinality(features) <= 10);
ALTER TABLE personas ADD COLUMN signs_in boolean NOT NULL DEFAULT false;
