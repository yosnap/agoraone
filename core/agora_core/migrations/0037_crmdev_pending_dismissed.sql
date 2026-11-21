-- Warnings of «Pendiente en CRMDev» the user dismissed. A warning comes back when what it says changes: `signature`
-- is a hash of the values it was shown with, so a new difference has another one. Only keys and hashes: no name,
-- address nor value of a client is kept here. Times UTC.

CREATE TABLE crmdev_pending_dismissed (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  signature TEXT NOT NULL CHECK (length(signature) = 64),
  created_at TEXT NOT NULL
);
