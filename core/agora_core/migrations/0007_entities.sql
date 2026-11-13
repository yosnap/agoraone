-- Entities found in the notes (people, organisations, projects, amounts, dates and #tags), the notes that
-- mention them, and which revision of each note was already read and how (a model for `normal` notes,
-- local rules for the others). The same entity is one row: kind plus a normalised name.

CREATE TABLE entity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'org', 'project', 'amount', 'date', 'tag')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  norm TEXT NOT NULL CHECK (length(norm) BETWEEN 1 AND 80),
  UNIQUE (kind, norm)
);

CREATE TABLE item_entity (
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, entity_id)
) WITHOUT ROWID;
CREATE INDEX item_entity_entity ON item_entity (entity_id);

CREATE TABLE item_extraction (
  item_id INTEGER PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  revision TEXT,
  method TEXT NOT NULL CHECK (method IN ('model', 'rules')),
  extracted_at TEXT NOT NULL
);

-- Notes indexed before this migration have no entities yet: the backend sends them again.
UPDATE item SET revision = NULL WHERE class = 'note';
