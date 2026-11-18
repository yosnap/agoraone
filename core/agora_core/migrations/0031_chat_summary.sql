-- Rules the user writes for WhatsApp conversations, and what AgoraOne made of each conversation (kind, summary
-- and whether it is waiting in the Bandeja). Like the mail ones: the first enabled rule, oldest first, decides,
-- and a rule only ever makes the account's level stricter. Times UTC.

CREATE TABLE chat_rule (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- A phone number (compared by its digits) or a participant id from Zernio.
  contact TEXT CHECK (contact IS NULL OR length(contact) BETWEEN 1 AND 100),
  account_id INTEGER REFERENCES chat_account(id) ON DELETE CASCADE,
  -- Comma-separated words; any of them in the incoming messages.
  words TEXT CHECK (words IS NULL OR length(words) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK (action IN ('invoice', 'client', 'personal', 'important', 'ignore')),
  -- Short text shown as the conversation's source (for example the name of a service that writes from a number).
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40),
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  confidentiality TEXT CHECK (confidentiality IS NULL OR confidentiality IN ('normal', 'local_only', 'private')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (contact IS NOT NULL OR account_id IS NOT NULL OR words IS NOT NULL)
);

CREATE TABLE chat_summary (
  conversation_id INTEGER PRIMARY KEY REFERENCES chat_conversation(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'payment', 'job', 'client', 'incident', 'appointment',
                                     'personal', 'important', 'advertising', 'other')),
  -- Who decided the kind: a rule, the model, or local keywords (no model).
  source TEXT NOT NULL CHECK (source IN ('rule', 'model', 'local')),
  rule_id INTEGER REFERENCES chat_rule(id) ON DELETE SET NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 40),
  confidentiality TEXT NOT NULL CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  -- Written by the model; NULL when the conversation may not leave this Mac.
  summary TEXT,
  -- JSON {"asks": [...], "dates": [...], "amounts": [...], "language": "es"}.
  details TEXT NOT NULL DEFAULT '{}',
  -- pending: waiting in the Bandeja; done / dismissed: decided by the user; quiet: never shown (ignored by a
  -- rule, advertising, or nothing received in the last days when it was first classified).
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'dismissed', 'quiet')),
  -- The newest message the classification covered: an incoming message newer than it opens the conversation again.
  until_message_id INTEGER,
  decided_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX chat_summary_state ON chat_summary (state, updated_at);
