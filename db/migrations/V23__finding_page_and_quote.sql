ALTER TABLE findings ADD COLUMN url text CHECK (char_length(url) <= 4096);
ALTER TABLE findings ADD COLUMN quote text CHECK (char_length(quote) BETWEEN 1 AND 300);
