-- Apply after the recorded restore bookmark. This synthetic saved edit is
-- expected to be absent after restore, providing a measurable loss marker.
UPDATE schedules
SET name = 'Recovery drill post-bookmark write',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '20000000-0000-4000-8000-000000000001';
