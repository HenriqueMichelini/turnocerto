CREATE TABLE schedule_revisions (
  schedule_id TEXT PRIMARY KEY NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  revision TEXT NOT NULL
);

INSERT INTO schedule_revisions (schedule_id, revision)
SELECT id, lower(hex(randomblob(16)))
FROM schedules;

ALTER TABLE participation_date_exceptions RENAME TO participation_date_exceptions_legacy;

CREATE TABLE participation_date_exceptions (
  id TEXT PRIMARY KEY NOT NULL,
  participation_id TEXT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL CHECK (date(exception_date) = exception_date),
  state TEXT NOT NULL CHECK (state IN ('undefined', 'day_off', 'work_period', 'vacation', 'absence', 'medical_leave')),
  start_time TEXT,
  end_time TEXT,
  break_start_time TEXT,
  break_end_time TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (participation_id, exception_date),
  CHECK (
    (state = 'work_period' AND start_time IS NOT NULL AND end_time IS NOT NULL
      AND ((break_start_time IS NULL AND break_end_time IS NULL)
        OR (break_start_time IS NOT NULL AND break_end_time IS NOT NULL)))
    OR
    (state <> 'work_period' AND start_time IS NULL AND end_time IS NULL
      AND break_start_time IS NULL AND break_end_time IS NULL)
  )
);

INSERT INTO participation_date_exceptions (id, participation_id, exception_date, state, created_at)
SELECT id, participation_id, exception_date, state, created_at
FROM participation_date_exceptions_legacy;

DROP TABLE participation_date_exceptions_legacy;

CREATE INDEX participation_date_exceptions_participation_date_idx
  ON participation_date_exceptions (participation_id, exception_date);
