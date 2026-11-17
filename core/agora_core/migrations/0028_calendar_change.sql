-- Changes AgoraOne made to the user's own calendar events (user's decision, 14/11/2026: changing an event only
-- after confirmation, with a copy first): what the event was before and what it became, so a change can be undone
-- by hand. Never used to delete anything.
CREATE TABLE calendar_change (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 400),
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
