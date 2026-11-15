-- What a recorded meeting becomes: its transcript in two voices (you / the others), and a summary with
-- decisions and tasks made by Claude (normal meetings) or a local model (the rest), and the vault note
-- the user saved from it. Work runs in the background; its state is kept so the screen can follow it.
ALTER TABLE meeting ADD COLUMN work TEXT NOT NULL DEFAULT 'none' CHECK (work IN ('none', 'transcribing', 'summarizing', 'done', 'failed'));
ALTER TABLE meeting ADD COLUMN work_error TEXT;
ALTER TABLE meeting ADD COLUMN transcript TEXT;
ALTER TABLE meeting ADD COLUMN summary TEXT;
ALTER TABLE meeting ADD COLUMN summary_by TEXT CHECK (summary_by IS NULL OR summary_by IN ('claude', 'local', 'none'));
ALTER TABLE meeting ADD COLUMN saved_note TEXT;
