-- A copy of each Assistant conversation the user deletes, with its messages, taken in the same transaction
-- as the delete. Its id also keeps a deleted conversation's number from being given to a new one.
CREATE TABLE conversation_backup (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  owner TEXT NOT NULL CHECK (length(owner) = 64),
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL
);
CREATE INDEX conversation_backup_conversation ON conversation_backup (conversation_id);
