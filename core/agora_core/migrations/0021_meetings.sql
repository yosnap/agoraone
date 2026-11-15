-- Recorded meetings: your microphone and what the computer played, in two tracks kept in AgoraOne's data
-- (never in the vault) until the user deletes them. Only recorded with a button and a visible indicator.
CREATE TABLE meeting (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  status TEXT NOT NULL CHECK (status IN ('recording', 'recorded', 'interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mic_type TEXT NOT NULL CHECK (mic_type IN ('webm', 'mp4', 'ogg')),
  mic_bytes INTEGER NOT NULL DEFAULT 0,
  system_source TEXT CHECK (system_source IS NULL OR system_source IN ('macos', 'linux-pulse')),
  system_file TEXT CHECK (system_file IS NULL OR system_file IN ('sistema.m4a', 'sistema.mka')),
  system_bytes INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX meeting_owner ON meeting (owner, started_at DESC);
