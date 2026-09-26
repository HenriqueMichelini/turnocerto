-- After restore, deleted targets/hashes and the saved baseline each return once;
-- retained data stays present and the post-bookmark edit returns zero.
SELECT 'restored_deleted_schedule' AS check_name, count(*) AS row_count FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'restored_deleted_schedule_credential', count(*) FROM read_links
WHERE token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
UNION ALL
SELECT 'restored_deleted_space', count(*) FROM management_spaces
WHERE id = '10000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'restored_deleted_space_credential', count(*) FROM management_spaces
WHERE management_token_hash = '3333333333333333333333333333333333333333333333333333333333333333'
UNION ALL
SELECT 'retained_schedule', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'retained_space_management_credential', count(*) FROM management_spaces
WHERE management_token_hash = '2222222222222222222222222222222222222222222222222222222222222222'
UNION ALL
SELECT 'restored_saved_baseline', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000001'
  AND name = 'Recovery drill saved Schedule'
UNION ALL
SELECT 'post_bookmark_write_absent', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000001'
  AND name = 'Recovery drill post-bookmark write'
ORDER BY check_name;
