-- Index of notes (and later other items): fragments with full-text search that ignores accents, local
-- embeddings, and per-folder confidentiality rules.

ALTER TABLE item ADD COLUMN source_name TEXT;
ALTER TABLE item ADD COLUMN folder TEXT NOT NULL DEFAULT '';
ALTER TABLE item ADD COLUMN modified_at TEXT;
-- What the item itself declares (e.g. in a note's properties); the effective level also weighs folder rules.
ALTER TABLE item ADD COLUMN declared_confidentiality TEXT NOT NULL DEFAULT 'normal'
  CHECK (declared_confidentiality IN ('normal', 'local_only', 'private'));

CREATE TABLE chunk (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  embed_model TEXT,
  UNIQUE (item_id, ord)
);
CREATE INDEX chunk_pending ON chunk (id) WHERE embedding IS NULL;

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  text, content = 'chunk', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunk_ad AFTER DELETE ON chunk BEGIN
  INSERT INTO chunk_fts (chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER chunk_au AFTER UPDATE OF text ON chunk BEGIN
  INSERT INTO chunk_fts (chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunk_fts (rowid, text) VALUES (new.id, new.text);
END;

-- A folder (and everything under it) of a source, or of every source with '*', at a minimum level.
CREATE TABLE folder_rule (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  folder TEXT NOT NULL CHECK (length(folder) BETWEEN 1 AND 500),
  confidentiality TEXT NOT NULL CHECK (confidentiality IN ('local_only', 'private')),
  UNIQUE (source, folder)
);
