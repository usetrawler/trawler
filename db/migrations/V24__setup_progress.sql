ALTER TABLE setup_drafts ADD COLUMN proposing_at timestamptz;
ALTER TABLE setup_drafts ADD COLUMN result_project_id uuid;
ALTER TABLE setup_drafts ADD COLUMN describe_failed_at timestamptz;
ALTER TABLE setup_drafts ADD CONSTRAINT setup_drafts_result_project_fk FOREIGN KEY (result_project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE;
