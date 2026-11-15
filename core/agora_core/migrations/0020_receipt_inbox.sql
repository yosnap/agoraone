-- Receipts also arrive through a folder: «Recibos por revisar» inside a fiscal folder, where the user's own
-- Hermes bot saves the invoices sent to it. Each keeps where it came from, to move it out once filed.
ALTER TABLE receipt ADD COLUMN source TEXT NOT NULL DEFAULT 'qr' CHECK (source IN ('qr', 'inbox'));
ALTER TABLE receipt ADD COLUMN inbox_folder INTEGER REFERENCES fiscal_folder(id) ON DELETE SET NULL;
ALTER TABLE receipt ADD COLUMN inbox_name TEXT CHECK (inbox_name IS NULL OR length(inbox_name) <= 255);
