-- 003 · Reference data. Idempotent: safe to re-run, never duplicates rows.

INSERT INTO user_types (type_name) VALUES
  ('admin'), ('diver'), ('researcher'), ('citizen')
ON CONFLICT (type_name) DO NOTHING;

-- The 22 classes of runs/sagarnetra_5k_finetune-3/weights/best.pt, in model index order.
-- Must stay identical to inference/classes.json (enforced by the test suite and at
-- inference time by the backend).
INSERT INTO debris_types (type_name, class_index, category) VALUES
  ('rov',                     0, 'rov'),
  ('plant',                   1, 'plant'),
  ('animal_fish',             2, 'animal'),
  ('animal_starfish',         3, 'animal'),
  ('animal_shells',           4, 'animal'),
  ('animal_crab',             5, 'animal'),
  ('animal_eel',              6, 'animal'),
  ('animal_etc',              7, 'animal'),
  ('trash_clothing',          8, 'trash'),
  ('trash_pipe',              9, 'trash'),
  ('trash_bottle',           10, 'trash'),
  ('trash_bag',              11, 'trash'),
  ('trash_snack_wrapper',    12, 'trash'),
  ('trash_can',              13, 'trash'),
  ('trash_cup',              14, 'trash'),
  ('trash_container',        15, 'trash'),
  ('trash_unknown_instance', 16, 'trash'),
  ('trash_branch',           17, 'trash'),
  ('trash_wreckage',         18, 'trash'),
  ('trash_tarp',             19, 'trash'),
  ('trash_rope',             20, 'trash'),
  ('trash_net',              21, 'trash')
ON CONFLICT (type_name) DO UPDATE
  SET class_index = EXCLUDED.class_index,
      category    = EXCLUDED.category;

ALTER TABLE debris_types ALTER COLUMN class_index SET NOT NULL;
ALTER TABLE debris_types ALTER COLUMN category SET NOT NULL;
