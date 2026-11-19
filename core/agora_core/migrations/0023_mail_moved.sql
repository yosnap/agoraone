-- Mail moved out of the inbox by the user's confirmed request to Watson (decision of 15/11/2026): to the account's
-- archive or to its trash, never deleted for good. Kept so the same message is not offered again.
ALTER TABLE mail_message ADD COLUMN moved TEXT CHECK (moved IS NULL OR moved IN ('archive', 'trash'));
ALTER TABLE mail_message ADD COLUMN moved_at TEXT;
