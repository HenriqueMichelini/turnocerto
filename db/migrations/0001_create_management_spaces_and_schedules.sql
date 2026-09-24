CREATE TABLE management_spaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY NOT NULL,
  management_space_id TEXT NOT NULL REFERENCES management_spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX schedules_management_space_id_idx
  ON schedules (management_space_id);
