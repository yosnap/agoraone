-- What kind of meeting it was (a meeting, a training, an interview, a call), the client it was about and the
-- people in it, so the note says so and Watson can find it later by any of them.
ALTER TABLE meeting ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting', 'training', 'interview', 'call', 'other'));
ALTER TABLE meeting ADD COLUMN client TEXT;
ALTER TABLE meeting ADD COLUMN people TEXT NOT NULL DEFAULT '[]';
