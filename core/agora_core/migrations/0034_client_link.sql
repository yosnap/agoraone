-- Links of the user's clients with the clients of other connectors (CRMDev today, any later one with clients), only
-- added: `client.central_id` and `client_distinct` stay as they are for Central, so nothing is migrated.
--
-- `client_link`: a client kept here and a client of a connector the user linked («Enlazar», or the one just created
-- from it with «Crear en CRMDev») or said are different («Son distintos»). At most one `linked` per connector for a
-- client, and a remote client is linked with one client kept here at most. Deleting the client takes its links.
--
-- `remote_link`: the same between two connectors' clients without a client kept here (Central and CRMDev), stored
-- once per pair with the connectors in alphabetical order. Nothing here is copied from a connector nor deleted when
-- it goes away: its clients just stop showing. Times UTC.

CREATE TABLE client_link (
  client_id INTEGER NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  connector TEXT NOT NULL CHECK (connector GLOB '[a-z]*' AND length(connector) BETWEEN 1 AND 40),
  remote_id TEXT NOT NULL CHECK (length(remote_id) BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK (state IN ('linked', 'distinct')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, connector, remote_id)
);
CREATE UNIQUE INDEX client_link_one_per_connector ON client_link (client_id, connector) WHERE state = 'linked';
CREATE UNIQUE INDEX client_link_one_per_remote ON client_link (connector, remote_id) WHERE state = 'linked';

CREATE TABLE remote_link (
  connector_a TEXT NOT NULL CHECK (connector_a GLOB '[a-z]*' AND length(connector_a) BETWEEN 1 AND 40),
  id_a TEXT NOT NULL CHECK (length(id_a) BETWEEN 1 AND 100),
  connector_b TEXT NOT NULL CHECK (connector_b GLOB '[a-z]*' AND length(connector_b) BETWEEN 1 AND 40),
  id_b TEXT NOT NULL CHECK (length(id_b) BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK (state IN ('linked', 'distinct')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_a, id_a, connector_b, id_b),
  CHECK (connector_a < connector_b)
);
CREATE UNIQUE INDEX remote_link_one_a ON remote_link (connector_a, id_a, connector_b) WHERE state = 'linked';
CREATE UNIQUE INDEX remote_link_one_b ON remote_link (connector_b, id_b, connector_a) WHERE state = 'linked';
