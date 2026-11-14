-- The assistant's conversations, kept in the brain, and simple key/value settings.

CREATE TABLE conversation (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL CHECK (length(owner) = 64),
  title TEXT NOT NULL DEFAULT 'Conversación nueva',
  persona TEXT NOT NULL,
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversation_owner ON conversation (owner, updated_at);

CREATE TABLE message (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  engine TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX message_conversation ON message (conversation_id, id);

CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
