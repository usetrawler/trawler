ALTER TABLE runs DROP CONSTRAINT runs_cancel_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_check CHECK (cancel_reason IN ('stopped', 'key_removed', 'account_refused', 'time_limit', 'workspace_budget', 'paused', 'halted', 'stopped_from_ci', 'unclaimed', 'ci_gone', 'superseded'));

ALTER TABLE runs ADD COLUMN target_override boolean NOT NULL DEFAULT false;

DROP INDEX runs_one_active_per_project;
CREATE UNIQUE INDEX runs_one_active_per_project ON runs (project_id) WHERE status IN ('queued', 'running') AND NOT target_override;
