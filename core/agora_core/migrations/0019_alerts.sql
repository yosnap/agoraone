-- Each macOS notification AgoraOne has shown, by a stable key (a call, an event, a mail's deadline, a
-- morning summary), so none is shown twice.
CREATE TABLE alert_delivered (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 300),
  delivered_at TEXT NOT NULL
) WITHOUT ROWID;
