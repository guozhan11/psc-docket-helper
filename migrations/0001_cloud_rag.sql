PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  filing_id INTEGER PRIMARY KEY,
  case_number TEXT NOT NULL,
  docket_number TEXT,
  title TEXT NOT NULL,
  filer TEXT,
  filing_type TEXT,
  received_date TEXT,
  official_pdf_url TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  ocr_page_count INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_case_number
  ON documents(case_number);
CREATE INDEX IF NOT EXISTS idx_documents_received_date
  ON documents(received_date DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filing_id INTEGER NOT NULL REFERENCES documents(filing_id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(filing_id, page_number, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_filing_id
  ON chunks(filing_id);

-- External-content FTS keeps the searchable index synchronized with the
-- canonical chunk table and lets the Worker return the exact source excerpt.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
