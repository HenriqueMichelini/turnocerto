-- Before Time Travel restore, deleted rows and credentials are absent from DB.
-- Every result must be zero except post_bookmark_write, saved_space,
-- saved_management_credential, and saved_read_link, which must each be one.
WITH checks(check_name, row_count) AS (
  VALUES
    ('deleted_schedule', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_credential', (SELECT count(*) FROM read_links
      WHERE token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')),
    ('deleted_space', (SELECT count(*) FROM management_spaces
      WHERE id = '10000000-0000-4000-8000-000000000003')),
    ('deleted_space_credential', (SELECT count(*) FROM management_spaces
      WHERE management_token_hash = '3333333333333333333333333333333333333333333333333333333333333333')),
    ('post_bookmark_write', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000001'
        AND name = 'Recovery drill post-bookmark write')),
    ('saved_space', (SELECT count(*) FROM management_spaces
      WHERE id = '10000000-0000-4000-8000-000000000002')),
    ('saved_management_credential', (SELECT count(*) FROM management_spaces
      WHERE management_token_hash = '2222222222222222222222222222222222222222222222222222222222222222')),
    ('saved_read_link', (SELECT count(*) FROM read_links
      WHERE token_hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'))
)
SELECT check_name, row_count FROM checks ORDER BY check_name;
