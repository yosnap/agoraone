-- What was read from the invoices already in a fiscal folder (so a PDF is read once, until it changes).
CREATE TABLE fiscal_file (
  folder_id INTEGER NOT NULL REFERENCES fiscal_folder(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  fields TEXT NOT NULL,
  PRIMARY KEY (folder_id, path)
) WITHOUT ROWID;
