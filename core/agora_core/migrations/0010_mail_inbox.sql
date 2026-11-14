-- Rules the user writes for incoming mail, and what AgoraOne made of each message (kind, summary and
-- whether it is still waiting in the Bandeja). Times UTC.

CREATE TABLE mail_rule (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- An address (ana@cliente.com) or a domain (cliente.com, which also covers its subdomains).
  sender TEXT CHECK (sender IS NULL OR length(sender) BETWEEN 1 AND 254),
  account_id INTEGER REFERENCES mail_account(id) ON DELETE CASCADE,
  -- Case-insensitive text the subject contains.
  subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 200),
  -- Comma-separated words; any of them in the subject or the text.
  words TEXT CHECK (words IS NULL OR length(words) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK (action IN ('invoice', 'client', 'personal', 'important', 'ignore')),
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  -- Only ever makes the account's level stricter.
  confidentiality TEXT CHECK (confidentiality IS NULL OR confidentiality IN ('normal', 'local_only', 'private')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (sender IS NOT NULL OR account_id IS NOT NULL OR subject IS NOT NULL OR words IS NOT NULL)
);

CREATE TABLE mail_summary (
  message_id INTEGER PRIMARY KEY REFERENCES mail_message(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'payment', 'job', 'client', 'incident', 'appointment',
                                     'personal', 'important', 'advertising', 'other')),
  -- Who decided the kind: a rule, the model, or local keywords (no model).
  source TEXT NOT NULL CHECK (source IN ('rule', 'model', 'local')),
  rule_id INTEGER REFERENCES mail_rule(id) ON DELETE SET NULL,
  confidentiality TEXT NOT NULL CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  -- Written by the model; NULL when the message could not leave this Mac or was too old to summarise.
  summary TEXT,
  -- JSON {"asks": [...], "dates": [...], "amounts": [...], "language": "es"}.
  details TEXT NOT NULL DEFAULT '{}',
  -- pending: waiting in the Bandeja; done / dismissed: decided by the user; quiet: never shown
  -- (ignored by a rule, advertising, or older than what is summarised).
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'dismissed', 'quiet')),
  announced_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX mail_summary_state ON mail_summary (state, created_at);
