-- Apply only after capturing the pre-deletion bookmark on the disposable app D1.
DELETE FROM schedules
WHERE id = '20000000-0000-4000-8000-000000000002'
  AND management_space_id = '10000000-0000-4000-8000-000000000002';

DELETE FROM management_spaces
WHERE id = '10000000-0000-4000-8000-000000000003';
