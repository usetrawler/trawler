ALTER TABLE runs
  ADD COLUMN execution text NOT NULL DEFAULT 'hosted' CHECK (execution IN ('hosted', 'own')),
  ADD COLUMN pull_request jsonb;
