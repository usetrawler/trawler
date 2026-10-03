ALTER TABLE finding_dismissals ADD COLUMN matched_run_id uuid;
ALTER TABLE finding_dismissals ADD COLUMN matched_finding_key text;
ALTER TABLE finding_dismissals ADD CONSTRAINT finding_dismissals_matched_both CHECK ((matched_run_id IS NULL) = (matched_finding_key IS NULL));
ALTER TABLE finding_dismissals ADD CONSTRAINT finding_dismissals_matched_mark FOREIGN KEY (matched_run_id, matched_finding_key) REFERENCES finding_dismissals (run_id, finding_key) ON DELETE SET NULL;
