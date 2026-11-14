-- A question whose answer failed is kept (so the user does not lose it), marked as unanswered.
ALTER TABLE message ADD COLUMN failed INTEGER NOT NULL DEFAULT 0 CHECK (failed IN (0, 1));
