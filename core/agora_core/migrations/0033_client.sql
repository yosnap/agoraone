-- The user's own clients, kept in AgoraOne so the mail, WhatsApp, meetings, Fiscal and Watson know them with or
-- without Central. The name is the identity (meetings keep it), unique regardless of case. `central_id` is the
-- Central client the user linked this one to («Enlazar»); `client_distinct` keeps every Central client the user
-- said is a different one («Son distintos»), so it is never linked nor suggested again until undone. Nothing here
-- is copied from Central nor deleted when Central goes away; a deleted client is copied first to `client_backup`.

CREATE TABLE client (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
  company TEXT CHECK (company IS NULL OR length(company) <= 200),
  email TEXT CHECK (email IS NULL OR length(email) <= 320),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  tax_id TEXT CHECK (tax_id IS NULL OR length(tax_id) <= 30),
  -- JSON list of domains («acme.com») the user wrote, checked by the core; never taken from the address.
  domains TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(domains)),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  central_id TEXT CHECK (central_id IS NULL OR length(central_id) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE client_distinct (
  client_id INTEGER NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  central_id TEXT NOT NULL CHECK (length(central_id) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, central_id)
);

-- The whole client (notes and «Son distintos» included) as it was just before the user deleted it. Times UTC.
CREATE TABLE client_backup (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL
);
