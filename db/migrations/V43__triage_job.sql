ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('pr_plan', 'account_check', 'role_session', 'group', 'replay', 'judge', 'triage'));
