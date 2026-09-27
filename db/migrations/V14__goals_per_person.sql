ALTER TABLE goals ADD COLUMN persona_key text;

WITH ranked AS (
  SELECT project_id, key, row_number() OVER (PARTITION BY project_id ORDER BY position) AS rank
  FROM personas
)
INSERT INTO goals (org_id, project_id, key, instruction, position, persona_key)
SELECT g.org_id, g.project_id,
  CASE
    WHEN length(r.key) <= 29 AND NOT EXISTS (SELECT 1 FROM goals t WHERE t.project_id = g.project_id AND t.key = left(g.key, 30) || '-' || r.key)
      THEN left(g.key, 30) || '-' || r.key
    ELSE left(g.key, 30) || '-' || substr(md5(g.key || '/' || r.key), 1, 12)
  END,
  g.instruction, g.position + 1000 * (r.rank - 1), r.key
FROM goals g
JOIN ranked r ON r.project_id = g.project_id AND r.rank > 1
WHERE g.persona_key IS NULL;

UPDATE goals g SET persona_key = p.key
FROM personas p
WHERE g.persona_key IS NULL AND p.project_id = g.project_id
  AND p.position = (SELECT min(position) FROM personas WHERE project_id = g.project_id);

DELETE FROM goals WHERE persona_key IS NULL;

ALTER TABLE goals ALTER COLUMN persona_key SET NOT NULL;
ALTER TABLE goals ADD FOREIGN KEY (project_id, persona_key) REFERENCES personas (project_id, key) ON UPDATE CASCADE ON DELETE CASCADE;
