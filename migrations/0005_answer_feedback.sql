CREATE TABLE IF NOT EXISTS answer_feedback (
  request_id TEXT PRIMARY KEY,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('incorrect', 'missing', 'unclear', 'citation', 'other')),
  comment TEXT,
  question TEXT,
  answer_excerpt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reported_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_answer_feedback_pending
  ON answer_feedback(reported_at, updated_at);
