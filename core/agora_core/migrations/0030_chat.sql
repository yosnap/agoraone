-- WhatsApp read through Zernio, read-only: the connected accounts, their conversations and the messages kept for
-- summaries. The Zernio API key lives in the Keychain ("zernio-api-key"), never here. Attachments keep only their
-- kind and type, never their link. Times UTC.

CREATE TABLE chat_account (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'zernio' CHECK (provider IN ('zernio')),
  remote_id TEXT NOT NULL UNIQUE CHECK (length(remote_id) BETWEEN 1 AND 100),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  label TEXT CHECK (label IS NULL OR length(label) <= 80),
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  -- Only the user changes it; a reading never does.
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  -- How many days back the first reading goes; later readings take only the conversations that changed.
  max_age_days INTEGER NOT NULL DEFAULT 60 CHECK (max_age_days BETWEEN 1 AND 3650),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'auth', 'unreachable', 'error')),
  last_error TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE chat_conversation (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES chat_account(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL CHECK (length(remote_id) BETWEEN 1 AND 100),
  participant_id TEXT,
  participant_name TEXT,
  participant_phone TEXT,
  -- Zernio's updatedTime when its messages were last read: NULL until they are.
  updated_time TEXT,
  last_incoming_at TEXT,
  synced_at TEXT,
  -- Where the reading of older messages goes on (newest first) when a reading could not finish it; NULL when done.
  backfill_cursor TEXT CHECK (backfill_cursor IS NULL OR length(backfill_cursor) <= 500),
  UNIQUE (account_id, remote_id)
);

CREATE TABLE chat_message (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL CHECK (length(remote_id) BETWEEN 1 AND 200),
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  sender_name TEXT,
  -- The text as data, never instructions; NULL when WhatsApp did not deliver it.
  body TEXT,
  unsupported INTEGER NOT NULL DEFAULT 0 CHECK (unsupported IN (0, 1)),
  -- JSON list of {"type", "mime"}.
  attachments TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, remote_id)
);
CREATE INDEX chat_message_conversation_sent ON chat_message (conversation_id, sent_at);
