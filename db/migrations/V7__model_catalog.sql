CREATE TABLE model_catalog (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 200),
  label text NOT NULL,
  note text,
  position integer NOT NULL,
  recommended boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  prompt_usd_per_mtok numeric(12, 6) NOT NULL CHECK (prompt_usd_per_mtok >= 0),
  completion_usd_per_mtok numeric(12, 6) NOT NULL CHECK (completion_usd_per_mtok >= 0),
  prices_refreshed_at timestamptz
);
CREATE UNIQUE INDEX model_catalog_one_recommended ON model_catalog (recommended) WHERE recommended;

GRANT SELECT ON model_catalog TO trawler_app;
GRANT SELECT, UPDATE ON model_catalog TO trawler_bypass;

INSERT INTO model_catalog (id, label, note, position, recommended, prompt_usd_per_mtok, completion_usd_per_mtok) VALUES
  ('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'Recommended', 1, true, 0.30, 1.20),
  ('google/gemini-3.5-flash', 'Gemini 3.5 Flash', NULL, 2, false, 1.50, 9.00),
  ('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5', 'Higher quality', 3, false, 1.00, 5.00);
