-- How an account signs in: an app password (most providers) or Microsoft's OAuth, which no longer accepts
-- app passwords for IMAP. The Keychain then keeps the refresh token instead of a password.
ALTER TABLE mail_account ADD COLUMN auth TEXT NOT NULL DEFAULT 'password' CHECK (auth IN ('password', 'microsoft'));
