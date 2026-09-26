-- Before Time Travel restore, deleted rows and credentials are absent from DB.
-- Every result must be zero except post_bookmark_write, saved_space,
-- saved_management_credential, and saved_read_link, which must each be one.
SELECT 'deleted_schedule' AS check_name, count(*) AS row_count FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_credential', count(*) FROM read_links
WHERE token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
UNION ALL
SELECT 'deleted_space', count(*) FROM management_spaces
WHERE id = '10000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'deleted_space_credential', count(*) FROM management_spaces
WHERE management_token_hash = '3333333333333333333333333333333333333333333333333333333333333333'
UNION ALL
SELECT 'post_bookmark_write', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000001'
  AND name = 'Recovery drill post-bookmark write'
UNION ALL
SELECT 'saved_space', count(*) FROM management_spaces
WHERE id = '10000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'saved_management_credential', count(*) FROM management_spaces
WHERE management_token_hash = '2222222222222222222222222222222222222222222222222222222222222222'
UNION ALL
SELECT 'saved_read_link', count(*) FROM read_links
WHERE token_hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
ORDER BY check_name;
