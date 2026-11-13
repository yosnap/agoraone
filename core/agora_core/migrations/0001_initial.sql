-- Base model of AgoraOne's brain. Two independent axes classify everything: scope (under which entity:
-- personal, each brand, the association) and kind (what sort of thing it is). Times are UTC ISO 8601.

CREATE TABLE scope (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) <= 40),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  color TEXT CHECK (color IS NULL OR color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  -- Whether its income and expenses belong to the user's self-employed tax records.
  fiscal INTEGER NOT NULL DEFAULT 0 CHECK (fiscal IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE kind (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE project (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT,
  scope_id INTEGER REFERENCES scope(id) ON DELETE RESTRICT,
  kind_id INTEGER REFERENCES kind(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Something that happens on a date: a class, a talk, an edition of an event.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
  scope_id INTEGER REFERENCES scope(id) ON DELETE RESTRICT,
  kind_id INTEGER REFERENCES kind(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  place TEXT,
  audience TEXT,
  notes TEXT,
  fee_cents INTEGER CHECK (fee_cents IS NULL OR fee_cents >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Anything the brain knows about: a note, and later a meeting, an email or a file. Source and ref identify
-- it where it lives (never a path sent by a client); revision tells whether it changed since indexing.
CREATE TABLE item (
  id INTEGER PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('note', 'meeting', 'email', 'file', 'invoice', 'event', 'link', 'memory')),
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT,
  revision TEXT,
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  kind_id INTEGER REFERENCES kind(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
  activity_id INTEGER REFERENCES activity(id) ON DELETE SET NULL,
  -- normal: may be shown and sent to external models; local_only: never leaves this Mac;
  -- private: neither shown in discreet mode nor sent through Telegram or MCP.
  confidentiality TEXT NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal', 'local_only', 'private')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, ref)
);

-- Timeline: when something appeared or happened, tying items, activities and projects to a moment.
CREATE TABLE event (
  id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  class TEXT NOT NULL,
  summary TEXT,
  item_id INTEGER REFERENCES item(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activity(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- What the assistant or an agent did and why, so it can be reviewed and, when possible, undone.
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'denied', 'failed', 'undone')),
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  undo TEXT CHECK (undo IS NULL OR json_valid(undo))
);

-- Agents: AgoraOne's own (defined here, run with the engine layer) and Hermes profiles.
CREATE TABLE agent (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  class TEXT NOT NULL CHECK (class IN ('own', 'hermes')),
  brief TEXT,
  tools TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools)),
  engine TEXT,
  scope_id INTEGER REFERENCES scope(id) ON DELETE SET NULL,
  hermes_profile TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (class = 'own' OR hermes_profile IS NOT NULL)
);

CREATE INDEX event_occurred ON event (occurred_at);
CREATE INDEX item_scope ON item (scope_id);
CREATE INDEX item_project ON item (project_id);
CREATE INDEX activity_starts ON activity (starts_at);

INSERT INTO scope (slug, name, created_at) VALUES ('personal', 'Personal', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
INSERT INTO kind (slug, name) VALUES
  ('client-work', 'Trabajo para cliente'),
  ('venture', 'Emprendimiento propio'),
  ('organized-event', 'Evento organizado'),
  ('teaching', 'Formación impartida'),
  ('talk', 'Ponencia'),
  ('learning', 'Aprendizaje');
