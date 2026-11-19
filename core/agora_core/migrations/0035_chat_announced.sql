-- When Watson announced a pending WhatsApp conversation, so each one is announced once (and again only after
-- something new is received, which classifies it again). Only added: nullable, no data changes.
ALTER TABLE chat_summary ADD COLUMN announced_at TEXT;
