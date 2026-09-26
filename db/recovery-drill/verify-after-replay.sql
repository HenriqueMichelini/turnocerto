-- Every result must be zero except saved_space, saved_management_credential,
-- saved_schedule, saved_pre_restore_state, saved_person, saved_pattern, and
-- saved_read_link, which must each be one.
SELECT 'deleted_schedule' AS check_name, count(*) AS row_count FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_revision', count(*) FROM schedule_revisions
WHERE schedule_id = '20000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_participation', count(*) FROM participations
WHERE schedule_id = '20000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_pattern', count(*) FROM weekly_patterns
WHERE id = '50000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_pattern_day', count(*) FROM weekly_pattern_days
WHERE weekly_pattern_id = '50000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_exception', count(*) FROM participation_date_exceptions
WHERE id = '60000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'deleted_schedule_read_link', count(*) FROM read_links
WHERE token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
UNION ALL
SELECT 'deleted_space', count(*) FROM management_spaces
WHERE id = '10000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'deleted_space_management_credential', count(*) FROM management_spaces
WHERE management_token_hash = '3333333333333333333333333333333333333333333333333333333333333333'
UNION ALL
SELECT 'deleted_space_schedule', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000004'
UNION ALL
SELECT 'deleted_space_revision', count(*) FROM schedule_revisions
WHERE schedule_id = '20000000-0000-4000-8000-000000000004'
UNION ALL
SELECT 'deleted_space_person', count(*) FROM people
WHERE id = '30000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'deleted_space_participation', count(*) FROM participations
WHERE id = '40000000-0000-4000-8000-000000000004'
UNION ALL
SELECT 'deleted_space_pattern', count(*) FROM weekly_patterns
WHERE id = '50000000-0000-4000-8000-000000000004'
UNION ALL
SELECT 'deleted_space_pattern_day', count(*) FROM weekly_pattern_days
WHERE weekly_pattern_id = '50000000-0000-4000-8000-000000000004'
UNION ALL
SELECT 'deleted_space_exception', count(*) FROM participation_date_exceptions
WHERE id = '60000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'deleted_space_read_link', count(*) FROM read_links
WHERE token_hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
UNION ALL
SELECT 'saved_space', count(*) FROM management_spaces
WHERE id = '10000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'saved_management_credential', count(*) FROM management_spaces
WHERE management_token_hash = '2222222222222222222222222222222222222222222222222222222222222222'
UNION ALL
SELECT 'saved_schedule', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'saved_pre_restore_state', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000001'
  AND name = 'Recovery drill saved Schedule'
UNION ALL
SELECT 'post_bookmark_write_absent', count(*) FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000001'
  AND name = 'Recovery drill post-bookmark write'
UNION ALL
SELECT 'saved_person', count(*) FROM people
WHERE id = '30000000-0000-4000-8000-000000000002'
UNION ALL
SELECT 'saved_pattern', count(*) FROM weekly_patterns
WHERE id = '50000000-0000-4000-8000-000000000003'
UNION ALL
SELECT 'saved_read_link', count(*) FROM read_links
WHERE token_hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
ORDER BY check_name;
