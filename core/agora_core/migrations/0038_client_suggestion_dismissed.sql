-- Proposals of «Crear cliente en Central» (senders of mail and WhatsApp, people and clients of meetings) the user
-- dismissed. Only the proposal's key (a hash of the address, number or name, or the conversation's id): no address,
-- number nor name is kept here. Times UTC.

CREATE TABLE client_suggestion_dismissed (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL
);
