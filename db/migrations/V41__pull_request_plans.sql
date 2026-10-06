ALTER TABLE plans
  ADD COLUMN kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'pull_request')),
  ADD COLUMN source_plan_id uuid,
  ADD COLUMN repo text,
  ADD COLUMN pr_number int CHECK (pr_number > 0),
  ADD COLUMN version int CHECK (version > 0),
  ADD COLUMN inputs_hash text,
  ADD COLUMN account_flow text CHECK (account_flow IN ('provided', 'exercise')),
  ADD COLUMN account_reason text,
  ADD COLUMN created_by_run_id uuid,
  ADD COLUMN last_used_at timestamptz,
  ADD FOREIGN KEY (source_plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE,
  ADD FOREIGN KEY (created_by_run_id, org_id) REFERENCES runs (id, org_id) ON DELETE SET NULL (created_by_run_id),
  ADD CONSTRAINT plans_pull_request_fields CHECK (kind = 'standard' OR (source_plan_id IS NOT NULL AND repo IS NOT NULL AND pr_number IS NOT NULL AND version IS NOT NULL AND inputs_hash IS NOT NULL AND account_flow IS NOT NULL AND last_used_at IS NOT NULL));

DROP INDEX plans_project_name;
CREATE UNIQUE INDEX plans_project_name ON plans (project_id, lower(name)) WHERE kind = 'standard';
CREATE UNIQUE INDEX plans_pull_request ON plans (project_id, source_plan_id, repo, pr_number) WHERE kind = 'pull_request';
CREATE INDEX plans_pull_request_recent ON plans (project_id, last_used_at DESC) WHERE kind = 'pull_request';

DROP TABLE pr_plans;

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid = 'runs'::regclass AND conname = 'runs_cancel_reason_check';
  ALTER TABLE runs DROP CONSTRAINT runs_cancel_reason_check;
  EXECUTE 'ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_check ' || replace(definition, '''ci_gone''', '''ci_gone'', ''nothing_to_test''');
END
$$;
