ALTER TABLE runs ADD COLUMN client_seen_at timestamptz;
ALTER TABLE runs DROP CONSTRAINT runs_cancel_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_check CHECK (cancel_reason IN ('stopped', 'key_removed', 'account_refused', 'time_limit', 'workspace_budget', 'paused', 'halted', 'stopped_from_ci', 'unclaimed', 'ci_gone'));
