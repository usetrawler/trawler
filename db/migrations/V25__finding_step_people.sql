ALTER TABLE findings ADD COLUMN step_people jsonb CHECK (step_people IS NULL OR jsonb_typeof(step_people) = 'array');
