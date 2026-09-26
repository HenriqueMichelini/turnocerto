CREATE TABLE deletion_records (
  scope TEXT NOT NULL CHECK (scope IN ('schedule', 'management_space')),
  space_id TEXT NOT NULL CHECK (length(space_id) = 36),
  schedule_id TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope, space_id, schedule_id),
  CHECK (
    (scope = 'schedule' AND length(schedule_id) = 36)
    OR (scope = 'management_space' AND schedule_id = '')
  )
);

CREATE INDEX deletion_records_requested_at_idx
  ON deletion_records (requested_at, scope);
