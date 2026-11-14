-- Data typed by the user for an invoice of a fiscal folder that cannot be read in any way (unreadable, or a
-- picture the model could not read). Valid only while the file stays the same (size and modification time).
-- Kept apart from fiscal_file, which is emptied when the reading choice changes.
CREATE TABLE fiscal_manual (
  folder_id INTEGER NOT NULL REFERENCES fiscal_folder(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  fields TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (folder_id, path)
) WITHOUT ROWID;
