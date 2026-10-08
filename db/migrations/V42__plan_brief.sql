ALTER TABLE plans ADD COLUMN brief text CHECK (brief IS NULL OR length(brief) <= 1200);
