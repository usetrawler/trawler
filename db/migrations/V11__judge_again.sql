ALTER TABLE jobs ADD COLUMN requested_by text;
ALTER TABLE jobs ADD CONSTRAINT jobs_requested_only_for_judges CHECK (requested_by IS NULL OR kind = 'judge');
