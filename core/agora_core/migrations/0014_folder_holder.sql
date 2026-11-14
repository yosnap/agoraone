-- Who the quarterly register is for (its second row), per fiscal folder.
ALTER TABLE fiscal_folder ADD COLUMN holder TEXT CHECK (holder IS NULL OR length(holder) <= 120);
