-- Every result must be zero except saved_space, saved_management_credential,
-- saved_schedule, saved_pre_restore_state, saved_person, saved_pattern, and
-- saved_read_link, which must each be one.
WITH checks(check_name, row_count) AS (
  VALUES
    ('deleted_schedule', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_revision', (SELECT count(*) FROM schedule_revisions
      WHERE schedule_id = '20000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_participation', (SELECT count(*) FROM participations
      WHERE schedule_id = '20000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_pattern', (SELECT count(*) FROM weekly_patterns
      WHERE id = '50000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_pattern_day', (SELECT count(*) FROM weekly_pattern_days
      WHERE weekly_pattern_id = '50000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_exception', (SELECT count(*) FROM participation_date_exceptions
      WHERE id = '60000000-0000-4000-8000-000000000002')),
    ('deleted_schedule_read_link', (SELECT count(*) FROM read_links
      WHERE token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')),
    ('deleted_space', (SELECT count(*) FROM management_spaces
      WHERE id = '10000000-0000-4000-8000-000000000003')),
    ('deleted_space_management_credential', (SELECT count(*) FROM management_spaces
      WHERE management_token_hash = '3333333333333333333333333333333333333333333333333333333333333333')),
    ('deleted_space_schedule', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000004')),
    ('deleted_space_revision', (SELECT count(*) FROM schedule_revisions
      WHERE schedule_id = '20000000-0000-4000-8000-000000000004')),
    ('deleted_space_person', (SELECT count(*) FROM people
      WHERE id = '30000000-0000-4000-8000-000000000003')),
    ('deleted_space_participation', (SELECT count(*) FROM participations
      WHERE id = '40000000-0000-4000-8000-000000000004')),
    ('deleted_space_pattern', (SELECT count(*) FROM weekly_patterns
      WHERE id = '50000000-0000-4000-8000-000000000004')),
    ('deleted_space_pattern_day', (SELECT count(*) FROM weekly_pattern_days
      WHERE weekly_pattern_id = '50000000-0000-4000-8000-000000000004')),
    ('deleted_space_exception', (SELECT count(*) FROM participation_date_exceptions
      WHERE id = '60000000-0000-4000-8000-000000000003')),
    ('deleted_space_read_link', (SELECT count(*) FROM read_links
      WHERE token_hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')),
    ('saved_space', (SELECT count(*) FROM management_spaces
      WHERE id = '10000000-0000-4000-8000-000000000002')),
    ('saved_management_credential', (SELECT count(*) FROM management_spaces
      WHERE management_token_hash = '2222222222222222222222222222222222222222222222222222222222222222')),
    ('saved_schedule', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000003')),
    ('saved_pre_restore_state', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000001'
        AND name = 'Recovery drill saved Schedule')),
    ('post_bookmark_write_absent', (SELECT count(*) FROM schedules
      WHERE id = '20000000-0000-4000-8000-000000000001'
        AND name = 'Recovery drill post-bookmark write')),
    ('saved_person', (SELECT count(*) FROM people
      WHERE id = '30000000-0000-4000-8000-000000000002')),
    ('saved_pattern', (SELECT count(*) FROM weekly_patterns
      WHERE id = '50000000-0000-4000-8000-000000000003')),
    ('saved_read_link', (SELECT count(*) FROM read_links
      WHERE token_hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'))
)
SELECT check_name, row_count FROM checks ORDER BY check_name;
