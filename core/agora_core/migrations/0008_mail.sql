-- Mail accounts the user connects (read-only IMAP), how far each folder was read, and the messages kept
-- for summaries and rules. Passwords live in the Keychain ("mail:<account id>"), never here. Times UTC.

CREATE TABLE mail_account (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE CHECK (length(address) BETWEEN 3 AND 254 AND address LIKE '%_@_%'),
  label TEXT CHECK (label IS NULL OR length(label) <= 80),
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'icloud', 'namecheap', 'hostinger', 'other')),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 254),
  imap_host TEXT NOT NULL CHECK (length(imap_host) BETWEEN 1 AND 253),
  imap_port INTEGER NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
  smtp_host TEXT CHECK (smtp_host IS NULL OR length(smtp_host) BETWEEN 1 AND 253),
  smtp_port INTEGER CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  -- How many days back the first read goes; later reads take only what is new.
  max_age_days INTEGER NOT NULL DEFAULT 60 CHECK (max_age_days BETWEEN 1 AND 3650),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'auth', 'unreachable', 'error')),
  last_error TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE mail_folder_state (
  account_id INTEGER NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  last_uid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder)
) WITHOUT ROWID;

CREATE TABLE mail_message (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  sent_at TEXT,
  -- Plain text (HTML turned into text), trimmed; NULL when the message was too large to read.
  body TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  -- JSON list of {"name", "type", "bytes", "part"}; the files themselves are fetched only when needed.
  attachments TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER,
  received_at TEXT NOT NULL,
  UNIQUE (account_id, folder, uidvalidity, uid)
);
CREATE INDEX mail_message_account_sent ON mail_message (account_id, sent_at);
CREATE INDEX mail_message_from ON mail_message (from_address);
