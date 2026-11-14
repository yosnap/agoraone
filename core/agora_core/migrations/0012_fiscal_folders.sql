-- Several fiscal folders, each with a name, a kind and the scope whose mail it receives; invoices and
-- receipts point at their folder. The single folder chosen before becomes the first one (self-employed).

CREATE TABLE fiscal_folder (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('autonomo', 'empresa', 'personal')),
  path TEXT NOT NULL UNIQUE,
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

INSERT INTO fiscal_folder (name, kind, path, created_at)
  SELECT 'Autónomo', 'autonomo', json_extract(value, '$'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM setting WHERE key = 'fiscal.folder';
DELETE FROM setting WHERE key = 'fiscal.folder';

-- The register again, with the folder: the same relative path may exist in two folders.
CREATE TABLE invoice_new (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER REFERENCES fiscal_folder(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'received' CHECK (direction IN ('received', 'issued')),
  -- For personal folders: gastos or compras; NULL for professional ones.
  category TEXT CHECK (category IS NULL OR category IN ('gastos', 'compras')),
  message_id INTEGER REFERENCES mail_message(id) ON DELETE SET NULL,
  receipt_id INTEGER,
  supplier TEXT NOT NULL CHECK (length(supplier) BETWEEN 1 AND 120),
  tax_id TEXT CHECK (tax_id IS NULL OR length(tax_id) BETWEEN 4 AND 20),
  issued_on TEXT NOT NULL CHECK (issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  base TEXT,
  vat TEXT,
  total TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  doubts TEXT NOT NULL DEFAULT '[]',
  quarter TEXT NOT NULL CHECK (quarter GLOB '[0-9][0-9][0-9][0-9]-[1-4]T'),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  UNIQUE (folder_id, path)
);
INSERT INTO invoice_new (id, folder_id, direction, message_id, supplier, tax_id, issued_on, base, vat, total, currency, notes, doubts, quarter, path, sha256, filed_at)
  SELECT id, (SELECT min(id) FROM fiscal_folder), direction, message_id, supplier, tax_id, issued_on, base, vat, total, currency, notes, doubts, quarter, path, sha256, filed_at FROM invoice;
DROP TABLE invoice;
ALTER TABLE invoice_new RENAME TO invoice;
CREATE INDEX invoice_quarter ON invoice (folder_id, quarter, direction);
CREATE INDEX invoice_message ON invoice (message_id);

-- Receipts uploaded from the phone, kept in AgoraOne's data until the user files them.
CREATE TABLE receipt (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL UNIQUE,
  original_name TEXT CHECK (original_name IS NULL OR length(original_name) <= 200),
  media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  fields TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'filed', 'dismissed')),
  uploaded_at TEXT NOT NULL,
  decided_at TEXT
);
