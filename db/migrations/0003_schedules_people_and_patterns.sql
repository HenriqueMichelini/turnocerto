ALTER TABLE schedules
  ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

CREATE TABLE people (
  id TEXT PRIMARY KEY NOT NULL,
  management_space_id TEXT NOT NULL REFERENCES management_spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX people_management_space_id_idx
  ON people (management_space_id, name, id);

CREATE TABLE participations (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL CHECK (date(start_date) = start_date),
  end_date TEXT CHECK (end_date IS NULL OR (date(end_date) = end_date AND end_date >= start_date)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (schedule_id, person_id, start_date)
);

CREATE INDEX participations_schedule_id_idx
  ON participations (schedule_id, start_date, end_date);

CREATE TABLE weekly_patterns (
  id TEXT PRIMARY KEY NOT NULL,
  participation_id TEXT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL CHECK (date(effective_from) = effective_from),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (participation_id, effective_from)
);

CREATE INDEX weekly_patterns_participation_id_idx
  ON weekly_patterns (participation_id, effective_from);

CREATE TABLE weekly_pattern_days (
  weekly_pattern_id TEXT NOT NULL REFERENCES weekly_patterns(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  state TEXT NOT NULL CHECK (state IN ('undefined', 'day_off', 'work_period')),
  start_time TEXT,
  end_time TEXT,
  break_start_time TEXT,
  break_end_time TEXT,
  PRIMARY KEY (weekly_pattern_id, weekday),
  CHECK (
    (state = 'work_period' AND start_time IS NOT NULL AND end_time IS NOT NULL
      AND ((break_start_time IS NULL AND break_end_time IS NULL)
        OR (break_start_time IS NOT NULL AND break_end_time IS NOT NULL)))
    OR
    (state IN ('undefined', 'day_off') AND start_time IS NULL AND end_time IS NULL
      AND break_start_time IS NULL AND break_end_time IS NULL)
  )
);

CREATE TABLE participation_date_exceptions (
  id TEXT PRIMARY KEY NOT NULL,
  participation_id TEXT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL CHECK (date(exception_date) = exception_date),
  state TEXT NOT NULL CHECK (state IN ('vacation', 'absence', 'medical_leave')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (participation_id, exception_date)
);

CREATE INDEX participation_date_exceptions_participation_date_idx
  ON participation_date_exceptions (participation_id, exception_date);
