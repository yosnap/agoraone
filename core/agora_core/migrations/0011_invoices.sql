-- Invoices filed in the user's fiscal folder (the folder itself is a local setting, never in the code).
-- Amounts in the invoice's currency, as decimal text ("12.50"). Times UTC.

CREATE TABLE invoice (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL DEFAULT 'received' CHECK (direction IN ('received', 'issued')),
  message_id INTEGER REFERENCES mail_message(id) ON DELETE SET NULL,
  supplier TEXT NOT NULL CHECK (length(supplier) BETWEEN 1 AND 120),
  tax_id TEXT CHECK (tax_id IS NULL OR length(tax_id) BETWEEN 4 AND 20),
  issued_on TEXT NOT NULL CHECK (issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  base TEXT,
  vat TEXT,
  total TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  -- Free notes: reverse charge, no VAT shown, foreign currency, invoice as an image…
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  -- JSON list of what did not match when it was filed (missing tax id, amount differs from the payment…).
  doubts TEXT NOT NULL DEFAULT '[]',
  quarter TEXT NOT NULL CHECK (quarter GLOB '[0-9][0-9][0-9][0-9]-[1-4]T'),
  -- Relative to the fiscal folder.
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  filed_at TEXT NOT NULL
);
CREATE INDEX invoice_quarter ON invoice (quarter, direction);
CREATE INDEX invoice_message ON invoice (message_id);
