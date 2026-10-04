ALTER TABLE plans ADD COLUMN features text[] NOT NULL DEFAULT '{}' CHECK (cardinality(features) <= 10);
UPDATE plans p SET features = pr.features FROM projects pr WHERE pr.id = p.project_id;
UPDATE plans SET name = 'Plan 1' WHERE name = 'Main plan';
UPDATE runs SET plan_name = 'Plan 1' WHERE plan_name = 'Main plan';

ALTER TABLE setup_drafts ADD COLUMN plan_id uuid;
ALTER TABLE setup_drafts ADD COLUMN new_plan_name text CHECK (length(new_plan_name) BETWEEN 1 AND 100);
ALTER TABLE setup_drafts ADD COLUMN result_plan_id uuid;
ALTER TABLE setup_drafts ADD FOREIGN KEY (plan_id, project_id, org_id) REFERENCES plans (id, project_id, org_id) ON DELETE CASCADE;
