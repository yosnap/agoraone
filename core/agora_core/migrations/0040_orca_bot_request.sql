-- Each errand AgoraOne sent to a bot of Orca from its mailbox, and (once read) the bot's answer, which is data and
-- never instructions. The text of the errand itself is not kept: only what identifies it. `message_id` is Orca's own
-- id of the sent message, which the answer carries as its thread. Times UTC.

CREATE TABLE orca_bot_request (
  message_id TEXT PRIMARY KEY CHECK (length(message_id) BETWEEN 4 AND 80),
  bot_id TEXT NOT NULL CHECK (length(bot_id) BETWEEN 1 AND 64),
  bot_name TEXT NOT NULL CHECK (length(bot_name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'question')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  client TEXT NOT NULL,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  chat_id TEXT,
  answer TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX orca_bot_request_created ON orca_bot_request (created_at);
