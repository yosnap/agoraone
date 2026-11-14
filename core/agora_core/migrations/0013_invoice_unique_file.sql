-- The same file is filed only once, even with two requests at the same time.
CREATE UNIQUE INDEX invoice_sha256 ON invoice (sha256);
