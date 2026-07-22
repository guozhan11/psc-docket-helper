PRAGMA foreign_keys = ON;

ALTER TABLE documents ADD COLUMN term_filter BLOB;

CREATE TABLE IF NOT EXISTS document_cases (
  filing_id INTEGER NOT NULL REFERENCES documents(filing_id) ON DELETE CASCADE,
  case_number TEXT NOT NULL,
  PRIMARY KEY (filing_id, case_number)
);

CREATE INDEX IF NOT EXISTS idx_document_cases_case_number
  ON document_cases(case_number, filing_id);

CREATE TABLE IF NOT EXISTS ingestion_state (
  scope TEXT PRIMARY KEY,
  next_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
