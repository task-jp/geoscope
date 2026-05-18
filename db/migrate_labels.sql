-- migrate_labels.sql
-- 旧形式: labels = ["#前方後円墳", "#!城跡", ...]
-- 新形式: labels = [{"name": "前方後円墳", "emoji": "⛩", "vote": "yes"}, {"name": "城跡", "emoji": "🏯", "vote": "no"}, ...]
--
-- デフォルト絵文字マッピング:
--   前方後円墳 → ⛩
--   古墳 → 🪨
--   城跡 → 🏯
--   城址跡 → 🏯
--   その他 → 📍

UPDATE annotations
SET labels = (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'name',
            CASE
                WHEN elem_text LIKE '#!%' THEN substring(elem_text FROM 3)
                WHEN elem_text LIKE '#%'  THEN substring(elem_text FROM 2)
                ELSE elem_text
            END,
            'emoji',
            CASE
                WHEN replace(replace(elem_text, '#!', ''), '#', '') = '前方後円墳' THEN '⛩'
                WHEN replace(replace(elem_text, '#!', ''), '#', '') = '古墳'       THEN '🪨'
                WHEN replace(replace(elem_text, '#!', ''), '#', '') = '城跡'       THEN '🏯'
                WHEN replace(replace(elem_text, '#!', ''), '#', '') = '城址跡'     THEN '🏯'
                ELSE '📍'
            END,
            'vote',
            CASE
                WHEN elem_text LIKE '#!%' THEN 'no'
                ELSE 'yes'
            END
        )
    ), '[]'::jsonb)
    FROM jsonb_array_elements_text(annotations.labels) AS elem_text
)
WHERE jsonb_typeof(labels) = 'array'
  AND jsonb_array_length(labels) > 0
  AND jsonb_typeof(labels->0) = 'string';
