ALTER TABLE runs
  ADD COLUMN conversation boolean NOT NULL DEFAULT false;

ALTER TABLE jobs
  ADD COLUMN together boolean NOT NULL DEFAULT false;

DROP INDEX jobs_one_leased_per_run;
CREATE UNIQUE INDEX jobs_one_leased_per_run ON jobs (run_id) WHERE status = 'leased' AND NOT together;
