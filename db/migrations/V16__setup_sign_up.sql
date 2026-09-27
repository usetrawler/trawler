ALTER TABLE setup_drafts ADD COLUMN sign_up text CHECK (sign_up IN ('open', 'closed', 'unclear'));
UPDATE personas SET signs_in = true WHERE account_ref IS NOT NULL;
