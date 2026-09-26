CREATE TABLE read_links (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  start_week TEXT NOT NULL CHECK (
    date(start_week) = start_week
    AND ((CAST(strftime('%w', start_week) AS INTEGER) + 6) % 7) = 0
  ),
  week_count INTEGER NOT NULL CHECK (week_count BETWEEN 1 AND 4),
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX read_links_schedule_id_idx
  ON read_links (schedule_id, created_at, id);
