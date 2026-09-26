ALTER TABLE runs ADD COLUMN cancel_reason text CHECK (cancel_reason IN ('stopped', 'key_removed'));
ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_only_when_cancelled CHECK (cancel_reason IS NULL OR status = 'cancelled');
