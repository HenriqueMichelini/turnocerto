-- After restore, deleted targets/hashes and the saved baseline each return once;
-- retained data stays present and the post-bookmark edit returns zero.
WITH checks(check_name, row_count) AS (
  VALUES
    ('restored_deleted_schedule', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000002')),
    ('restored_deleted_schedule_credential', (SELECT count(*) FROM read_links
      WHERE token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')),
    ('restored_deleted_space', (SELECT count(*) FROM management_spaces
      WHERE id = '10000000-0000-4000-8000-000000000003')),
    ('restored_deleted_space_credential', (SELECT count(*) FROM management_spaces
      WHERE management_token_hash = '3333333333333333333333333333333333333333333333333333333333333333')),
    ('retained_schedule', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000003')),
    ('retained_space_management_credential', (SELECT count(*) FROM management_spaces
      WHERE management_token_hash = '2222222222222222222222222222222222222222222222222222222222222222')),
    ('restored_saved_baseline', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000001'
        AND name = 'Recovery drill saved Schedule')),
    ('post_bookmark_write_absent', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000001'
        AND name = 'Recovery drill post-bookmark write'))
)
SELECT check_name, row_count FROM checks ORDER BY check_name;
