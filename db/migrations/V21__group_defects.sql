ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('account_check', 'role_session', 'group', 'replay', 'judge'));

ALTER TABLE findings ADD COLUMN same_as text;
ALTER TABLE findings ADD CONSTRAINT findings_same_as_another CHECK (same_as IS NULL OR same_as <> key);
ALTER TABLE findings ADD CONSTRAINT findings_same_as_in_run FOREIGN KEY (run_id, same_as) REFERENCES findings (run_id, key) ON DELETE SET NULL (same_as);
