ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('openrouter', 'openai', 'anthropic', 'google', 'custom'));
ALTER TABLE credentials ADD COLUMN base_url text CHECK (base_url IS NULL OR base_url ~ '^https://');
ALTER TABLE credentials ADD CONSTRAINT credentials_custom_has_url CHECK ((kind = 'custom') = (base_url IS NOT NULL));
ALTER TABLE credentials DROP CONSTRAINT credentials_org_id_kind_key;
ALTER TABLE credentials ADD CONSTRAINT credentials_one_per_org UNIQUE (org_id);

ALTER TABLE runs ADD COLUMN provider text NOT NULL DEFAULT 'openrouter' CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'google', 'custom'));
ALTER TABLE runs ADD COLUMN token_cap bigint CHECK (token_cap IS NULL OR token_cap > 0);
ALTER TABLE runs ADD COLUMN tokens_used bigint NOT NULL DEFAULT 0;
