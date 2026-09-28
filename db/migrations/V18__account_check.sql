ALTER TABLE jobs ADD COLUMN account_ref text;
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('account_check', 'role_session', 'replay', 'judge'));
ALTER TABLE jobs DROP CONSTRAINT jobs_check1;
ALTER TABLE jobs ADD CONSTRAINT jobs_finding_only_for_replay_and_judge CHECK ((kind IN ('replay', 'judge')) = (finding_key IS NOT NULL));
ALTER TABLE jobs ADD CONSTRAINT jobs_account_only_for_account_check CHECK ((kind = 'account_check') = (account_ref IS NOT NULL));

ALTER TABLE runs DROP CONSTRAINT runs_cancel_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_check CHECK (cancel_reason IN ('stopped', 'key_removed', 'account_refused'));
