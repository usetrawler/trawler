ALTER TABLE goal_outcomes ADD COLUMN blocked_by text CHECK (blocked_by IN ('product', 'setup', 'person'));
