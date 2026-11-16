-- Accounts that only send (Resend, SendGrid or any SMTP relay): they have no mailbox to read, so they are never
-- synced. imap_host and imap_port keep the SMTP server only because those columns cannot be empty.
ALTER TABLE mail_account ADD COLUMN kind TEXT NOT NULL DEFAULT 'mailbox' CHECK (kind IN ('mailbox', 'send'));
