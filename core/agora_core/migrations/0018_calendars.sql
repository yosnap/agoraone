-- Each macOS calendar or reminders list: its scope and confidentiality (what Watson may see). Calendars
-- themselves live in macOS (EventKit); only these choices are kept here, by calendar identifier.
CREATE TABLE calendar_setting (
  calendar_id TEXT PRIMARY KEY CHECK (length(calendar_id) BETWEEN 1 AND 200),
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
) WITHOUT ROWID;
