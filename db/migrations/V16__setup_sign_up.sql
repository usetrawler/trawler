ALTER TABLE setup_drafts ADD COLUMN sign_up text CHECK (sign_up IN ('open', 'closed', 'unclear'));
