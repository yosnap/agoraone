-- The user's own clients, kept in AgoraOne so the mail, WhatsApp, meetings, Fiscal and Watson know them with or
-- without Central. The name is the identity (meetings keep it), unique regardless of case. `central_id` is the
-- Central client this one was linked to by the user (`link_state = 'linked'`) or said to be different from
-- (`link_state = 'distinct'`); nothing here is ever copied from Central nor deleted when Central goes away.

CREATE TABLE client (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
  company TEXT CHECK (company IS NULL OR length(company) <= 200),
  email TEXT CHECK (email IS NULL OR length(email) <= 320),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  tax_id TEXT CHECK (tax_id IS NULL OR length(tax_id) <= 30),
  -- JSON list of domains («acme.com»), checked by the core.
  domains TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(domains)),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  central_id TEXT CHECK (central_id IS NULL OR length(central_id) BETWEEN 1 AND 100),
  link_state TEXT CHECK (link_state IS NULL OR link_state IN ('linked', 'distinct')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((link_state IS NULL) = (central_id IS NULL))
);
