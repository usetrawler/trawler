ALTER TABLE runs ADD COLUMN sign_up_seed text;

UPDATE goals g SET position = ordered.position
FROM (
  SELECT g2.id, (row_number() OVER (PARTITION BY g2.project_id ORDER BY p.position, g2.position) - 1)::int AS position
  FROM goals g2 JOIN personas p ON p.project_id = g2.project_id AND p.key = g2.persona_key
) ordered
WHERE ordered.id = g.id;
