ALTER TABLE findings ADD COLUMN filed_as text CHECK (filed_as IS NULL OR filed_as = 'friction');
