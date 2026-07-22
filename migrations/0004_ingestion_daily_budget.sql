CREATE TABLE IF NOT EXISTS ingestion_daily_budget (
  budget_day TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0,
  r2_objects_written INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- The initial compact-index migration already exceeded today's free write
-- allowance. Seeding this day prevents the backfill from adding more writes;
-- subsequent UTC days start with a fresh row automatically.
INSERT OR IGNORE INTO ingestion_daily_budget (
  budget_day, rows_written, r2_objects_written, updated_at
) VALUES ('2026-07-22', 80000, 0, '2026-07-22T19:30:00Z');
