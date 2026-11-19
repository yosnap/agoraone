-- Mail received through Resend (Inbound): it has no IMAP, so it is read with Resend's API and kept like any other
-- mail (folder «RESEND»). resend_message keeps which Resend email each stored message is, so none is read twice.
ALTER TABLE mail_account ADD COLUMN inbound INTEGER NOT NULL DEFAULT 0 CHECK (inbound IN (0, 1));
CREATE TABLE resend_message (
  account_id INTEGER NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
  resend_id TEXT NOT NULL CHECK (length(resend_id) BETWEEN 1 AND 100),
  uid INTEGER NOT NULL,
  PRIMARY KEY (account_id, resend_id),
  UNIQUE (account_id, uid)
);
