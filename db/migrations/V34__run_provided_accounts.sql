ALTER TABLE runs
  ADD COLUMN provided_accounts jsonb NOT NULL DEFAULT '[]';
