ALTER TABLE runs ADD COLUMN started_via jsonb;
ALTER TABLE runs ADD COLUMN stopped_via jsonb;
ALTER TABLE runs ADD CONSTRAINT runs_started_via_shape CHECK (started_via IS NULL OR (started_via ->> 'kind' = 'mcp' AND jsonb_typeof(started_via -> 'client') = 'string' AND jsonb_typeof(started_via -> 'person') = 'string'));
ALTER TABLE runs ADD CONSTRAINT runs_stopped_via_shape CHECK (stopped_via IS NULL OR (stopped_via ->> 'kind' = 'mcp' AND jsonb_typeof(stopped_via -> 'client') = 'string' AND jsonb_typeof(stopped_via -> 'person') = 'string'));

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid = 'runs'::regclass AND conname = 'runs_cancel_reason_check';
  ALTER TABLE runs DROP CONSTRAINT runs_cancel_reason_check;
  EXECUTE 'ALTER TABLE runs ADD CONSTRAINT runs_cancel_reason_check ' || replace(definition, '''nothing_to_test''', '''nothing_to_test'', ''stopped_over_mcp''');
END
$$;
